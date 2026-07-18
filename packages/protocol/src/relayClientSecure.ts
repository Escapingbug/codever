import { z } from 'zod'
import { IsoDateTimeSchema, OpaqueIdSchema, PROTOCOL_VERSION, parseWithSchema } from './common'
import { SecureEnvelopeSchema } from './secure'

const opaqueMessage = z.string().min(1).max(16_384)
const frame = <TType extends string, TPayload extends z.ZodType>(type: TType, payload: TPayload) => z.object({
    version: z.literal(PROTOCOL_VERSION), type: z.literal(type), messageId: OpaqueIdSchema, payload,
}).strict()

export const ClientRelayAuthStartSchema = z.object({
    mode: z.literal('pairing'),
    credentialId: OpaqueIdSchema,
    subjectId: OpaqueIdSchema,
    startLoginRequest: opaqueMessage,
    natsPublicKey: z.string().regex(/^U[A-Z2-7]{55}$/),
}).strict()
export const RelayClientAuthResponseSchema = z.object({
    relayId: OpaqueIdSchema, handshakeId: OpaqueIdSchema, loginResponse: opaqueMessage,
    expiresAt: IsoDateTimeSchema, attemptsRemaining: z.number().int().nonnegative().optional(),
}).strict()
export const ClientRelayAuthFinishSchema = z.object({
    handshakeId: OpaqueIdSchema, finishLoginRequest: opaqueMessage,
}).strict()
export const RelayClientAuthAcceptedSchema = z.object({
    handshakeId: OpaqueIdSchema, envelope: SecureEnvelopeSchema,
}).strict()
export const RelayClientAuthAcceptedPayloadSchema = z.object({
    relayId: OpaqueIdSchema,
    credentialId: OpaqueIdSchema,
    acceptedAt: IsoDateTimeSchema,
    natsUserJwt: z.string().min(100),
    natsWebSocketUrl: z.url().refine(value => value.startsWith('wss://') || value.startsWith('ws://')),
}).strict()
export const RelayClientAuthRejectedSchema = z.object({
    code: z.enum(['pairing_closed', 'pairing_expired', 'attempts_exhausted', 'invalid_handshake', 'authentication_failed', 'protocol_error']),
    message: z.string().min(1).max(500),
}).strict()

export const ClientRelayAuthStartFrameSchema = frame('client.relay-auth.start', ClientRelayAuthStartSchema)
export const RelayClientAuthResponseFrameSchema = frame('relay.client-auth.response', RelayClientAuthResponseSchema)
export const ClientRelayAuthFinishFrameSchema = frame('client.relay-auth.finish', ClientRelayAuthFinishSchema)
export const RelayClientAuthAcceptedFrameSchema = frame('relay.client-auth.accepted', RelayClientAuthAcceptedSchema)
export const RelayClientAuthRejectedFrameSchema = frame('relay.client-auth.rejected', RelayClientAuthRejectedSchema)
export const RelayClientSecureHandshakeFrameSchema = z.discriminatedUnion('type', [
    ClientRelayAuthStartFrameSchema, RelayClientAuthResponseFrameSchema, ClientRelayAuthFinishFrameSchema,
    RelayClientAuthAcceptedFrameSchema, RelayClientAuthRejectedFrameSchema,
])

export type RelayClientSecureHandshakeFrame = z.infer<typeof RelayClientSecureHandshakeFrameSchema>
export type RelayClientAuthAcceptedPayload = z.infer<typeof RelayClientAuthAcceptedPayloadSchema>

export const parseRelayClientSecureHandshakeFrame = (value: unknown): RelayClientSecureHandshakeFrame =>
    parseWithSchema(RelayClientSecureHandshakeFrameSchema, value)
export const parseRelayClientAuthAcceptedPayload = (value: unknown): RelayClientAuthAcceptedPayload =>
    parseWithSchema(RelayClientAuthAcceptedPayloadSchema, value)
