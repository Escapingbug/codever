import { z } from 'zod'
import { IsoDateTimeSchema, OpaqueIdSchema, PROTOCOL_VERSION, parseWithSchema } from './common'

export const SecureEnvelopeSchema = z.object({
    version: z.literal(2),
    channelId: OpaqueIdSchema,
    messageId: OpaqueIdSchema,
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    ciphertext: z.string().regex(/^[A-Za-z0-9_-]+$/).min(16),
}).strict()

export const HpkeEnvelopeSchema = z.object({
    version: z.literal(1),
    suite: z.literal('DHKEM_X25519_HKDF_SHA256_HKDF_SHA256_AES_128_GCM'),
    messageId: OpaqueIdSchema,
    senderId: OpaqueIdSchema,
    recipientId: OpaqueIdSchema,
    senderKeyId: OpaqueIdSchema,
    recipientKeyId: OpaqueIdSchema,
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    enc: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    ciphertext: z.string().regex(/^[A-Za-z0-9_-]+$/).min(16),
}).strict().refine(value => Date.parse(value.expiresAt) > Date.parse(value.createdAt), {
    message: 'expiresAt must be after createdAt',
})

export const GatewaySecureAuthStartSchema = z.object({
    gatewayId: OpaqueIdSchema,
    mode: z.literal('pairing'),
    subjectId: OpaqueIdSchema,
    startLoginRequest: z.string().min(1).max(16_384),
    natsPublicKey: z.string().regex(/^U[A-Z2-7]{55}$/),
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
    acceptedAt: IsoDateTimeSchema,
    natsUserJwt: z.string().min(100),
    natsUrl: z.url().refine(value => value.startsWith('nats://') || value.startsWith('tls://')),
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


export type SecureEnvelope = z.infer<typeof SecureEnvelopeSchema>
export type HpkeEnvelope = z.infer<typeof HpkeEnvelopeSchema>
export type GatewaySecureAuthStart = z.infer<typeof GatewaySecureAuthStartSchema>
export type RelaySecureAuthResponse = z.infer<typeof RelaySecureAuthResponseSchema>
export type GatewaySecureAuthFinish = z.infer<typeof GatewaySecureAuthFinishSchema>
export type RelaySecureAuthAcceptedPayload = z.infer<typeof RelaySecureAuthAcceptedPayloadSchema>
export type RelaySecureAuthAccepted = z.infer<typeof RelaySecureAuthAcceptedSchema>
export type RelaySecureAuthRejected = z.infer<typeof RelaySecureAuthRejectedSchema>
export type GatewaySecureHandshakeFrame = z.infer<typeof GatewaySecureHandshakeFrameSchema>
export type SecureDataFrame = z.infer<typeof SecureDataFrameSchema>

export const parseSecureEnvelope = (value: unknown): SecureEnvelope => parseWithSchema(SecureEnvelopeSchema, value)
export const parseHpkeEnvelope = (value: unknown): HpkeEnvelope => parseWithSchema(HpkeEnvelopeSchema, value)
export const parseGatewaySecureHandshakeFrame = (value: unknown): GatewaySecureHandshakeFrame => parseWithSchema(GatewaySecureHandshakeFrameSchema, value)
export const parseSecureDataFrame = (value: unknown): SecureDataFrame => parseWithSchema(SecureDataFrameSchema, value)
export const parseRelaySecureAuthAcceptedPayload = (value: unknown): RelaySecureAuthAcceptedPayload => parseWithSchema(RelaySecureAuthAcceptedPayloadSchema, value)
