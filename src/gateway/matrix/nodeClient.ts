import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
    CollectStrategy,
    DeviceId,
    DeviceLists,
    EncryptionAlgorithm,
    EncryptionSettings,
    HistoryVisibility,
    OlmMachine,
    RequestType,
    RoomId,
    StoreType,
    UserId,
    type KeysClaimRequest,
    type OlmMachine as OlmMachineType,
    type ToDeviceRequest,
} from '@matrix-org/matrix-sdk-crypto-nodejs'
import { createClient, type MatrixClient } from 'matrix-js-sdk'
import type { Logger } from 'matrix-js-sdk/lib/logger.js'
import {
    CODEVER_MATRIX_APPLICATION_CONTROL_EVENT_TYPE,
    CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE,
    CODEVER_MATRIX_SESSION_DIRECTORY_EVENT_TYPE,
    CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE,
    CVP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE,
    CVP3_MATRIX_PROJECT_POINTER_EVENT_TYPE,
    CVP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE,
    cvp3CurrentPointerSchema,
    cvp3ProjectKeyGrantStateSchema,
    cvp3TimelineContentSchema,
    canonicalJson,
} from '@codever/protocol'
import { toArrayBuffer } from '@codever/security'
import type {
    MatrixApplicationControlEventRequest,
    MatrixApplicationStateEventRequest,
    MatrixApplicationTimelineEventRequest,
    MatrixDownloadMediaRequest,
    MatrixIncomingEvent,
    MatrixRoomMessageContent,
    MatrixSendEventRequest,
    MatrixSendEventResult,
    MatrixUploadMediaRequest,
    MatrixUploadMediaResult,
} from '@/channel/matrix'
import { downloadMatrixMedia } from '@/channel/matrix/sdkTransport'
import type {
    MatrixGatewayConnectionConfig,
    MatrixGatewayCryptoConfig,
    MatrixGatewayPinnedTransportDevice,
} from './config'
import type {
    MatrixGatewayClient,
    MatrixGatewayEventListener,
    MatrixSyncWatchdogOptions,
} from './client'

interface MatrixSyncResponse {
    next_batch?: unknown
    to_device?: { events?: unknown[] }
    device_lists?: { changed?: unknown[]; left?: unknown[] }
    device_one_time_keys_count?: Record<string, number>
    device_unused_fallback_key_types?: unknown[]
    'org.matrix.msc2732.device_unused_fallback_key_types'?: unknown[]
    rooms?: {
        join?: Record<string, {
            state?: { events?: MatrixRawEvent[] }
            timeline?: { events?: MatrixRawEvent[] }
        }>
    }
}

interface MatrixRawEvent {
    event_id?: unknown
    type?: unknown
    sender?: unknown
    origin_server_ts?: unknown
    state_key?: unknown
    content?: unknown
}

interface MatrixRoomCryptoState {
    algorithm: 'm.megolm.v1.aes-sha2'
    rotationPeriodMs?: number
    rotationPeriodMessages?: number
    historyVisibility: HistoryVisibility
    joinedUserIds: string[]
}

interface MatrixRequestOptions {
    query?: Record<string, string | number | boolean | undefined>
    body?: unknown
    signal?: AbortSignal
    timeoutMs?: number
    retryRateLimit?: boolean
}

class MatrixHttpError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly errcode?: string,
        readonly retryAfterMs?: number,
    ) {
        super(message)
    }
}

/**
 * Node-only Matrix transport backed by matrix-sdk-crypto's durable SQLite
 * store. matrix-js-sdk deliberately has no persistent crypto backend in Node;
 * reusing a Matrix device ID with its in-memory store changes the Olm identity
 * on every restart and makes subsequent clients unable to decrypt or pair.
 */
export class MatrixNodeSdkGatewayClient implements MatrixGatewayClient {
    private readonly sdkClient: MatrixClient
    private readonly listeners = new Set<MatrixGatewayEventListener>()
    private readonly roomCrypto = new Map<string, MatrixRoomCryptoState>()
    private machine: OlmMachineType | null = null
    private cryptoConfig: Extract<MatrixGatewayCryptoConfig, { backend: 'node-sqlite' }> | null = null
    private started = false
    private ready = false
    private readyError: Error | null = null
    private readyWaiters = new Set<{ resolve(): void; reject(error: Error): void }>()
    private syncAbort: AbortController | null = null
    private syncLoopPromise: Promise<void> | null = null
    private syncRestartPromise: Promise<void> | null = null
    private syncToken: string | null = null
    private lastSyncProgressAt = 0
    private cryptoChain: Promise<void> = Promise.resolve()
    private roomSendChain: Promise<void> = Promise.resolve()

    constructor(
        private readonly connection: MatrixGatewayConnectionConfig,
        private readonly defaultReadyTimeoutMs = 30_000,
        private readonly onLog?: (message: string) => void,
        private readonly fetchImpl: typeof fetch = fetch,
    ) {
        this.sdkClient = createClient({
            baseUrl: connection.baseUrl,
            accessToken: connection.accessToken,
            userId: connection.userId,
            deviceId: connection.deviceId,
            logger: quietLogger(onLog),
        })
    }

    async initializeCrypto(config: MatrixGatewayCryptoConfig): Promise<void> {
        if (this.machine) return
        if (config.backend !== 'node-sqlite') {
            throw new Error('The Node Matrix transport requires the node-sqlite crypto backend')
        }
        await mkdir(config.storagePath, { recursive: true, mode: 0o700 })
        await chmod(config.storagePath, 0o700)
        this.cryptoConfig = config
        this.syncToken = await readSyncToken(config.syncTokenPath)
        this.machine = await OlmMachine.initialize(
            new UserId(this.connection.userId),
            new DeviceId(this.connection.deviceId),
            config.storagePath,
            config.storagePassword ?? null,
            StoreType.Sqlite,
        )
        await this.withCryptoLock(async () => this.processOutgoingRequests())
    }

    onRoomEvent(listener: MatrixGatewayEventListener): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    async start(): Promise<void> {
        if (this.started) return
        if (!this.machine || !this.cryptoConfig) {
            throw new Error('Matrix crypto must be initialized before sync starts')
        }
        this.started = true
        this.ready = false
        this.readyError = null
        this.lastSyncProgressAt = Date.now()
        this.syncAbort = new AbortController()
        this.syncLoopPromise = this.runSyncLoop(this.syncAbort.signal)
    }

    async restartSync(): Promise<void> {
        if (this.syncRestartPromise) return this.syncRestartPromise
        const restart = this.restartSyncLoop()
        this.syncRestartPromise = restart
        try {
            await restart
        } finally {
            if (this.syncRestartPromise === restart) this.syncRestartPromise = null
        }
    }

    async waitUntilReady(timeoutMs = this.defaultReadyTimeoutMs): Promise<void> {
        if (!this.started) throw new Error('Matrix client has not started')
        if (this.ready) return
        if (this.readyError) throw this.readyError
        await new Promise<void>((resolve, reject) => {
            let timeout: ReturnType<typeof setTimeout> | undefined
            const waiter = {
                resolve: () => {
                    if (timeout) clearTimeout(timeout)
                    this.readyWaiters.delete(waiter)
                    resolve()
                },
                reject: (error: Error) => {
                    if (timeout) clearTimeout(timeout)
                    this.readyWaiters.delete(waiter)
                    reject(error)
                },
            }
            timeout = setTimeout(() => waiter.reject(new Error(
                `Matrix initial sync timed out after ${timeoutMs}ms`,
            )), timeoutMs)
            this.readyWaiters.add(waiter)
            if (this.ready) waiter.resolve()
            else if (this.readyError) waiter.reject(this.readyError)
        })
    }

    async assertRoomEncrypted(roomId: string): Promise<void> {
        const state = await this.ensureRoomCryptoState(roomId)
        if (state.algorithm !== 'm.megolm.v1.aes-sha2') {
            throw new Error(`Matrix room ${roomId} is not encrypted with Megolm`)
        }
    }

    async pinTrustedDevices(devices: MatrixGatewayPinnedTransportDevice[]): Promise<void> {
        if (devices.length === 0) return
        const deviceKeys: Record<string, string[]> = {}
        for (const device of devices) deviceKeys[device.matrixUserId] = []
        const response = await this.matrixRequest<Record<string, unknown>>(
            'POST',
            '/_matrix/client/v3/keys/query',
            { body: { device_keys: deviceKeys }, retryRateLimit: true },
        )
        const users = asRecord(response.device_keys)
        for (const trusted of devices) {
            const userDevices = asRecord(users?.[trusted.matrixUserId])
            const device = asRecord(userDevices?.[trusted.matrixDeviceId])
            const keys = asRecord(device?.keys)
            const fingerprint = keys?.[`ed25519:${trusted.matrixDeviceId}`]
            if (
                typeof fingerprint !== 'string'
                || !trusted.matrixDeviceKeys.includes(fingerprint)
            ) {
                throw new Error(
                    `Trusted Matrix device ${trusted.matrixUserId}/${trusted.matrixDeviceId} `
                    + 'fingerprint does not match',
                )
            }
        }
        await this.withCryptoLock(async machine => {
            await machine.updateTrackedUsers(
                [...new Set(devices.map(device => device.matrixUserId))]
                    .map(userId => new UserId(userId)),
            )
            await this.processOutgoingRequests()
        })
    }

    async sendEncryptedRoomEvent(request: MatrixSendEventRequest): Promise<MatrixSendEventResult> {
        const room = await this.ensureRoomCryptoState(request.roomId, true)
        return this.withCryptoLock(async machine => {
            const users = room.joinedUserIds.map(userId => new UserId(userId))
            await machine.updateTrackedUsers(users)
            await this.processOutgoingRequests()
            const missing = await machine.getMissingSessions(users)
            if (missing) await this.processKeysClaim(missing)

            const settings = encryptionSettings(room)
            const shares = await machine.shareRoomKey(new RoomId(request.roomId), users, settings)
            for (const share of shares) await this.processToDeviceRequest(share)
            const encrypted = JSON.parse(await machine.encryptRoomEvent(
                new RoomId(request.roomId),
                request.eventType,
                JSON.stringify(request.content),
            )) as Record<string, unknown>
            await this.processOutgoingRequests()
            const result = await this.sendDirectRoomEvent({
                roomId: request.roomId,
                eventType: 'm.room.encrypted',
                transactionId: request.transactionId,
                content: encrypted,
            })
            return result
        })
    }

    async sendApplicationTimelineEvent(
        request: MatrixApplicationTimelineEventRequest,
    ): Promise<MatrixSendEventResult> {
        assertSecureApplicationTimelineContent(request.content)
        return this.sendDirectRoomEvent(request)
    }

    async sendApplicationControlEvent(
        request: MatrixApplicationControlEventRequest,
    ): Promise<MatrixSendEventResult> {
        assertSecureApplicationControlContent(request.content)
        return this.sendDirectRoomEvent(request)
    }

    async setApplicationRoomState(
        request: MatrixApplicationStateEventRequest,
    ): Promise<MatrixSendEventResult> {
        assertSecureApplicationStateContent(request)
        return this.withRoomSendLock(async () => {
            const response = await this.matrixRequest<{ event_id: string }>(
                'PUT',
                matrixStatePath(request.roomId, request.eventType, request.stateKey),
                { body: request.content, retryRateLimit: true },
            )
            return { eventId: requireEventId(response) }
        })
    }

    async prepareRoomThread(roomId: string, rootEventId: string): Promise<void> {
        const event = await this.matrixRequest<Record<string, unknown>>(
            'GET',
            `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(rootEventId)}`,
        )
        if (event.event_id !== rootEventId) {
            throw new Error(`Matrix returned the wrong thread root for ${rootEventId}`)
        }
    }

    async setExtendedProfileProperty(key: string, value: unknown): Promise<void> {
        await this.sdkClient.setExtendedProfileProperty(key, value)
    }

    async setTyping(roomId: string, typing: boolean, timeoutMs = 30_000): Promise<void> {
        await this.matrixRequest(
            'PUT',
            `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(this.connection.userId)}`,
            { body: { typing, ...(typing ? { timeout: timeoutMs } : {}) } },
        )
    }

    async uploadEncryptedMedia(request: MatrixUploadMediaRequest): Promise<MatrixUploadMediaResult> {
        const response = await this.sdkClient.uploadContent(
            new Blob([toArrayBuffer(request.ciphertext)], { type: 'application/octet-stream' }),
            { type: 'application/octet-stream', includeFilename: false },
        )
        return { url: response.content_uri }
    }

    async downloadEncryptedMedia(request: MatrixDownloadMediaRequest): Promise<Uint8Array> {
        return downloadMatrixMedia(this.sdkClient, request)
    }

    getOwnDeviceKeys(): { ed25519: string; curve25519: string } {
        const keys = this.requireMachine().identityKeys
        return {
            ed25519: keys.ed25519.toBase64(),
            curve25519: keys.curve25519.toBase64(),
        }
    }

    watchSyncHealth(
        options: MatrixSyncWatchdogOptions,
        onStalled: (error: Error) => void,
    ): () => void {
        requirePositiveDuration(options.stallTimeoutMs, 'stallTimeoutMs')
        const checkIntervalMs = options.checkIntervalMs
            ?? Math.min(30_000, Math.max(1_000, Math.floor(options.stallTimeoutMs / 4)))
        requirePositiveDuration(checkIntervalMs, 'checkIntervalMs')
        const now = options.now ?? Date.now
        const timer = setInterval(() => {
            const elapsedMs = Math.max(0, now() - this.lastSyncProgressAt)
            if (!this.started || elapsedMs < options.stallTimeoutMs) return
            clearInterval(timer)
            onStalled(new Error(`Matrix sync made no progress for ${elapsedMs}ms`))
        }, checkIntervalMs)
        return () => clearInterval(timer)
    }

    async stop(): Promise<void> {
        if (!this.started && !this.machine) return
        this.started = false
        this.syncAbort?.abort()
        await this.syncRestartPromise?.catch(() => {})
        this.syncAbort?.abort()
        await this.syncLoopPromise?.catch(() => {})
        this.syncLoopPromise = null
        this.syncAbort = null
        this.rejectReady(new Error('Matrix client stopped before becoming ready'))
        this.machine?.close()
        this.machine = null
    }

    private async restartSyncLoop(): Promise<void> {
        if (!this.started || !this.machine || !this.cryptoConfig) {
            throw new Error('Matrix sync cannot restart before the client is started')
        }
        const previousAbort = this.syncAbort
        const previousLoop = this.syncLoopPromise
        previousAbort?.abort()
        await previousLoop?.catch(() => {})
        if (!this.started) return
        this.lastSyncProgressAt = Date.now()
        const nextAbort = new AbortController()
        this.syncAbort = nextAbort
        this.syncLoopPromise = this.runSyncLoop(nextAbort.signal)
    }

    private async runSyncLoop(signal: AbortSignal): Promise<void> {
        let backoffMs = 500
        while (this.started && !signal.aborted) {
            try {
                const sync = await this.matrixRequest<MatrixSyncResponse>(
                    'GET',
                    '/_matrix/client/v3/sync',
                    {
                        query: {
                            timeout: 30_000,
                            ...(this.syncToken ? { since: this.syncToken } : {}),
                        },
                        signal,
                        timeoutMs: 40_000,
                    },
                )
                await this.processSync(sync)
                const nextBatch = typeof sync.next_batch === 'string' ? sync.next_batch : null
                if (!nextBatch) throw new Error('Matrix sync response did not contain next_batch')
                await writeSyncToken(this.requireCryptoConfig().syncTokenPath, nextBatch)
                this.syncToken = nextBatch
                this.lastSyncProgressAt = Date.now()
                this.resolveReady()
                backoffMs = 500
            } catch (error) {
                if (!this.started || signal.aborted || isAbortError(error)) return
                if (error instanceof MatrixHttpError && error.status === 400 && error.errcode === 'M_UNKNOWN_POS') {
                    this.onLog?.('[matrix-node] persisted sync cursor expired; starting a full sync')
                    this.syncToken = null
                    await writeSyncToken(this.requireCryptoConfig().syncTokenPath, null)
                    continue
                }
                this.onLog?.(`[matrix-node] sync failed: ${formatError(error)}`)
                await wait(Math.min(backoffMs, 10_000), signal).catch(() => {})
                backoffMs = Math.min(backoffMs * 2, 10_000)
            }
        }
    }

    private async processSync(sync: MatrixSyncResponse): Promise<void> {
        const changed = stringArray(sync.device_lists?.changed)
        const left = stringArray(sync.device_lists?.left)
        const fallback = stringArray(
            sync.device_unused_fallback_key_types
            ?? sync['org.matrix.msc2732.device_unused_fallback_key_types'],
        )
        await this.withCryptoLock(async machine => {
            await machine.receiveSyncChanges(
                JSON.stringify(Array.isArray(sync.to_device?.events) ? sync.to_device.events : []),
                new DeviceLists(
                    changed.map(userId => new UserId(userId)),
                    left.map(userId => new UserId(userId)),
                ),
                sync.device_one_time_keys_count ?? {},
                fallback,
            )
            await this.processOutgoingRequests()
        })

        for (const [roomId, room] of Object.entries(sync.rooms?.join ?? {})) {
            for (const event of room.state?.events ?? []) this.updateRoomState(roomId, event)
            for (const event of room.timeline?.events ?? []) {
                this.updateRoomState(roomId, event)
                const mapped = await this.mapIncomingEvent(roomId, event)
                if (!mapped) continue
                for (const listener of this.listeners) listener(mapped)
            }
        }
    }

    private async mapIncomingEvent(
        roomId: string,
        event: MatrixRawEvent,
    ): Promise<MatrixIncomingEvent | null> {
        const eventId = typeof event.event_id === 'string' ? event.event_id : null
        const sender = typeof event.sender === 'string' ? event.sender : null
        const wireType = typeof event.type === 'string' ? event.type : null
        const wireContent = asRecord(event.content)
        if (!eventId || !sender || !wireType || !wireContent) return null
        const originServerTs = typeof event.origin_server_ts === 'number'
            ? event.origin_server_ts
            : undefined

        if (wireType !== 'm.room.encrypted') {
            return {
                roomId,
                eventId,
                eventType: wireType,
                sender,
                encrypted: false,
                content: wireContent,
                ...(originServerTs === undefined ? {} : { originServerTs }),
            }
        }

        try {
            const decrypted = await this.withCryptoLock(machine =>
                machine.decryptRoomEvent(JSON.stringify(event), new RoomId(roomId)))
            const clear = asRecord(JSON.parse(decrypted.event))
            const eventType = typeof clear?.type === 'string' ? clear.type : null
            const content = asRecord(clear?.content)
            if (!eventType || !content) throw new Error('decrypted Matrix event is malformed')
            const senderKey = decrypted.senderClaimedEd25519Key
                ?? decrypted.senderCurve25519Key
                ?? undefined
            return {
                roomId,
                eventId,
                eventType,
                sender,
                ...(senderKey ? { senderDeviceId: senderKey } : {}),
                encrypted: true,
                encryptedPayloadFingerprint: ciphertextFingerprint(wireContent),
                content,
                ...(originServerTs === undefined ? {} : { originServerTs }),
            }
        } catch (error) {
            this.onLog?.(`[matrix-node] could not decrypt ${eventId}: ${formatError(error)}`)
            return null
        }
    }

    private updateRoomState(roomId: string, event: MatrixRawEvent): void {
        if (typeof event.state_key !== 'string' || typeof event.type !== 'string') return
        const content = asRecord(event.content)
        if (!content) return
        const current = this.roomCrypto.get(roomId)
        if (event.type === 'm.room.encryption' && content.algorithm === 'm.megolm.v1.aes-sha2') {
            this.roomCrypto.set(roomId, {
                algorithm: 'm.megolm.v1.aes-sha2',
                ...(positiveInteger(content.rotation_period_ms) === undefined
                    ? {}
                    : { rotationPeriodMs: positiveInteger(content.rotation_period_ms) }),
                ...(positiveInteger(content.rotation_period_msgs) === undefined
                    ? {}
                    : { rotationPeriodMessages: positiveInteger(content.rotation_period_msgs) }),
                historyVisibility: current?.historyVisibility ?? HistoryVisibility.Joined,
                joinedUserIds: current?.joinedUserIds ?? [],
            })
            return
        }
        if (event.type === 'm.room.history_visibility' && current) {
            current.historyVisibility = matrixHistoryVisibility(content.history_visibility)
            return
        }
        if (event.type === 'm.room.member' && current) {
            const userId = event.state_key
            const joined = content.membership === 'join'
            const members = new Set(current.joinedUserIds)
            if (joined) members.add(userId)
            else members.delete(userId)
            current.joinedUserIds = [...members]
        }
    }

    private async ensureRoomCryptoState(roomId: string, refreshMembers = false): Promise<MatrixRoomCryptoState> {
        const current = this.roomCrypto.get(roomId)
        if (current && !refreshMembers) return current
        const [encryption, visibility, members] = await Promise.all([
            this.matrixRequest<Record<string, unknown>>(
                'GET',
                matrixStatePath(roomId, 'm.room.encryption', ''),
            ),
            this.matrixRequest<Record<string, unknown>>(
                'GET',
                matrixStatePath(roomId, 'm.room.history_visibility', ''),
            ).catch(error => {
                if (error instanceof MatrixHttpError && error.status === 404) return {}
                throw error
            }),
            this.matrixRequest<Record<string, unknown>>(
                'GET',
                `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
            ),
        ])
        if (encryption.algorithm !== 'm.megolm.v1.aes-sha2') {
            throw new Error(`Matrix room ${roomId} is not encrypted with Megolm`)
        }
        const joined = asRecord(members.joined)
        const state: MatrixRoomCryptoState = {
            algorithm: 'm.megolm.v1.aes-sha2',
            ...(positiveInteger(encryption.rotation_period_ms) === undefined
                ? {}
                : { rotationPeriodMs: positiveInteger(encryption.rotation_period_ms) }),
            ...(positiveInteger(encryption.rotation_period_msgs) === undefined
                ? {}
                : { rotationPeriodMessages: positiveInteger(encryption.rotation_period_msgs) }),
            historyVisibility: matrixHistoryVisibility(asRecord(visibility)?.history_visibility),
            joinedUserIds: joined ? Object.keys(joined) : [],
        }
        this.roomCrypto.set(roomId, state)
        await this.withCryptoLock(async machine => {
            await machine.updateTrackedUsers(state.joinedUserIds.map(userId => new UserId(userId)))
            await this.processOutgoingRequests()
        })
        return state
    }

    private async processOutgoingRequests(): Promise<void> {
        const machine = this.requireMachine()
        const requests = await machine.outgoingRequests()
        for (const request of requests) {
            let response: unknown
            switch (request.type) {
                case RequestType.KeysUpload:
                    response = await this.matrixRequest('POST', '/_matrix/client/v3/keys/upload', {
                        body: JSON.parse(request.body), retryRateLimit: true,
                    })
                    break
                case RequestType.KeysQuery:
                    response = await this.matrixRequest('POST', '/_matrix/client/v3/keys/query', {
                        body: JSON.parse(request.body), retryRateLimit: true,
                    })
                    break
                case RequestType.KeysClaim:
                    response = await this.matrixRequest('POST', '/_matrix/client/v3/keys/claim', {
                        body: JSON.parse(request.body), retryRateLimit: true,
                    })
                    break
                case RequestType.ToDevice:
                    {
                        const toDevice = request as ToDeviceRequest
                    response = await this.matrixRequest(
                        'PUT',
                        `/_matrix/client/v3/sendToDevice/${encodeURIComponent(toDevice.eventType)}/${encodeURIComponent(toDevice.txnId)}`,
                        { body: JSON.parse(toDevice.body), retryRateLimit: true },
                    )
                    break
                    }
                case RequestType.SignatureUpload:
                    response = await this.matrixRequest(
                        'POST',
                        '/_matrix/client/v3/keys/signatures/upload',
                        { body: JSON.parse(request.body), retryRateLimit: true },
                    )
                    break
                default:
                    throw new Error(`Unsupported Matrix crypto request type ${request.type}`)
            }
            await machine.markRequestAsSent(request.id, request.type, JSON.stringify(response))
        }
    }

    private async processKeysClaim(request: KeysClaimRequest): Promise<void> {
        const response = await this.matrixRequest(
            'POST',
            '/_matrix/client/v3/keys/claim',
            { body: JSON.parse(request.body), retryRateLimit: true },
        )
        await this.requireMachine().markRequestAsSent(
            request.id,
            request.type,
            JSON.stringify(response),
        )
    }

    private async processToDeviceRequest(request: {
        id: string
        type: RequestType
        eventType: string
        txnId: string
        body: string
    }): Promise<void> {
        const response = await this.matrixRequest(
            'PUT',
            `/_matrix/client/v3/sendToDevice/${encodeURIComponent(request.eventType)}/${encodeURIComponent(request.txnId)}`,
            { body: JSON.parse(request.body), retryRateLimit: true },
        )
        await this.requireMachine().markRequestAsSent(
            request.id,
            request.type,
            JSON.stringify(response),
        )
    }

    private async sendDirectRoomEvent(request: {
        roomId: string
        eventType: string
        transactionId: string
        content: Record<string, unknown>
    }): Promise<MatrixSendEventResult> {
        return this.withRoomSendLock(async () => {
            const response = await this.matrixRequest<{ event_id: string }>(
                'PUT',
                `/_matrix/client/v3/rooms/${encodeURIComponent(request.roomId)}/send/${encodeURIComponent(request.eventType)}/${encodeURIComponent(request.transactionId)}`,
                { body: request.content, retryRateLimit: true },
            )
            return { eventId: requireEventId(response) }
        })
    }

    private async matrixRequest<T = Record<string, unknown>>(
        method: string,
        path: string,
        options: MatrixRequestOptions = {},
    ): Promise<T> {
        while (true) {
            const url = new URL(path, normalizedBaseUrl(this.connection.baseUrl))
            for (const [key, value] of Object.entries(options.query ?? {})) {
                if (value !== undefined) url.searchParams.set(key, String(value))
            }
            const timeoutController = new AbortController()
            const timeout = setTimeout(
                () => timeoutController.abort(),
                options.timeoutMs ?? this.defaultReadyTimeoutMs,
            )
            const signal = options.signal
                ? AbortSignal.any([options.signal, timeoutController.signal])
                : timeoutController.signal
            let response: Response
            try {
                response = await this.fetchImpl(url, {
                    method,
                    headers: {
                        authorization: `Bearer ${this.connection.accessToken}`,
                        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
                    },
                    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
                    signal,
                })
            } finally {
                clearTimeout(timeout)
            }
            const text = await response.text()
            const body = text ? safeJson(text) : {}
            if (response.ok) return body as T
            const record = asRecord(body)
            const retryAfterMs = retryDelay(response, record)
            if (response.status === 429 && options.retryRateLimit) {
                this.onLog?.(`[matrix-node] rate limited; retrying in ${retryAfterMs}ms`)
                await wait(retryAfterMs, options.signal)
                continue
            }
            throw new MatrixHttpError(
                `Matrix ${method} ${path} failed with HTTP ${response.status}`,
                response.status,
                typeof record?.errcode === 'string' ? record.errcode : undefined,
                retryAfterMs,
            )
        }
    }

    private withCryptoLock<T>(operation: (machine: OlmMachineType) => Promise<T>): Promise<T> {
        const run = this.cryptoChain.then(() => operation(this.requireMachine()))
        this.cryptoChain = run.then(() => undefined, () => undefined)
        return run
    }

    /**
     * Synapse applies rc_message to the sending account rather than to an
     * individual room or event type. Keep every room timeline/state write on
     * one lane so a 429 retry owns the account-wide retry_after window instead
     * of waking several independent retries into the same empty token bucket.
     */
    private withRoomSendLock<T>(operation: () => Promise<T>): Promise<T> {
        const run = this.roomSendChain.then(operation)
        this.roomSendChain = run.then(() => undefined, () => undefined)
        return run
    }

    private requireMachine(): OlmMachineType {
        if (!this.machine) throw new Error('Matrix crypto is unavailable')
        return this.machine
    }

    private requireCryptoConfig(): Extract<MatrixGatewayCryptoConfig, { backend: 'node-sqlite' }> {
        if (!this.cryptoConfig) throw new Error('Matrix crypto config is unavailable')
        return this.cryptoConfig
    }

    private resolveReady(): void {
        if (this.ready) return
        this.ready = true
        for (const waiter of this.readyWaiters) waiter.resolve()
        this.readyWaiters.clear()
    }

    private rejectReady(error: Error): void {
        if (this.ready || this.readyError) return
        this.readyError = error
        for (const waiter of this.readyWaiters) waiter.reject(error)
        this.readyWaiters.clear()
    }
}

export async function loadOrCreateMatrixCryptoPassphrase(path: string): Promise<string> {
    try {
        const value = (await readFile(path, 'utf8')).trim()
        if (!value) throw new Error('Matrix crypto passphrase file is empty')
        return value
    } catch (error) {
        if (!isMissingFile(error)) throw error
    }
    await mkdir(dirname(path), { recursive: true })
    const value = randomBytes(32).toString('base64url')
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
        await handle.writeFile(`${value}\n`, 'utf8')
        await handle.sync()
    } finally {
        await handle.close()
    }
    await rename(temporaryPath, path)
    await chmod(path, 0o600)
    return value
}

function encryptionSettings(room: MatrixRoomCryptoState): EncryptionSettings {
    const settings = new EncryptionSettings()
    settings.algorithm = EncryptionAlgorithm.MegolmV1AesSha2
    settings.historyVisibility = room.historyVisibility
    settings.sharingStrategy = CollectStrategy.AllDevices
    if (room.rotationPeriodMs !== undefined) {
        settings.rotationPeriod = BigInt(room.rotationPeriodMs) * 1_000n
    }
    if (room.rotationPeriodMessages !== undefined) {
        settings.rotationPeriodMessages = BigInt(room.rotationPeriodMessages)
    }
    return settings
}

function matrixHistoryVisibility(value: unknown): HistoryVisibility {
    switch (value) {
        case 'invited': return HistoryVisibility.Invited
        case 'shared': return HistoryVisibility.Shared
        case 'world_readable': return HistoryVisibility.WorldReadable
        case 'joined':
        default: return HistoryVisibility.Joined
    }
}

function matrixStatePath(roomId: string, eventType: string, stateKey: string): string {
    return `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(eventType)}/${encodeURIComponent(stateKey)}`
}

function normalizedBaseUrl(value: string): string {
    return `${value.replace(/\/$/u, '')}/`
}

function requireEventId(response: { event_id?: unknown }): string {
    if (typeof response.event_id !== 'string' || !response.event_id) {
        throw new Error('Matrix send response did not contain event_id')
    }
    return response.event_id
}

function retryDelay(response: Response, body: Record<string, unknown> | null): number {
    const bodyDelay = body?.retry_after_ms
    if (typeof bodyDelay === 'number' && Number.isFinite(bodyDelay)) {
        return Math.min(300_000, Math.max(250, Math.ceil(bodyDelay)))
    }
    const headerSeconds = Number(response.headers.get('retry-after'))
    if (Number.isFinite(headerSeconds) && headerSeconds > 0) {
        return Math.min(300_000, Math.max(250, Math.ceil(headerSeconds * 1_000)))
    }
    return 1_000
}

async function readSyncToken(path: string): Promise<string | null> {
    try {
        const value = asRecord(JSON.parse(await readFile(path, 'utf8')))
        if (value?.version !== 1 || (value.nextBatch !== null && typeof value.nextBatch !== 'string')) {
            throw new Error('Invalid persisted Matrix sync cursor')
        }
        return value.nextBatch as string | null
    } catch (error) {
        if (isMissingFile(error)) return null
        throw error
    }
}

async function writeSyncToken(path: string, nextBatch: string | null): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
        await handle.writeFile(`${JSON.stringify({ version: 1, nextBatch })}\n`, 'utf8')
        await handle.sync()
    } finally {
        await handle.close()
    }
    await rename(temporaryPath, path)
    await chmod(path, 0o600)
}

function ciphertextFingerprint(value: unknown): string {
    return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text)
    } catch {
        return { raw: text }
    }
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
}

function positiveInteger(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? value
        : undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function isMissingFile(error: unknown): boolean {
    return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError'
}

function wait(durationMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason)
            return
        }
        const timer = setTimeout(resolve, durationMs)
        signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(signal.reason)
        }, { once: true })
    })
}

function requirePositiveDuration(value: number, name: string): void {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be a positive duration`)
    }
}

function assertSecureApplicationTimelineContent(content: Record<string, unknown>): void {
    const extension = asRecord(content['io.codever'])
    if (extension?.version === 3) {
        cvp3TimelineContentSchema.parse(content)
        return
    }
    if (
        extension?.version !== 2
        || extension.kind !== 'timeline_envelope'
        || !asRecord(extension.timeline_envelope)
        || !asRecord(extension.timeline_key_ring_bundle)
    ) {
        throw new Error('Application timeline events must contain a Codever timeline envelope')
    }
}

function assertSecureApplicationControlContent(content: Record<string, unknown>): void {
    const extension = asRecord(content['io.codever'])
    if (
        extension?.version !== 1
        || !(
            (extension.kind === 'secure_envelope' && asRecord(extension.secure_envelope))
            || (extension.kind === 'secure_envelope_bundle' && asRecord(extension.secure_envelope_bundle))
        )
    ) {
        throw new Error('Application control events must contain a Codever secure envelope')
    }
}

function assertSecureApplicationStateContent(request: MatrixApplicationStateEventRequest): void {
    const content = request.content
    if (request.eventType === CVP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE) {
        cvp3ProjectKeyGrantStateSchema.parse(content)
        return
    }
    if (
        request.eventType === CVP3_MATRIX_PROJECT_POINTER_EVENT_TYPE
        || request.eventType === CVP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE
    ) {
        cvp3CurrentPointerSchema.parse(content)
        return
    }
    const stateEnvelope = asRecord(content.state_envelope)
    const signedEnvelope = asRecord(stateEnvelope?.envelope)
    const expectsKeyRing = request.eventType === CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE
    const isSessionState = request.eventType === CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE
        || request.eventType === CODEVER_MATRIX_SESSION_DIRECTORY_EVENT_TYPE
    if (
        content.version !== 2
        || content.kind !== 'state_envelope'
        || !stateEnvelope
        || !signedEnvelope
        || signedEnvelope.eventType !== request.eventType
        || signedEnvelope.stateKey !== request.stateKey
        || !(expectsKeyRing || isSessionState)
        || (expectsKeyRing && !asRecord(content.timeline_key_ring_bundle))
        || (isSessionState && content.timeline_key_ring_bundle !== undefined)
    ) {
        throw new Error('Application state events must contain a Codever state envelope')
    }
}

function quietLogger(onLog?: (message: string) => void): Logger {
    const logger: Logger = {
        trace() {},
        debug() {},
        info() {},
        warn(message) { onLog?.(`[matrix-sdk] ${String(message)}`) },
        error(message) { onLog?.(`[matrix-sdk] ${String(message)}`) },
        getChild: () => logger,
    }
    return logger
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
