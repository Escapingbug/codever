export const GATEWAY_IDENTITY_VERSION = 1 as const
export const GATEWAY_IDENTITY_ALGORITHM = 'ECDSA-P256-SHA256' as const

export interface GatewayEnrollmentBundle {
    version: typeof GATEWAY_IDENTITY_VERSION
    algorithm: typeof GATEWAY_IDENTITY_ALGORITHM
    fingerprint: string
    publicKeySpkiPem: string
}

export interface RelayAuthenticationChallenge {
    version: typeof GATEWAY_IDENTITY_VERSION
    relayId: string
    challengeId: string
    nonce: string
    issuedAt: string
    expiresAt: string
}

export interface SignedRelayAuthenticationChallenge {
    version: typeof GATEWAY_IDENTITY_VERSION
    algorithm: typeof GATEWAY_IDENTITY_ALGORITHM
    fingerprint: string
    signature: string
}

export interface GatewayIdentityOptions {
    directory: string
    privateKeyFilename?: string
}
