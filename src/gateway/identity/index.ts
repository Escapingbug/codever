export {
    GatewayIdentity,
    GatewayIdentityError,
    fingerprintPublicKey,
    initializeGatewayIdentity,
    validateEnrollmentBundle,
    verifyRelayChallengeSignature,
} from './gatewayIdentity'
export {
    GATEWAY_IDENTITY_ALGORITHM,
    GATEWAY_IDENTITY_VERSION,
    type GatewayEnrollmentBundle,
    type GatewayIdentityOptions,
    type RelayAuthenticationChallenge,
    type SignedRelayAuthenticationChallenge,
} from './types'
