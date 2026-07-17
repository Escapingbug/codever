import type {
    GatewayDeviceTunnelClosePayload,
    GatewayDeviceTunnelDataPayload,
    GatewayDeviceTunnelOpenPayload,
    GatewayHello,
} from '@codever/protocol'
import type { ClientOptions } from 'ws'
import type { GatewaySecureCredentialStore } from './secureCredentialStore'

export type RelayLinkState = 'idle' | 'connecting' | 'authenticating' | 'online' | 'backing_off' | 'stopped'

export interface RelayLinkTlsOptions {
    cert?: ClientOptions['cert']
    key?: ClientOptions['key']
    ca?: ClientOptions['ca']
    rejectUnauthorized?: boolean
}

export type DeviceTunnelFramePayload =
    | GatewayDeviceTunnelOpenPayload
    | GatewayDeviceTunnelDataPayload
    | GatewayDeviceTunnelClosePayload

export interface DeviceTunnelActions {
    send: (opaquePayload: GatewayDeviceTunnelDataPayload['opaquePayload']) => void
    close: (reason?: string) => void
}

export type DeviceTunnelHandler = (
    payload: DeviceTunnelFramePayload,
    actions: DeviceTunnelActions,
) => void | Promise<void>

export interface RelayLinkOptions {
    url: string
    gatewayId: string
    hello: Omit<GatewayHello, 'connectedAt'>
    secure: {
        pairingCode?: string
        credentialStore: GatewaySecureCredentialStore
    }
    handleDeviceTunnel?: DeviceTunnelHandler
    heartbeatIntervalMs?: number
    tls?: RelayLinkTlsOptions
    reconnect?: {
        initialDelayMs?: number
        maxDelayMs?: number
        multiplier?: number
        jitter?: number
    }
    onStateChange?: (state: RelayLinkState) => void
    onError?: (error: Error) => void
    now?: () => number
    createMessageId?: () => string
}

export class RelayLinkError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options)
        this.name = 'RelayLinkError'
    }
}
