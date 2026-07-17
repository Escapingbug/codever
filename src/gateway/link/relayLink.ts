import { randomUUID } from 'node:crypto'
import {
    PROTOCOL_VERSION,
    parseGatewayFrame,
    type GatewayDeviceTunnelFrame,
    type GatewayFrame,
    type Heartbeat,
} from '@codever/protocol'
import WebSocket, { type ClientOptions, type RawData } from 'ws'
import { SecureGatewayHandshake } from './secureGatewayHandshake'
import { RelayLinkError, type RelayLinkOptions, type RelayLinkState } from './types'

const SECURE_RELAY_PATH = '/v2/gateway/connect'
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000
const DEFAULT_INITIAL_RECONNECT_DELAY_MS = 250
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000
const DEFAULT_RECONNECT_MULTIPLIER = 2
const DEFAULT_RECONNECT_JITTER = 0.2

export class RelayLink {
    private readonly startedAt: number
    private socket?: WebSocket
    private connectionEpoch?: string
    private stateValue: RelayLinkState = 'idle'
    private generation = 0
    private reconnectAttempt = 0
    private reconnectTimer?: ReturnType<typeof setTimeout>
    private heartbeatTimer?: ReturnType<typeof setInterval>
    private stopping = false
    private incoming = Promise.resolve()
    private outgoing = Promise.resolve()
    private firstOnline?: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }
    private secureHandshake?: SecureGatewayHandshake

    constructor(private readonly options: RelayLinkOptions) {
        validateOptions(options)
        this.startedAt = this.now()
    }

    get state(): RelayLinkState {
        return this.stateValue
    }

    get epoch(): string | undefined {
        return this.connectionEpoch
    }

    start(): Promise<void> {
        if (this.stateValue === 'online') return Promise.resolve()
        if (this.firstOnline) return this.firstOnline.promise

        this.stopping = false
        let resolve!: () => void
        let reject!: (error: Error) => void
        const promise = new Promise<void>((res, rej) => {
            resolve = res
            reject = rej
        })
        this.firstOnline = { promise, resolve, reject }
        this.openConnection()
        return promise
    }

    connect(): Promise<void> {
        return this.start()
    }

    async stop(): Promise<void> {
        if (this.stateValue === 'stopped') return
        this.stopping = true
        this.generation += 1
        this.clearReconnectTimer()
        this.clearHeartbeatTimer()
        this.connectionEpoch = undefined
        this.secureHandshake = undefined

        const socket = this.socket
        this.socket = undefined
        if (socket && socket.readyState !== WebSocket.CLOSED) {
            await new Promise<void>(resolve => {
                const timeout = setTimeout(() => {
                    socket.terminate()
                    resolve()
                }, 1_000)
                socket.once('close', () => {
                    clearTimeout(timeout)
                    resolve()
                })
                socket.close(1000, 'Gateway shutting down')
            })
        }
        if (this.firstOnline) {
            this.firstOnline.reject(new RelayLinkError('RelayLink stopped before connecting'))
            this.firstOnline = undefined
        }
        this.setState('stopped')
    }

    close(): Promise<void> {
        return this.stop()
    }

    private openConnection(): void {
        if (this.stopping) return
        this.clearReconnectTimer()
        const generation = ++this.generation
        this.connectionEpoch = undefined
        this.secureHandshake = undefined
        this.outgoing = Promise.resolve()
        this.setState('connecting')

        let socket: WebSocket
        try {
            socket = new WebSocket(this.options.url, this.webSocketOptions())
        } catch (error) {
            this.reportError(new RelayLinkError('Unable to create secure Relay WebSocket', { cause: error }))
            this.scheduleReconnect(generation)
            return
        }
        const previous = this.socket
        this.socket = socket
        if (previous && previous !== socket && previous.readyState !== WebSocket.CLOSED) previous.terminate()

        socket.once('open', () => {
            if (!this.isCurrent(generation, socket)) return
            this.setState('authenticating')
            void this.startSecureHandshake(socket).catch(error => this.failConnection(error, generation, socket))
        })
        socket.on('message', data => {
            if (!this.isCurrent(generation, socket)) return
            this.incoming = this.incoming
                .then(() => this.handleMessage(data, generation, socket))
                .catch(error => this.failConnection(error, generation, socket))
        })
        socket.once('error', error => {
            if (this.isCurrent(generation, socket)) {
                this.reportError(new RelayLinkError('Secure Relay WebSocket error', { cause: error }))
            }
        })
        socket.once('close', (code, reason) => {
            if (!this.isCurrent(generation, socket)) return
            this.socket = undefined
            this.connectionEpoch = undefined
            this.secureHandshake = undefined
            this.clearHeartbeatTimer()
            if (!this.stopping) {
                if (code !== 1000) {
                    this.reportError(new RelayLinkError(
                        `Secure Relay connection closed (${code}): ${reason.toString() || 'no reason'}`,
                    ))
                }
                this.scheduleReconnect(generation)
            }
        })
    }

    private async startSecureHandshake(socket: WebSocket): Promise<void> {
        const credential = await this.options.secure.credentialStore.load(this.options.gatewayId)
        this.secureHandshake = new SecureGatewayHandshake({
            gatewayId: this.options.gatewayId,
            ...(this.options.secure.pairingCode ? { pairingCode: this.options.secure.pairingCode } : {}),
            ...(credential ? { credential } : {}),
            createMessageId: () => this.messageId(),
            saveCredential: value => this.options.secure.credentialStore.save(value),
        })
        this.sendWire(await this.secureHandshake.start(), socket)
    }

    private async handleMessage(data: RawData, generation: number, socket: WebSocket): Promise<void> {
        let value: unknown
        try {
            value = JSON.parse(rawDataToString(data))
        } catch (error) {
            throw new RelayLinkError('Secure Relay sent invalid JSON', { cause: error })
        }

        const handshake = this.secureHandshake
        if (!handshake) throw new RelayLinkError('Secure Relay handshake has not started')
        if (!handshake.ready) {
            const output = value && typeof value === 'object' && 'type' in value && value.type === 'secure.data'
                ? await handshake.handleSecureData(value)
                : await handshake.handleHandshake(value)
            if (output) this.sendWire(output, socket)
            if (handshake.ready) await this.acceptSecureConnection(generation, socket)
            return
        }

        const frame = parseGatewayFrame(await handshake.decryptApplication(value))
        if (frame.gatewayId !== this.options.gatewayId || frame.connectionEpoch !== this.connectionEpoch) {
            throw new RelayLinkError('Relay frame belongs to a stale or different secure connection epoch')
        }
        switch (frame.type) {
            case 'device.tunnel.open':
            case 'device.tunnel.data':
            case 'device.tunnel.close':
                await this.processDeviceTunnel(frame)
                return
            default:
                throw new RelayLinkError(`Secure Relay frame type is not allowed: ${frame.type}`)
        }
    }

    private async acceptSecureConnection(generation: number, socket: WebSocket): Promise<void> {
        const accepted = this.secureHandshake?.accepted
        if (!accepted || !this.isCurrent(generation, socket)) {
            throw new RelayLinkError('Secure Relay acceptance is missing')
        }
        this.connectionEpoch = accepted.connectionEpoch
        this.reconnectAttempt = 0
        this.setState('online')
        this.firstOnline?.resolve()
        this.firstOnline = undefined
        this.sendApplicationFrame('gateway.hello', { ...this.options.hello, connectedAt: this.isoNow() })
        await this.sendHeartbeat()
        this.startHeartbeat()
    }

    private async processDeviceTunnel(frame: GatewayDeviceTunnelFrame): Promise<void> {
        const handler = this.options.handleDeviceTunnel
        if (!handler) {
            this.sendDeviceTunnelFrame('device.tunnel.close', {
                tunnelId: frame.payload.tunnelId,
                reason: 'Gateway does not support device tunnels',
            })
            return
        }

        let closed = frame.type === 'device.tunnel.close'
        const close = (reason?: string): void => {
            if (closed) return
            closed = true
            this.sendDeviceTunnelFrame('device.tunnel.close', {
                tunnelId: frame.payload.tunnelId,
                ...(reason ? { reason } : {}),
            })
        }
        try {
            await handler(frame.payload, {
                send: opaquePayload => {
                    if (closed) throw new RelayLinkError(`Device tunnel ${frame.payload.tunnelId} is closed`)
                    this.sendDeviceTunnelFrame('device.tunnel.data', { tunnelId: frame.payload.tunnelId, opaquePayload })
                },
                close,
            })
        } catch (error) {
            this.reportError(new RelayLinkError(`Device tunnel handler failed for ${frame.payload.tunnelId}`, { cause: error }))
            try {
                close(error instanceof Error ? error.message : 'Device tunnel handler failed')
            } catch (closeError) {
                this.reportError(new RelayLinkError(`Failed to close device tunnel ${frame.payload.tunnelId}`, {
                    cause: closeError,
                }))
            }
        }
    }

    private async sendHeartbeat(): Promise<void> {
        if (!this.isOnline()) return
        const heartbeat: Heartbeat = {
            sentAt: this.isoNow(),
            uptimeMs: Math.max(0, this.now() - this.startedAt),
        }
        this.sendApplicationFrame('gateway.heartbeat', heartbeat)
    }

    private startHeartbeat(): void {
        this.clearHeartbeatTimer()
        const interval = this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
        this.heartbeatTimer = setInterval(() => {
            void this.sendHeartbeat().catch(error => this.failCurrentConnection(error))
        }, interval)
        this.heartbeatTimer.unref?.()
    }

    private sendApplicationFrame<TType extends 'gateway.hello' | 'gateway.heartbeat'>(
        type: TType,
        payload: Extract<GatewayFrame, { type: TType }>['payload'],
    ): void {
        this.sendEncrypted({
            version: PROTOCOL_VERSION,
            type,
            messageId: this.messageId(),
            gatewayId: this.options.gatewayId,
            connectionEpoch: this.requireConnectionEpoch(),
            payload,
        } as Extract<GatewayFrame, { type: TType }>)
    }

    private sendDeviceTunnelFrame<TType extends GatewayDeviceTunnelFrame['type']>(
        type: TType,
        payload: Extract<GatewayDeviceTunnelFrame, { type: TType }>['payload'],
    ): void {
        this.sendEncrypted({
            version: PROTOCOL_VERSION,
            type,
            messageId: this.messageId(),
            gatewayId: this.options.gatewayId,
            connectionEpoch: this.requireConnectionEpoch(),
            payload,
        } as Extract<GatewayDeviceTunnelFrame, { type: TType }>)
    }

    private sendEncrypted(frame: GatewayFrame): void {
        const socket = this.socket
        const handshake = this.secureHandshake
        if (!socket || !handshake?.ready) throw new RelayLinkError('Cannot send before secure Relay authentication')
        const validated = parseGatewayFrame(frame)
        this.outgoing = this.outgoing.then(async () => {
            this.sendWire(await handshake.encryptApplication(validated), socket)
        }).catch(error => {
            if (socket === this.socket) {
                this.failCurrentConnection(new RelayLinkError('Failed to encrypt secure Relay frame', { cause: error }))
            }
        })
    }

    private sendWire(value: unknown, socket: WebSocket): void {
        if (socket.readyState !== WebSocket.OPEN) throw new RelayLinkError('Secure Relay WebSocket is not open')
        socket.send(JSON.stringify(value), error => {
            if (error && socket === this.socket) {
                this.failCurrentConnection(new RelayLinkError('Failed to send secure Relay frame', { cause: error }))
            }
        })
    }

    private requireConnectionEpoch(): string {
        if (!this.connectionEpoch) throw new RelayLinkError('Secure Relay connection epoch is missing')
        return this.connectionEpoch
    }

    private failCurrentConnection(error: unknown): void {
        const socket = this.socket
        if (socket) this.failConnection(error, this.generation, socket)
    }

    private failConnection(error: unknown, generation: number, socket: WebSocket): void {
        if (!this.isCurrent(generation, socket)) return
        this.reportError(error instanceof Error ? error : new RelayLinkError(String(error)))
        socket.close(1008, 'Secure Gateway protocol error')
    }

    private scheduleReconnect(generation: number): void {
        if (this.stopping || generation !== this.generation) return
        const reconnect = this.options.reconnect ?? {}
        const initial = reconnect.initialDelayMs ?? DEFAULT_INITIAL_RECONNECT_DELAY_MS
        const maximum = reconnect.maxDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS
        const multiplier = reconnect.multiplier ?? DEFAULT_RECONNECT_MULTIPLIER
        const jitter = reconnect.jitter ?? DEFAULT_RECONNECT_JITTER
        const base = Math.min(maximum, initial * multiplier ** this.reconnectAttempt++)
        const delay = Math.max(0, Math.round(base * (1 + ((Math.random() * 2) - 1) * jitter)))
        this.setState('backing_off')
        this.reconnectTimer = setTimeout(() => this.openConnection(), delay)
        this.reconnectTimer.unref?.()
    }

    private webSocketOptions(): ClientOptions {
        return {
            rejectUnauthorized: this.options.tls?.rejectUnauthorized ?? true,
            ...(this.options.tls?.cert !== undefined ? { cert: this.options.tls.cert } : {}),
            ...(this.options.tls?.key !== undefined ? { key: this.options.tls.key } : {}),
            ...(this.options.tls?.ca !== undefined ? { ca: this.options.tls.ca } : {}),
        }
    }

    private isOnline(): boolean {
        return this.stateValue === 'online'
            && this.socket?.readyState === WebSocket.OPEN
            && this.connectionEpoch !== undefined
            && this.secureHandshake?.ready === true
    }

    private isCurrent(generation: number, socket: WebSocket): boolean {
        return generation === this.generation && socket === this.socket
    }

    private setState(state: RelayLinkState): void {
        if (this.stateValue === state) return
        this.stateValue = state
        this.options.onStateChange?.(state)
    }

    private reportError(error: Error): void {
        this.options.onError?.(error)
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
        this.reconnectTimer = undefined
    }

    private clearHeartbeatTimer(): void {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
        this.heartbeatTimer = undefined
    }

    private now(): number {
        return this.options.now?.() ?? Date.now()
    }

    private isoNow(): string {
        return new Date(this.now()).toISOString()
    }

    private messageId(): string {
        return this.options.createMessageId?.() ?? randomUUID()
    }
}

function validateOptions(options: RelayLinkOptions): void {
    let url: URL
    try {
        url = new URL(options.url)
    } catch (error) {
        throw new RelayLinkError('Relay URL is invalid', { cause: error })
    }
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        throw new RelayLinkError('Relay URL must use ws:// or wss://')
    }
    if (url.pathname !== SECURE_RELAY_PATH) {
        throw new RelayLinkError(`Relay URL must target the secure ${SECURE_RELAY_PATH} endpoint`)
    }
    if (!options.gatewayId.trim()) throw new RelayLinkError('gatewayId is required')
    if (!options.secure?.credentialStore) throw new RelayLinkError('secure credentialStore is required')
    const heartbeat = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    if (!Number.isFinite(heartbeat) || heartbeat <= 0) throw new RelayLinkError('heartbeatIntervalMs must be positive')
    const reconnect = options.reconnect ?? {}
    const initial = reconnect.initialDelayMs ?? DEFAULT_INITIAL_RECONNECT_DELAY_MS
    const maximum = reconnect.maxDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS
    const multiplier = reconnect.multiplier ?? DEFAULT_RECONNECT_MULTIPLIER
    const jitter = reconnect.jitter ?? DEFAULT_RECONNECT_JITTER
    if (initial < 0 || maximum < initial || multiplier < 1 || jitter < 0 || jitter > 1) {
        throw new RelayLinkError('Invalid reconnect backoff options')
    }
}

function rawDataToString(data: RawData): string {
    if (typeof data === 'string') return data
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
    return data.toString('utf8')
}
