import type { ClientOptions } from 'ws'
import type { GatewaySecureCredentialStore } from './secureCredentialStore'

export type RelayLinkState = 'idle' | 'connecting' | 'authenticating' | 'online' | 'backing_off' | 'stopped'

export interface RelayLinkTlsOptions {
    cert?: ClientOptions['cert']
    key?: ClientOptions['key']
    ca?: ClientOptions['ca']
    rejectUnauthorized?: boolean
}

export interface RelayLinkOptions {
    url: string
    gatewayId: string
    secure: {
        pairingCode?: string
        credentialStore: GatewaySecureCredentialStore
    }
    tls?: RelayLinkTlsOptions
    reconnect?: {
        initialDelayMs?: number
        maxDelayMs?: number
        multiplier?: number
        jitter?: number
    }
    onStateChange?: (state: RelayLinkState) => void
    onError?: (error: Error) => void
    createMessageId?: () => string
}

export class RelayLinkError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options)
        this.name = 'RelayLinkError'
    }
}
