import type {
    CommandRequest,
    GatewayHello,
    Heartbeat,
    InventorySnapshot,
    JsonValue,
    ProtocolError,
    SessionEventEnvelope,
} from '@codever/protocol'
import type { GatewayIdentity } from '../identity'
import type { ClientOptions } from 'ws'
import type { GatewaySecureCredentialStore } from './secureCredentialStore'

export type RelayLinkState = 'idle' | 'connecting' | 'authenticating' | 'online' | 'backing_off' | 'stopped'

export interface RelayLinkTlsOptions {
    cert?: ClientOptions['cert']
    key?: ClientOptions['key']
    ca?: ClientOptions['ca']
    rejectUnauthorized?: boolean
}

export interface RelayCommandContext {
    idempotencyKey: string
    signal: AbortSignal
}

export type RelayCommandHandler = (
    request: CommandRequest,
    context: RelayCommandContext,
) => JsonValue | undefined | Promise<JsonValue | undefined>

export interface RelayLinkOptions {
    url: string
    gatewayId: string
    identity: GatewayIdentity
    hello: Omit<GatewayHello, 'connectedAt'>
    getInventory: () => InventorySnapshot | Promise<InventorySnapshot>
    handleCommand: RelayCommandHandler
    loadEventsAfter?: (
        sessionId: string,
        afterSeq: number,
    ) => readonly SessionEventEnvelope[] | Promise<readonly SessionEventEnvelope[]>
    getHeartbeat?: () => Partial<Omit<Heartbeat, 'sentAt' | 'uptimeMs'>> | Promise<Partial<Omit<Heartbeat, 'sentAt' | 'uptimeMs'>>>
    tls?: RelayLinkTlsOptions
    secure?: {
        pairingCode?: string
        credentialStore: GatewaySecureCredentialStore
    }
    heartbeatIntervalMs?: number
    reconnect?: {
        initialDelayMs?: number
        maxDelayMs?: number
        multiplier?: number
        jitter?: number
    }
    maxBatchSize?: number
    onStateChange?: (state: RelayLinkState) => void
    onAck?: (cursors: Readonly<Record<string, number>>) => void
    onError?: (error: Error) => void
    now?: () => number
    createMessageId?: () => string
}

export class RelayCommandError extends Error {
    constructor(
        message: string,
        readonly code = 'command_failed',
        readonly retryable = false,
        readonly status: 'rejected' | 'expired' | 'unknown' = 'rejected',
        readonly details?: ProtocolError['details'],
        options?: ErrorOptions,
    ) {
        super(message, options)
        this.name = 'RelayCommandError'
    }
}

export class RelayLinkError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options)
        this.name = 'RelayLinkError'
    }
}
