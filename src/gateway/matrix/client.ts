import { createHash } from 'node:crypto'
import {
    ClientEvent,
    SyncState,
    createClient,
    type MatrixClient,
    type MatrixEvent,
} from 'matrix-js-sdk'
import { AllDevicesIsolationMode } from 'matrix-js-sdk/lib/crypto-api'
import type { RoomMessageEventContent } from 'matrix-js-sdk/lib/@types/events.js'
import { canonicalJson } from '@codever/protocol'
import type {
    MatrixGatewayConnectionConfig,
    MatrixGatewayCryptoConfig,
    MatrixGatewayTrustedDevice,
} from './config'
import type {
    MatrixIncomingEvent,
    MatrixSendEventRequest,
    MatrixSendEventResult,
    MatrixTransport,
} from '@/channel/matrix'

export type MatrixGatewayEventListener = (event: MatrixIncomingEvent) => void

export interface MatrixGatewayClient extends MatrixTransport {
    initializeCrypto(config: MatrixGatewayCryptoConfig): Promise<void>
    onRoomEvent(listener: MatrixGatewayEventListener): () => void
    start(): Promise<void>
    waitUntilReady(timeoutMs?: number): Promise<void>
    assertRoomEncrypted(roomId: string): Promise<void>
    pinTrustedDevices?(devices: MatrixGatewayTrustedDevice[]): Promise<void>
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
    })
    return new MatrixJsSdkGatewayClient(client, connection.initialSyncTimeoutMs, onLog)
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
    ) {}

    async initializeCrypto(config: MatrixGatewayCryptoConfig): Promise<void> {
        if (this.cryptoInitialized) return
        await this.client.initRustCrypto({
            useIndexedDB: config.useIndexedDB,
            cryptoDatabasePrefix: config.databasePrefix,
            ...(config.storageKey ? { storageKey: config.storageKey } : {}),
            ...(config.storagePassword ? { storagePassword: config.storagePassword } : {}),
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

    async pinTrustedDevices(devices: MatrixGatewayTrustedDevice[]): Promise<void> {
        const crypto = this.client.getCrypto()
        if (!crypto) throw new Error('Matrix crypto is unavailable')
        const userIds = [...new Set(devices.map(device => device.matrixUserId))]
        const deviceMap = await crypto.getUserDeviceInfo(userIds, true)
        for (const trusted of devices) {
            const matrixDeviceId = trusted.matrixDeviceId ?? trusted.deviceId
            const device = deviceMap.get(trusted.matrixUserId)?.get(matrixDeviceId)
            if (!device) {
                throw new Error(
                    `Trusted Matrix device ${trusted.matrixUserId}/${matrixDeviceId} is not visible`,
                )
            }
            const fingerprint = device.getFingerprint()
            if (!fingerprint || !trusted.matrixDeviceKeys.includes(fingerprint)) {
                throw new Error(
                    `Trusted Matrix device ${trusted.matrixUserId}/${matrixDeviceId} fingerprint does not match`,
                )
            }
            await crypto.setDeviceVerified(trusted.matrixUserId, matrixDeviceId, true)
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

    async setTyping(roomId: string, typing: boolean, timeoutMs = 30_000): Promise<void> {
        await this.client.sendTyping(roomId, typing, timeoutMs)
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

function isReadyState(state: SyncState | null): boolean {
    return state === SyncState.Prepared || state === SyncState.Syncing || state === SyncState.Catchup
}

function ciphertextFingerprint(value: unknown): string {
    return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
