import { randomUUID } from 'node:crypto'
import {
    PROTOCOL_VERSION,
    parseGatewayFrame,
    parseGatewayHandshakeFrame,
    parseSessionEventEnvelope,
    type CommandFailed,
    type GatewayFrame,
    type GatewayHandshakeFrame,
    type Heartbeat,
    type InventorySnapshot,
    type JsonValue,
    type SessionEventEnvelope,
    type SyncRequest,
} from '@codever/protocol'
import WebSocket, { type ClientOptions, type RawData } from 'ws'
import {
    RelayCommandError,
    RelayLinkError,
    type RelayLinkOptions,
    type RelayLinkState,
} from './types'
import { SecureGatewayHandshake } from './secureGatewayHandshake'

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000
const DEFAULT_INITIAL_RECONNECT_DELAY_MS = 250
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000
const DEFAULT_RECONNECT_MULTIPLIER = 2
const DEFAULT_RECONNECT_JITTER = 0.2
const DEFAULT_MAX_BATCH_SIZE = 100

interface CommandLedgerEntry {
    commandId: string
    sessionId: string
    idempotencyKey: string
    acceptedAt?: string
    terminal?:
        | { type: 'command.result'; payload: { commandId: string; completedAt: string; result?: JsonValue } }
        | { type: 'command.failed'; payload: CommandFailed }
}

export class RelayLink {
    private readonly options: RelayLinkOptions
    private readonly startedAt: number
    private readonly pendingEvents = new Map<string, Map<number, SessionEventEnvelope>>()
    private readonly sentInEpoch = new Set<string>()
    private readonly ackCursors = new Map<string, number>()
    private readonly commandLedger = new Map<string, CommandLedgerEntry>()
    private readonly commandAbortControllers = new Set<AbortController>()
    private socket?: WebSocket
    private connectionEpoch?: string
    private stateValue: RelayLinkState = 'idle'
    private generation = 0
    private reconnectAttempt = 0
    private reconnectTimer?: ReturnType<typeof setTimeout>
    private heartbeatTimer?: ReturnType<typeof setInterval>
    private stopping = false
    private authenticationChallengeId?: string
    private incoming = Promise.resolve()
    private firstOnline?: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }
    private latestInventory?: InventorySnapshot
    private secureHandshake?: SecureGatewayHandshake
    private secureOutgoing = Promise.resolve()

    constructor(options: RelayLinkOptions) {
        validateOptions(options)
        this.options = options
        this.startedAt = this.now()
    }

    get state(): RelayLinkState {
        return this.stateValue
    }

    get epoch(): string | undefined {
        return this.connectionEpoch
    }

    get acknowledgedCursors(): Readonly<Record<string, number>> {
        return Object.fromEntries(this.ackCursors)
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

    enqueueEvent(event: SessionEventEnvelope): void {
        this.enqueueEvents([event])
    }

    enqueueEvents(events: readonly SessionEventEnvelope[]): void {
        for (const value of events) {
            const event = parseSessionEventEnvelope(value)
            if (event.gatewayId !== this.options.gatewayId) {
                throw new RelayLinkError(`Cannot enqueue event for gateway ${event.gatewayId}`)
            }
            if (event.seq <= (this.ackCursors.get(event.sessionId) ?? 0)) continue
            let session = this.pendingEvents.get(event.sessionId)
            if (!session) {
                session = new Map()
                this.pendingEvents.set(event.sessionId, session)
            }
            const existing = session.get(event.seq)
            if (existing && existing.eventId !== event.eventId) {
                throw new RelayLinkError(`Conflicting event at ${event.sessionId}:${event.seq}`)
            }
            session.set(event.seq, event)
        }
        this.flushEvents()
    }

    publish(event: SessionEventEnvelope): void {
        this.enqueueEvent(event)
    }

    async refreshInventory(): Promise<void> {
        const inventory = await this.readInventory()
        if (this.isOnline()) this.sendDataFrame('gateway.inventory.snapshot', inventory)
    }

    async stop(): Promise<void> {
        if (this.stateValue === 'stopped') return
        this.stopping = true
        this.generation += 1
        this.clearReconnectTimer()
        this.clearHeartbeatTimer()
        this.connectionEpoch = undefined
        for (const controller of this.commandAbortControllers) controller.abort()
        this.commandAbortControllers.clear()

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
        this.authenticationChallengeId = undefined
        this.secureHandshake = undefined
        this.secureOutgoing = Promise.resolve()
        this.sentInEpoch.clear()
        this.setState('connecting')

        let socket: WebSocket
        try {
            socket = new WebSocket(this.options.url, this.webSocketOptions())
        } catch (error) {
            this.reportError(new RelayLinkError('Unable to create Relay WebSocket', { cause: error }))
            this.scheduleReconnect(generation)
            return
        }
        const previous = this.socket
        this.socket = socket
        if (previous && previous !== socket && previous.readyState !== WebSocket.CLOSED) previous.terminate()

        socket.once('open', () => {
            if (!this.isCurrent(generation, socket)) return
            this.setState('authenticating')
            if (this.options.secure) {
                void this.startSecureHandshake(socket).catch(error => this.failConnection(error, generation, socket))
            }
        })
        socket.on('message', data => {
            if (!this.isCurrent(generation, socket)) return
            this.incoming = this.incoming
                .then(() => this.handleMessage(data, generation, socket))
                .catch(error => this.failConnection(error, generation, socket))
        })
        socket.once('error', error => {
            if (this.isCurrent(generation, socket)) this.reportError(new RelayLinkError('Relay WebSocket error', { cause: error }))
        })
        socket.once('close', (code, reason) => {
            if (!this.isCurrent(generation, socket)) return
            this.socket = undefined
            this.connectionEpoch = undefined
            this.clearHeartbeatTimer()
            if (!this.stopping) {
                if (code !== 1000) this.reportError(new RelayLinkError(`Relay connection closed (${code}): ${reason.toString() || 'no reason'}`))
                this.scheduleReconnect(generation)
            }
        })
    }

    private async handleMessage(data: RawData, generation: number, socket: WebSocket): Promise<void> {
        let value: unknown
        try {
            value = JSON.parse(rawDataToString(data))
        } catch (error) {
            throw new RelayLinkError('Relay sent invalid JSON', { cause: error })
        }

        if (this.options.secure) {
            await this.handleSecureMessage(value, generation, socket)
            return
        }

        if (!this.connectionEpoch) {
            const frame = parseGatewayHandshakeFrame(value)
            await this.handleHandshakeFrame(frame, generation, socket)
            return
        }

        const frame = parseGatewayFrame(value)
        if (frame.gatewayId !== this.options.gatewayId || frame.connectionEpoch !== this.connectionEpoch) {
            throw new RelayLinkError('Relay frame belongs to a stale or different connection epoch')
        }
        switch (frame.type) {
            case 'session.event.ack':
                this.processAck(frame.payload.cursors)
                return
            case 'command.request':
                await this.processCommand(frame)
                return
            case 'sync.request':
                await this.processSyncRequest(frame.payload)
                return
            default:
                throw new RelayLinkError(`Unexpected Relay frame type: ${frame.type}`)
        }
    }

    private async startSecureHandshake(socket: WebSocket): Promise<void> {
        const secure = this.options.secure!
        const credential = await secure.credentialStore.load(this.options.gatewayId)
        this.secureHandshake = new SecureGatewayHandshake({
            gatewayId: this.options.gatewayId,
            ...(secure.pairingCode ? { pairingCode: secure.pairingCode } : {}),
            ...(credential ? { credential } : {}),
            createMessageId: () => this.messageId(),
            saveCredential: value => secure.credentialStore.save(value),
        })
        this.sendWire(await this.secureHandshake.start(), socket)
    }

    private async handleSecureMessage(value: unknown, generation: number, socket: WebSocket): Promise<void> {
        const handshake = this.secureHandshake
        if (!handshake) throw new RelayLinkError('Secure handshake has not started')
        if (!handshake.ready) {
            const input = value && typeof value === 'object' && 'type' in value && value.type === 'secure.data'
                ? await handshake.handleSecureData(value)
                : await handshake.handleHandshake(value)
            if (input) this.sendWire(input, socket)
            if (handshake.ready) await this.acceptSecureConnection(generation, socket)
            return
        }
        const frame = parseGatewayFrame(await handshake.decryptApplication(value))
        if (frame.gatewayId !== this.options.gatewayId || frame.connectionEpoch !== this.connectionEpoch) {
            throw new RelayLinkError('Relay frame belongs to a stale or different secure connection epoch')
        }
        switch (frame.type) {
            case 'session.event.ack':
                this.processAck(frame.payload.cursors)
                return
            case 'command.request':
                await this.processCommand(frame)
                return
            case 'sync.request':
                await this.processSyncRequest(frame.payload)
                return
            default:
                throw new RelayLinkError(`Unexpected secure Relay frame type: ${frame.type}`)
        }
    }

    private async acceptSecureConnection(generation: number, socket: WebSocket): Promise<void> {
        const accepted = this.secureHandshake?.accepted
        if (!accepted || !this.isCurrent(generation, socket)) throw new RelayLinkError('Secure Relay acceptance is missing')
        this.connectionEpoch = accepted.connectionEpoch
        this.reconnectAttempt = 0
        this.sentInEpoch.clear()
        this.setState('online')
        this.firstOnline?.resolve()
        this.firstOnline = undefined
        this.sendDataFrame('gateway.hello', { ...this.options.hello, connectedAt: this.isoNow() })
        await this.refreshInventory()
        await this.sendHeartbeat()
        this.startHeartbeat()
        this.flushEvents()
    }

    private async handleHandshakeFrame(
        frame: GatewayHandshakeFrame,
        generation: number,
        socket: WebSocket,
    ): Promise<void> {
        if (frame.type === 'relay.auth.challenge') {
            if (this.authenticationChallengeId) {
                throw new RelayLinkError('Relay sent more than one authentication challenge')
            }
            if (Date.parse(frame.payload.expiresAt) <= this.now()) {
                throw new RelayLinkError('Relay authentication challenge has expired')
            }
            this.authenticationChallengeId = frame.payload.challengeId
            const signed = this.options.identity.signRelayChallenge({
                version: PROTOCOL_VERSION,
                ...frame.payload,
            }, this.options.gatewayId)
            const response: GatewayHandshakeFrame = {
                version: PROTOCOL_VERSION,
                type: 'gateway.auth.response',
                messageId: this.messageId(),
                payload: {
                    gatewayId: this.options.gatewayId,
                    algorithm: signed.algorithm,
                    fingerprint: signed.fingerprint,
                    signature: signed.signature,
                },
            }
            this.sendRaw(response, socket)
            return
        }
        if (frame.type === 'relay.auth.rejected') {
            const error = new RelayLinkError(`Relay authentication rejected (${frame.payload.code}): ${frame.payload.message}`)
            this.firstOnline?.reject(error)
            this.firstOnline = undefined
            this.reportError(error)
            socket.close(1008, 'Relay authentication rejected')
            return
        }
        if (frame.type !== 'relay.auth.accepted') {
            throw new RelayLinkError(`Unexpected authentication frame: ${frame.type}`)
        }
        if (!this.authenticationChallengeId) {
            throw new RelayLinkError('Relay accepted authentication before issuing a challenge')
        }
        if (frame.payload.gatewayId !== this.options.gatewayId) {
            throw new RelayLinkError('Relay accepted authentication for a different gateway')
        }
        if (!this.isCurrent(generation, socket)) return

        this.connectionEpoch = frame.payload.connectionEpoch
        this.reconnectAttempt = 0
        this.sentInEpoch.clear()
        this.setState('online')
        this.firstOnline?.resolve()
        this.firstOnline = undefined

        this.sendDataFrame('gateway.hello', {
            ...this.options.hello,
            connectedAt: this.isoNow(),
        })
        await this.refreshInventory()
        await this.sendHeartbeat()
        this.startHeartbeat()
        this.flushEvents()
    }

    private processAck(cursors: readonly { sessionId: string; seq: number }[]): void {
        for (const cursor of cursors) {
            const previous = this.ackCursors.get(cursor.sessionId) ?? 0
            if (cursor.seq <= previous) continue
            this.ackCursors.set(cursor.sessionId, cursor.seq)
            const events = this.pendingEvents.get(cursor.sessionId)
            if (events) {
                for (const [seq, event] of events) {
                    if (seq <= cursor.seq) {
                        events.delete(seq)
                        this.sentInEpoch.delete(eventKey(event))
                    }
                }
                if (events.size === 0) this.pendingEvents.delete(cursor.sessionId)
            }
        }
        this.options.onAck?.(this.acknowledgedCursors)
        this.flushEvents()
    }

    private async processCommand(frame: Extract<GatewayFrame, { type: 'command.request' }>): Promise<void> {
        const key = frame.idempotencyKey ?? frame.payload.commandId
        const existing = this.commandLedger.get(key)
        if (existing) {
            if (existing.commandId !== frame.payload.commandId) {
                this.sendCommandFailure(frame.payload.commandId, frame.payload.sessionId, key, new RelayCommandError(
                    'Idempotency key was already used for a different command',
                    'idempotency_conflict',
                ))
                return
            }
            this.replayCommand(existing)
            return
        }

        const entry: CommandLedgerEntry = {
            commandId: frame.payload.commandId,
            sessionId: frame.payload.sessionId,
            idempotencyKey: key,
        }
        this.commandLedger.set(key, entry)
        if (frame.payload.expiresAt && Date.parse(frame.payload.expiresAt) <= this.now()) {
            const error = new RelayCommandError('Command expired before Gateway acceptance', 'command_expired', false, 'expired')
            entry.terminal = this.failedTerminal(entry.commandId, error)
            this.replayCommand(entry)
            return
        }

        entry.acceptedAt = this.isoNow()
        this.replayCommand(entry)
        const controller = new AbortController()
        this.commandAbortControllers.add(controller)
        try {
            const result = await this.options.handleCommand(frame.payload, { idempotencyKey: key, signal: controller.signal })
            entry.terminal = {
                type: 'command.result',
                payload: {
                    commandId: entry.commandId,
                    completedAt: this.isoNow(),
                    ...(result !== undefined ? { result } : {}),
                },
            }
        } catch (error) {
            entry.terminal = this.failedTerminal(entry.commandId, normalizeCommandError(error))
        } finally {
            this.commandAbortControllers.delete(controller)
        }
        this.replayCommand(entry)
    }

    private replayCommand(entry: CommandLedgerEntry): void {
        if (!this.isOnline()) return
        if (entry.acceptedAt) {
            this.sendDataFrame('command.accepted', {
                commandId: entry.commandId,
                acceptedAt: entry.acceptedAt,
            }, entry.sessionId, entry.idempotencyKey)
        }
        if (entry.terminal) {
            this.sendDataFrame(entry.terminal.type, entry.terminal.payload, entry.sessionId, entry.idempotencyKey)
        }
    }

    private sendCommandFailure(commandId: string, sessionId: string, key: string, error: RelayCommandError): void {
        const terminal = this.failedTerminal(commandId, error)
        this.sendDataFrame(terminal.type, terminal.payload, sessionId, key)
    }

    private failedTerminal(commandId: string, error: RelayCommandError): Extract<CommandLedgerEntry['terminal'], { type: 'command.failed' }> {
        return {
            type: 'command.failed',
            payload: {
                commandId,
                failedAt: this.isoNow(),
                status: error.status,
                error: {
                    code: error.code,
                    message: error.message,
                    retryable: error.retryable,
                    ...(error.details ? { details: error.details } : {}),
                },
            },
        }
    }

    private async processSyncRequest(request: SyncRequest): Promise<void> {
        if (request.includeInventory) await this.refreshInventory()
        const replayEvents: SessionEventEnvelope[] = []
        if (this.options.loadEventsAfter) {
            const loaded = await Promise.all(request.cursors.map(cursor => this.options.loadEventsAfter!(cursor.sessionId, cursor.afterSeq)))
            for (let index = 0; index < loaded.length; index += 1) {
                const cursor = request.cursors[index]!
                for (const value of loaded[index]!) {
                    const event = parseSessionEventEnvelope(value)
                    if (event.gatewayId !== this.options.gatewayId || event.sessionId !== cursor.sessionId || event.seq <= cursor.afterSeq) {
                        throw new RelayLinkError(`Journal returned an invalid sync event for ${cursor.sessionId}`)
                    }
                    replayEvents.push(event)
                }
            }
        } else {
            for (const cursor of request.cursors) {
                for (const event of this.pendingEvents.get(cursor.sessionId)?.values() ?? []) {
                    if (event.seq > cursor.afterSeq) replayEvents.push(event)
                }
            }
        }
        replayEvents.sort((left, right) => left.sessionId.localeCompare(right.sessionId) || left.seq - right.seq)
        this.sendEventBatches(replayEvents, false)
        this.flushEvents()

        const cursors = request.cursors.map(cursor => {
            const queued = this.pendingEvents.get(cursor.sessionId)
            const highestQueued = queued?.size ? Math.max(...queued.keys()) : 0
            const replayedForSession = replayEvents.filter(event => event.sessionId === cursor.sessionId)
            const highestReplayed = replayedForSession.length ? Math.max(...replayedForSession.map(event => event.seq)) : 0
            return {
                sessionId: cursor.sessionId,
                seq: Math.max(cursor.afterSeq, this.ackCursors.get(cursor.sessionId) ?? 0, highestQueued, highestReplayed),
            }
        })
        this.sendDataFrame('sync.complete', {
            completedAt: this.isoNow(),
            inventoryRevision: this.latestInventory?.revision ?? 0,
            cursors,
        })
    }

    private flushEvents(): void {
        if (!this.isOnline()) return
        const unsent = [...this.pendingEvents.values()]
            .flatMap(events => [...events.values()])
            .filter(event => !this.sentInEpoch.has(eventKey(event)))
            .sort((left, right) => left.sessionId.localeCompare(right.sessionId) || left.seq - right.seq)
        const batchSize = this.options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE
        this.sendEventBatches(unsent, true, batchSize)
    }

    private sendEventBatches(
        events: readonly SessionEventEnvelope[],
        markSent: boolean,
        batchSize = this.options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
    ): void {
        for (let offset = 0; offset < events.length; offset += batchSize) {
            const batch = events.slice(offset, offset + batchSize)
            this.sendDataFrame('session.event.batch', { events: batch })
            if (markSent) for (const event of batch) this.sentInEpoch.add(eventKey(event))
        }
    }

    private async sendHeartbeat(): Promise<void> {
        if (!this.isOnline()) return
        const supplied = await this.options.getHeartbeat?.() ?? {}
        const inventory = this.latestInventory
        const sessionStates = supplied.sessionStates ?? Object.fromEntries(
            (inventory?.sessions ?? []).map(session => [session.id, session.state]),
        )
        const heartbeat: Heartbeat = {
            sentAt: this.isoNow(),
            uptimeMs: Math.max(0, this.now() - this.startedAt),
            inventoryRevision: supplied.inventoryRevision ?? inventory?.revision ?? 0,
            sessionStates,
        }
        this.sendDataFrame('gateway.heartbeat', heartbeat)
    }

    private startHeartbeat(): void {
        this.clearHeartbeatTimer()
        const interval = this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
        this.heartbeatTimer = setInterval(() => {
            void this.sendHeartbeat().catch(error => this.failCurrentConnection(error))
        }, interval)
        this.heartbeatTimer.unref?.()
    }

    private async readInventory(): Promise<InventorySnapshot> {
        const inventory = await this.options.getInventory()
        if (inventory.projects.some(project => project.gatewayId !== this.options.gatewayId)) {
            throw new RelayLinkError('Inventory contains a project owned by another gateway')
        }
        if (inventory.sessions.some(session => session.gatewayId !== this.options.gatewayId)) {
            throw new RelayLinkError('Inventory contains a session owned by another gateway')
        }
        this.latestInventory = inventory
        return inventory
    }

    private sendDataFrame<TType extends GatewayFrame['type']>(
        type: TType,
        payload: Extract<GatewayFrame, { type: TType }>['payload'],
        sessionId?: string,
        idempotencyKey?: string,
    ): void {
        if (!this.connectionEpoch || !this.socket) throw new RelayLinkError('Cannot send data before Relay authentication')
        const frame = {
            version: PROTOCOL_VERSION,
            type,
            messageId: this.messageId(),
            gatewayId: this.options.gatewayId,
            connectionEpoch: this.connectionEpoch,
            ...(sessionId ? { sessionId } : {}),
            ...(idempotencyKey ? { idempotencyKey } : {}),
            payload,
        } as Extract<GatewayFrame, { type: TType }>
        this.sendRaw(frame, this.socket)
    }

    private sendRaw(frame: GatewayFrame | GatewayHandshakeFrame, socket: WebSocket): void {
        if (socket.readyState !== WebSocket.OPEN) throw new RelayLinkError('Relay WebSocket is not open')
        if (this.options.secure && 'gatewayId' in frame) {
            const validated = parseGatewayFrame(frame)
            this.secureOutgoing = this.secureOutgoing.then(async () => {
                const wire = await this.secureHandshake!.encryptApplication(validated)
                this.sendWire(wire, socket)
            }).catch(error => {
                if (socket === this.socket) this.failCurrentConnection(new RelayLinkError('Failed to encrypt Relay frame', { cause: error }))
            })
            return
        }
        const validated = 'gatewayId' in frame
            ? parseGatewayFrame(frame)
            : parseGatewayHandshakeFrame(frame)
        socket.send(JSON.stringify(validated), error => {
            if (error && socket === this.socket) this.failCurrentConnection(new RelayLinkError('Failed to send Relay frame', { cause: error }))
        })
    }

    private sendWire(value: unknown, socket: WebSocket): void {
        if (socket.readyState !== WebSocket.OPEN) throw new RelayLinkError('Relay WebSocket is not open')
        socket.send(JSON.stringify(value), error => {
            if (error && socket === this.socket) this.failCurrentConnection(new RelayLinkError('Failed to send secure Relay frame', { cause: error }))
        })
    }

    private failCurrentConnection(error: unknown): void {
        const socket = this.socket
        if (socket) this.failConnection(error, this.generation, socket)
    }

    private failConnection(error: unknown, generation: number, socket: WebSocket): void {
        if (!this.isCurrent(generation, socket)) return
        this.reportError(error instanceof Error ? error : new RelayLinkError(String(error)))
        socket.close(1008, 'Gateway protocol error')
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
    if (!options.gatewayId.trim()) throw new RelayLinkError('gatewayId is required')
    const heartbeat = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    if (!Number.isFinite(heartbeat) || heartbeat <= 0) throw new RelayLinkError('heartbeatIntervalMs must be positive')
    const batch = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE
    if (!Number.isSafeInteger(batch) || batch <= 0) throw new RelayLinkError('maxBatchSize must be a positive integer')
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

function eventKey(event: SessionEventEnvelope): string {
    return `${event.sessionId}\0${event.seq}\0${event.eventId}`
}

function normalizeCommandError(error: unknown): RelayCommandError {
    if (error instanceof RelayCommandError) return error
    return new RelayCommandError(
        error instanceof Error ? error.message : String(error),
        'command_failed',
        false,
        'rejected',
        undefined,
        error instanceof Error ? { cause: error } : undefined,
    )
}
