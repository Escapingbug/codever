import { createHash } from 'node:crypto'
import {
    ClientEvent,
    Method,
    MatrixScheduler,
    SyncState,
    createClient,
    type MatrixClient,
    type MatrixEvent,
} from 'matrix-js-sdk'
import { AllDevicesIsolationMode } from 'matrix-js-sdk/lib/crypto-api/index.js'
import type { RoomMessageEventContent } from 'matrix-js-sdk/lib/@types/events.js'
import {
    CODEVER_MATRIX_APPLICATION_CONTROL_EVENT_TYPE,
    CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE,
    CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE,
    canonicalJson,
} from '@codever/protocol'
import { toArrayBuffer } from '@codever/security'
import type {
    MatrixGatewayConnectionConfig,
    MatrixGatewayCryptoConfig,
    MatrixGatewayPinnedTransportDevice,
    MatrixGatewayTrustedDevice,
} from './config'
import type {
    MatrixDownloadMediaRequest,
    MatrixApplicationControlEventRequest,
    MatrixApplicationStateEventRequest,
    MatrixApplicationTimelineEventRequest,
    MatrixIncomingEvent,
    MatrixRoomMessageContent,
    MatrixSendEventRequest,
    MatrixSendEventResult,
    MatrixTransport,
    MatrixUploadMediaRequest,
    MatrixUploadMediaResult,
} from '@/channel/matrix'
import { downloadMatrixMedia } from '@/channel/matrix/sdkTransport'

export type MatrixGatewayEventListener = (event: MatrixIncomingEvent) => void

export interface MatrixGatewayClientOptions {
    /** Bound eventual consistency of Matrix /keys/query after initial sync. */
    trustedDeviceVisibilityTimeoutMs?: number
    trustedDeviceVisibilityRetryMs?: number
    now?: () => number
    sleep?: (durationMs: number) => Promise<void>
}

export interface MatrixSyncWatchdogOptions {
    /** Maximum time without a completed Matrix /sync cycle. */
    stallTimeoutMs: number
    /** Health-check cadence. Defaults to one quarter of the stall timeout. */
    checkIntervalMs?: number
    /** Test seam for deterministic elapsed-time checks. */
    now?: () => number
}

export interface MatrixGatewayClient extends MatrixTransport {
    initializeCrypto(config: MatrixGatewayCryptoConfig): Promise<void>
    onRoomEvent(listener: MatrixGatewayEventListener): () => void
    start(): Promise<void>
    waitUntilReady(timeoutMs?: number): Promise<void>
    assertRoomEncrypted(roomId: string): Promise<void>
    pinTrustedDevices?(devices: MatrixGatewayPinnedTransportDevice[]): Promise<void>
    prepareRoomThread?(roomId: string, rootEventId: string, timeoutMs?: number): Promise<void>
    setExtendedProfileProperty?(key: string, value: unknown): Promise<void>
    stop(): Promise<void>
}

export function createMatrixJsSdkGatewayClient(
    connection: MatrixGatewayConnectionConfig,
    onLog?: (message: string) => void,
): MatrixGatewayClient {
    const client = createClient({
        baseUrl: connection.baseUrl,
        accessToken: connection.accessToken,
        userId: connection.userId,
        deviceId: connection.deviceId,
        scheduler: createGatewayMatrixScheduler(),
    })
    return new MatrixJsSdkGatewayClient(client, connection.initialSyncTimeoutMs, onLog)
}

export function createGatewayMatrixScheduler(): MatrixScheduler {
    // GatewaySecureContentLayer already owns durable retries, bounded
    // concurrency, per-recipient serialization, and the control/normal lanes.
    // Letting the SDK enqueue every m.room.message behind its global FIFO would
    // erase those priorities and can delay command acks/results behind bulk
    // timeline traffic. A null queue sends immediately after Matrix E2EE while
    // the Codever WAL remains the single retry authority.
    return new MatrixScheduler(
        MatrixScheduler.RETRY_BACKOFF_RATELIMIT,
        () => null,
    )
}

/**
 * Detects the failure mode where matrix-js-sdk remains started and keeps its
 * TCP connection open, but its long-running /sync loop no longer completes.
 * The SDK emits Syncing -> Syncing after every successful response, including
 * empty long-poll responses, so room traffic is not required for liveness.
 */
export function watchMatrixSyncHealth(
    client: MatrixClient,
    options: MatrixSyncWatchdogOptions,
    onStalled: (error: Error) => void,
): () => void {
    requirePositiveDuration(options.stallTimeoutMs, 'stallTimeoutMs')
    const checkIntervalMs = options.checkIntervalMs
        ?? Math.min(30_000, Math.max(1_000, Math.floor(options.stallTimeoutMs / 4)))
    requirePositiveDuration(checkIntervalMs, 'checkIntervalMs')
    const now = options.now ?? Date.now
    let lastProgressAt = now()
    let stopped = false

    const onSync = (state: SyncState): void => {
        if (isReadyState(state)) lastProgressAt = now()
    }
    client.on(ClientEvent.Sync, onSync)

    const timer = setInterval(() => {
        if (stopped) return
        const elapsedMs = Math.max(0, now() - lastProgressAt)
        if (elapsedMs < options.stallTimeoutMs) return
        stopped = true
        clearInterval(timer)
        client.off(ClientEvent.Sync, onSync)
        const state = client.getSyncState() ?? 'unknown'
        onStalled(new Error(
            `Matrix sync made no progress for ${elapsedMs}ms (state=${state})`,
        ))
    }, checkIntervalMs)

    return () => {
        if (stopped) return
        stopped = true
        clearInterval(timer)
        client.off(ClientEvent.Sync, onSync)
    }
}

export class MatrixJsSdkGatewayClient implements MatrixGatewayClient {
    private listeners = new Set<MatrixGatewayEventListener>()
    private cryptoInitialized = false
    private started = false
    private readonly sdkEventListener = (event: MatrixEvent): void => {
        void this.mapEvent(event)
            .then(mapped => {
                if (!mapped) return
                for (const listener of this.listeners) listener(mapped)
            })
            .catch(error => this.onLog?.(`[matrix-sdk] incoming event failed: ${formatError(error)}`))
    }

    constructor(
        private readonly client: MatrixClient,
        private readonly defaultReadyTimeoutMs = 30_000,
        private readonly onLog?: (message: string) => void,
        private readonly options: MatrixGatewayClientOptions = {},
    ) {}

    async initializeCrypto(config: MatrixGatewayCryptoConfig): Promise<void> {
        if (this.cryptoInitialized) return
        if (config.backend === 'node-sqlite') {
            throw new Error('matrix-js-sdk cannot use the Node SQLite crypto backend')
        }
        await this.client.initRustCrypto({
            useIndexedDB: config.backend === 'indexeddb',
            cryptoDatabasePrefix: config.databasePrefix,
            ...(config.backend === 'indexeddb' && config.storageKey
                ? { storageKey: config.storageKey }
                : {}),
            ...(config.backend === 'indexeddb' && config.storagePassword
                ? { storagePassword: config.storagePassword }
                : {}),
        })
        if (!this.client.getCrypto()) throw new Error('Matrix Rust crypto initialization returned no CryptoApi')
        const crypto = this.client.getCrypto()
        if (crypto) {
            crypto.globalBlacklistUnverifiedDevices = true
            crypto.setDeviceIsolationMode(new AllDevicesIsolationMode(false))
        }
        this.cryptoInitialized = true
    }

    onRoomEvent(listener: MatrixGatewayEventListener): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    async start(): Promise<void> {
        if (this.started) return
        if (!this.cryptoInitialized) throw new Error('Matrix crypto must be initialized before sync starts')
        this.client.on(ClientEvent.Event, this.sdkEventListener)
        try {
            await this.client.startClient()
            this.started = true
        } catch (error) {
            this.client.off(ClientEvent.Event, this.sdkEventListener)
            throw error
        }
    }

    async waitUntilReady(timeoutMs = this.defaultReadyTimeoutMs): Promise<void> {
        if (!this.started) throw new Error('Matrix client has not started')
        if (isReadyState(this.client.getSyncState())) return

        await new Promise<void>((resolve, reject) => {
            let timeout: ReturnType<typeof setTimeout> | undefined
            const onSync = (state: SyncState): void => {
                if (state === SyncState.Error || state === SyncState.Stopped) {
                    cleanup()
                    reject(new Error(`Matrix sync entered ${state} before becoming ready`))
                    return
                }
                if (isReadyState(state)) {
                    cleanup()
                    resolve()
                }
            }
            const cleanup = (): void => {
                if (timeout) clearTimeout(timeout)
                this.client.off(ClientEvent.Sync, onSync)
            }
            timeout = setTimeout(() => {
                cleanup()
                reject(new Error(`Matrix initial sync timed out after ${timeoutMs}ms`))
            }, timeoutMs)
            this.client.on(ClientEvent.Sync, onSync)
        })
    }

    async assertRoomEncrypted(roomId: string): Promise<void> {
        const crypto = this.client.getCrypto()
        if (!crypto) throw new Error('Matrix crypto is unavailable')
        if (!await crypto.isEncryptionEnabledInRoom(roomId)) {
            throw new Error(`Matrix room ${roomId} is not encrypted`)
        }
    }

    async pinTrustedDevices(devices: MatrixGatewayPinnedTransportDevice[]): Promise<void> {
        const crypto = this.client.getCrypto()
        if (!crypto) throw new Error('Matrix crypto is unavailable')
        const userIds = [...new Set(devices.map(device => device.matrixUserId))]
        const now = this.options.now ?? Date.now
        const sleep = this.options.sleep ?? wait
        const timeoutMs = Math.max(
            0,
            this.options.trustedDeviceVisibilityTimeoutMs ?? 30_000,
        )
        const retryMs = Math.max(
            0,
            this.options.trustedDeviceVisibilityRetryMs ?? 500,
        )
        const deadline = now() + timeoutMs
        while (true) {
            const deviceMap = await crypto.getUserDeviceInfo(userIds, true)
            const missing: MatrixGatewayPinnedTransportDevice[] = []
            for (const trusted of devices) {
                const matrixDeviceId = trusted.matrixDeviceId
                const device = deviceMap.get(trusted.matrixUserId)?.get(matrixDeviceId)
                if (!device) {
                    missing.push(trusted)
                    continue
                }
                const fingerprint = device.getFingerprint()
                if (!fingerprint || !trusted.matrixDeviceKeys.includes(fingerprint)) {
                    throw new Error(
                        `Trusted Matrix device ${trusted.matrixUserId}/${matrixDeviceId} fingerprint does not match`,
                    )
                }
            }
            if (missing.length === 0) {
                for (const trusted of devices) {
                    await crypto.setDeviceVerified(
                        trusted.matrixUserId,
                        trusted.matrixDeviceId,
                        true,
                    )
                }
                return
            }
            const remainingMs = deadline - now()
            if (remainingMs <= 0) {
                const [first] = missing
                throw new Error(
                    `Trusted Matrix device ${first?.matrixUserId}/${first?.matrixDeviceId} `
                    + `is not visible after ${timeoutMs}ms`,
                )
            }
            this.onLog?.(
                `[matrix-sdk] waiting for ${missing.length} trusted Matrix device(s) `
                + 'to become visible',
            )
            await sleep(Math.min(retryMs, remainingMs))
        }
    }

    async sendEncryptedRoomEvent(request: MatrixSendEventRequest): Promise<MatrixSendEventResult> {
        if (!this.cryptoInitialized || !this.started) throw new Error('Matrix client is not ready')
        const result = await this.client.sendMessage(
            request.roomId,
            request.content as RoomMessageEventContent,
            request.transactionId,
        )
        return { eventId: result.event_id }
    }

    async sendApplicationTimelineEvent(
        request: MatrixApplicationTimelineEventRequest,
    ): Promise<MatrixSendEventResult> {
        if (!this.cryptoInitialized || !this.started) throw new Error('Matrix client is not ready')
        assertSecureApplicationTimelineContent(request.content)
        const result = await this.sendDirectRoomEvent(request)
        this.onLog?.('[matrix-sdk] application timeline event sent directly')
        return result
    }

    async sendApplicationControlEvent(
        request: MatrixApplicationControlEventRequest,
    ): Promise<MatrixSendEventResult> {
        if (!this.cryptoInitialized || !this.started) throw new Error('Matrix client is not ready')
        assertSecureApplicationControlContent(request.content)
        return this.sendDirectRoomEvent(request)
    }

    async setApplicationRoomState(
        request: MatrixApplicationStateEventRequest,
    ): Promise<MatrixSendEventResult> {
        if (!this.cryptoInitialized || !this.started) throw new Error('Matrix client is not ready')
        assertSecureApplicationStateContent(request)
        const path = [
            '/rooms/',
            encodeURIComponent(request.roomId),
            '/state/',
            encodeURIComponent(request.eventType),
            '/',
            encodeURIComponent(request.stateKey),
        ].join('')
        const result = await this.client.http.authedRequest<{ event_id: string }>(
            Method.Put,
            path,
            undefined,
            request.content,
            { localTimeoutMs: this.defaultReadyTimeoutMs },
        )
        return { eventId: result.event_id }
    }

    async prepareRoomThread(
        roomId: string,
        rootEventId: string,
        timeoutMs = this.defaultReadyTimeoutMs,
    ): Promise<void> {
        const findRoot = (): MatrixEvent | undefined =>
            this.client.getRoom(roomId)?.findEventById(rootEventId)
        let rootEvent = findRoot()
        if (!rootEvent) {
            try {
                const fetched = await this.client.fetchRoomEvent(roomId, rootEventId)
                rootEvent = this.client.getEventMapper()({
                    ...fetched,
                    room_id: fetched.room_id ?? roomId,
                })
            } catch {
                // A just-created direct event can race its own remote echo on
                // eventually-consistent homeservers. Keep the live-event path
                // as a fallback, while persisted roots normally use the fetch.
                rootEvent = await this.waitForRoomEvent(roomId, rootEventId, findRoot, timeoutMs)
            }
        }
        const room = this.client.getRoom(roomId)
        if (!room) throw new Error(`Matrix room ${roomId} is not available`)
        if (!room.getThread(rootEventId)) {
            room.createThread(rootEventId, rootEvent, [], false)
        }
    }

    private async waitForRoomEvent(
        roomId: string,
        eventId: string,
        findEvent: () => MatrixEvent | undefined,
        timeoutMs: number,
    ): Promise<MatrixEvent> {
        return new Promise<MatrixEvent>((resolve, reject) => {
            let timeout: ReturnType<typeof setTimeout> | undefined
            const onEvent = (event: MatrixEvent): void => {
                if (event.getRoomId() !== roomId || event.getId() !== eventId) return
                cleanup()
                resolve(event)
            }
            const cleanup = (): void => {
                if (timeout) clearTimeout(timeout)
                this.client.off(ClientEvent.Event, onEvent)
            }
            timeout = setTimeout(() => {
                cleanup()
                reject(new Error(
                    `Matrix did not sync event ${eventId} in room ${roomId} within ${timeoutMs}ms`,
                ))
            }, timeoutMs)
            this.client.on(ClientEvent.Event, onEvent)
            const current = findEvent()
            if (current) {
                cleanup()
                resolve(current)
            }
        })
    }

    private async sendDirectRoomEvent(request: {
        roomId: string
        eventType: string
        transactionId: string
        content: MatrixRoomMessageContent
    }): Promise<MatrixSendEventResult> {
        const path = [
            '/rooms/',
            encodeURIComponent(request.roomId),
            '/send/',
            encodeURIComponent(request.eventType),
            '/',
            encodeURIComponent(request.transactionId),
        ].join('')
        const result = await this.client.http.authedRequest<{ event_id: string }>(
            Method.Put,
            path,
            undefined,
            request.content,
        )
        return { eventId: result.event_id }
    }

    async setExtendedProfileProperty(key: string, value: unknown): Promise<void> {
        if (!this.started) throw new Error('Matrix client is not ready')
        await this.client.setExtendedProfileProperty(key, value)
    }

    async setTyping(roomId: string, typing: boolean, timeoutMs = 30_000): Promise<void> {
        await this.client.sendTyping(roomId, typing, timeoutMs)
    }

    async uploadEncryptedMedia(request: MatrixUploadMediaRequest): Promise<MatrixUploadMediaResult> {
        if (!this.cryptoInitialized || !this.started) throw new Error('Matrix client is not ready')
        const response = await this.client.uploadContent(
            new Blob([toArrayBuffer(request.ciphertext)], { type: 'application/octet-stream' }),
            {
                type: 'application/octet-stream',
                includeFilename: false,
            },
        )
        return { url: response.content_uri }
    }

    async downloadEncryptedMedia(request: MatrixDownloadMediaRequest): Promise<Uint8Array> {
        if (!this.cryptoInitialized || !this.started) throw new Error('Matrix client is not ready')
        return downloadMatrixMedia(this.client, request)
    }

    async stop(): Promise<void> {
        if (!this.started) return
        this.started = false
        this.client.off(ClientEvent.Event, this.sdkEventListener)
        this.client.stopClient()
    }

    private async mapEvent(event: MatrixEvent): Promise<MatrixIncomingEvent | null> {
        const roomId = event.getRoomId()
        const eventId = event.getId()
        const sender = event.getSender()
        if (!roomId || !eventId || !sender) return null

        await this.client.decryptEventIfNeeded(event)
        const encrypted = event.isEncrypted()
        const wireContent = event.getWireContent()
        const claimedDeviceKey = event.getClaimedEd25519Key() ?? event.getSenderKey() ?? undefined
        return {
            roomId,
            eventId,
            eventType: event.getType(),
            sender,
            ...(claimedDeviceKey ? { senderDeviceId: claimedDeviceKey } : {}),
            encrypted,
            ...(encrypted ? { encryptedPayloadFingerprint: ciphertextFingerprint(wireContent) } : {}),
            content: event.getContent() as Record<string, unknown>,
            originServerTs: event.getTs(),
        }
    }
}

function assertSecureApplicationTimelineContent(content: Record<string, unknown>): void {
    const extension = asRecord(content['io.codever'])
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
            || (
                extension.kind === 'secure_envelope_bundle'
                && asRecord(extension.secure_envelope_bundle)
            )
        )
    ) {
        throw new Error('Application control events must contain a Codever secure envelope')
    }
}

function assertSecureApplicationStateContent(request: MatrixApplicationStateEventRequest): void {
    const content = request.content
    const stateEnvelope = asRecord(content.state_envelope)
    const signedEnvelope = asRecord(stateEnvelope?.envelope)
    const expectsKeyRing = request.eventType === CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE
    const isSessionState = request.eventType === CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE
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

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function isReadyState(state: SyncState | null): boolean {
    return state === SyncState.Prepared || state === SyncState.Syncing || state === SyncState.Catchup
}

function requirePositiveDuration(value: number, name: string): void {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be a positive duration`)
    }
}

function wait(durationMs: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, durationMs))
}

function ciphertextFingerprint(value: unknown): string {
    return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
