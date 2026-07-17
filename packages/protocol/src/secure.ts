import { z } from 'zod'
import { IsoDateTimeSchema, OpaqueIdSchema, PROTOCOL_VERSION, parseWithSchema } from './common'

export const SecureEnvelopeSchema = z.object({
    version: z.literal(1),
    channelId: OpaqueIdSchema,
    sequence: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
    ciphertext: z.string().regex(/^[A-Za-z0-9_-]+$/).min(16),
}).strict()

export const GatewaySecureAuthStartSchema = z.object({
    gatewayId: OpaqueIdSchema,
    mode: z.enum(['pairing', 'credential']),
    subjectId: OpaqueIdSchema,
    startLoginRequest: z.string().min(1).max(16_384),
}).strict()

export const RelaySecureAuthResponseSchema = z.object({
    relayId: OpaqueIdSchema,
    handshakeId: OpaqueIdSchema,
    loginResponse: z.string().min(1).max(16_384),
    expiresAt: IsoDateTimeSchema,
    attemptsRemaining: z.number().int().nonnegative().optional(),
}).strict()

export const GatewaySecureAuthFinishSchema = z.object({
    handshakeId: OpaqueIdSchema,
    finishLoginRequest: z.string().min(1).max(16_384),
}).strict()

export const RelaySecureAuthAcceptedPayloadSchema = z.object({
    gatewayId: OpaqueIdSchema,
    connectionEpoch: OpaqueIdSchema,
    acceptedAt: IsoDateTimeSchema,
    credentialProvisioningRequired: z.boolean(),
}).strict()

export const RelaySecureAuthAcceptedSchema = z.object({
    handshakeId: OpaqueIdSchema,
    envelope: SecureEnvelopeSchema,
}).strict()

export const RelaySecureAuthRejectedSchema = z.object({
    code: z.enum([
        'pairing_closed',
        'pairing_expired',
        'attempts_exhausted',
        'unknown_gateway',
        'invalid_handshake',
        'authentication_failed',
        'protocol_error',
    ]),
    message: z.string().min(1).max(500),
}).strict()

const secureHandshakeFrame = <TType extends string, TPayload extends z.ZodType>(type: TType, payload: TPayload) => z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal(type),
    messageId: OpaqueIdSchema,
    payload,
}).strict()

export const GatewaySecureAuthStartFrameSchema = secureHandshakeFrame('gateway.secure-auth.start', GatewaySecureAuthStartSchema)
export const RelaySecureAuthResponseFrameSchema = secureHandshakeFrame('relay.secure-auth.response', RelaySecureAuthResponseSchema)
export const GatewaySecureAuthFinishFrameSchema = secureHandshakeFrame('gateway.secure-auth.finish', GatewaySecureAuthFinishSchema)
export const RelaySecureAuthAcceptedFrameSchema = secureHandshakeFrame('relay.secure-auth.accepted', RelaySecureAuthAcceptedSchema)
export const RelaySecureAuthRejectedFrameSchema = secureHandshakeFrame('relay.secure-auth.rejected', RelaySecureAuthRejectedSchema)

export const GatewaySecureHandshakeFrameSchema = z.discriminatedUnion('type', [
    GatewaySecureAuthStartFrameSchema,
    RelaySecureAuthResponseFrameSchema,
    GatewaySecureAuthFinishFrameSchema,
    RelaySecureAuthAcceptedFrameSchema,
    RelaySecureAuthRejectedFrameSchema,
])

export const SecureDataFrameSchema = z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal('secure.data'),
    messageId: OpaqueIdSchema,
    envelope: SecureEnvelopeSchema,
}).strict()

const secureControl = <TType extends string, TPayload extends z.ZodType>(type: TType, payload: TPayload) => z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal(type),
    messageId: OpaqueIdSchema,
    payload,
}).strict()

export const GatewayCredentialRegistrationStartFrameSchema = secureControl('gateway.credential.registration.start', z.object({
    gatewayId: OpaqueIdSchema,
    registrationRequest: z.string().min(1).max(16_384),
}).strict())
export const RelayCredentialRegistrationResponseFrameSchema = secureControl('relay.credential.registration.response', z.object({
    gatewayId: OpaqueIdSchema,
    registrationResponse: z.string().min(1).max(16_384),
    serverStaticPublicKey: z.string().min(16),
}).strict())
export const GatewayCredentialRegistrationCommitFrameSchema = secureControl('gateway.credential.registration.commit', z.object({
    gatewayId: OpaqueIdSchema,
    registrationRecord: z.string().min(1).max(16_384),
}).strict())
export const RelayCredentialRegistrationAcceptedFrameSchema = secureControl('relay.credential.registration.accepted', z.object({
    gatewayId: OpaqueIdSchema,
    registeredAt: IsoDateTimeSchema,
}).strict())

export const SecureControlFrameSchema = z.discriminatedUnion('type', [
    GatewayCredentialRegistrationStartFrameSchema,
    RelayCredentialRegistrationResponseFrameSchema,
    GatewayCredentialRegistrationCommitFrameSchema,
    RelayCredentialRegistrationAcceptedFrameSchema,
])

export type SecureEnvelope = z.infer<typeof SecureEnvelopeSchema>
export type GatewaySecureAuthStart = z.infer<typeof GatewaySecureAuthStartSchema>
export type RelaySecureAuthResponse = z.infer<typeof RelaySecureAuthResponseSchema>
export type GatewaySecureAuthFinish = z.infer<typeof GatewaySecureAuthFinishSchema>
export type RelaySecureAuthAcceptedPayload = z.infer<typeof RelaySecureAuthAcceptedPayloadSchema>
export type RelaySecureAuthAccepted = z.infer<typeof RelaySecureAuthAcceptedSchema>
export type RelaySecureAuthRejected = z.infer<typeof RelaySecureAuthRejectedSchema>
export type GatewaySecureHandshakeFrame = z.infer<typeof GatewaySecureHandshakeFrameSchema>
export type SecureDataFrame = z.infer<typeof SecureDataFrameSchema>
export type SecureControlFrame = z.infer<typeof SecureControlFrameSchema>

export const parseSecureEnvelope = (value: unknown): SecureEnvelope => parseWithSchema(SecureEnvelopeSchema, value)
export const parseGatewaySecureHandshakeFrame = (value: unknown): GatewaySecureHandshakeFrame => parseWithSchema(GatewaySecureHandshakeFrameSchema, value)
export const parseSecureDataFrame = (value: unknown): SecureDataFrame => parseWithSchema(SecureDataFrameSchema, value)
export const parseSecureControlFrame = (value: unknown): SecureControlFrame => parseWithSchema(SecureControlFrameSchema, value)
export const parseRelaySecureAuthAcceptedPayload = (value: unknown): RelaySecureAuthAcceptedPayload => parseWithSchema(RelaySecureAuthAcceptedPayloadSchema, value)
