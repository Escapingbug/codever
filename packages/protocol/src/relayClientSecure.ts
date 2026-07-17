import { z } from 'zod'
import { IsoDateTimeSchema, OpaqueIdSchema, PROTOCOL_VERSION, parseWithSchema } from './common'
import { ClientDeviceTunnelRequestFrameSchema } from './deviceTunnel'
import { GatewaySchema } from './domain'
import { SecureEnvelopeSchema } from './secure'

const opaqueMessage = z.string().min(1).max(16_384)

const relayClientFrame = <TType extends string, TPayload extends z.ZodType>(
    type: TType,
    payload: TPayload,
) => z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal(type),
    messageId: OpaqueIdSchema,
    payload,
}).strict()

export const ClientRelayAuthStartSchema = z.object({
    mode: z.enum(['pairing', 'credential']),
    credentialId: OpaqueIdSchema,
    subjectId: OpaqueIdSchema,
    startLoginRequest: opaqueMessage,
}).strict()

export const RelayClientAuthResponseSchema = z.object({
    relayId: OpaqueIdSchema,
    handshakeId: OpaqueIdSchema,
    loginResponse: opaqueMessage,
    expiresAt: IsoDateTimeSchema,
    attemptsRemaining: z.number().int().nonnegative().optional(),
}).strict()

export const ClientRelayAuthFinishSchema = z.object({
    handshakeId: OpaqueIdSchema,
    finishLoginRequest: opaqueMessage,
}).strict()

export const RelayClientAuthAcceptedSchema = z.object({
    handshakeId: OpaqueIdSchema,
    envelope: SecureEnvelopeSchema,
}).strict()

export const RelayClientAuthAcceptedPayloadSchema = z.object({
    relayId: OpaqueIdSchema,
    credentialId: OpaqueIdSchema,
    acceptedAt: IsoDateTimeSchema,
    provisioningRequired: z.boolean(),
}).strict()

export const RelayClientAuthRejectedSchema = z.object({
    code: z.enum([
        'pairing_closed',
        'pairing_expired',
        'attempts_exhausted',
        'unknown_credential',
        'invalid_handshake',
        'authentication_failed',
        'protocol_error',
    ]),
    message: z.string().min(1).max(500),
}).strict()

export const ClientRelayAuthStartFrameSchema = relayClientFrame(
    'client.relay-auth.start',
    ClientRelayAuthStartSchema,
)
export const RelayClientAuthResponseFrameSchema = relayClientFrame(
    'relay.client-auth.response',
    RelayClientAuthResponseSchema,
)
export const ClientRelayAuthFinishFrameSchema = relayClientFrame(
    'client.relay-auth.finish',
    ClientRelayAuthFinishSchema,
)
export const RelayClientAuthAcceptedFrameSchema = relayClientFrame(
    'relay.client-auth.accepted',
    RelayClientAuthAcceptedSchema,
)
export const RelayClientAuthRejectedFrameSchema = relayClientFrame(
    'relay.client-auth.rejected',
    RelayClientAuthRejectedSchema,
)

export const RelayClientSecureHandshakeFrameSchema = z.discriminatedUnion('type', [
    ClientRelayAuthStartFrameSchema,
    RelayClientAuthResponseFrameSchema,
    ClientRelayAuthFinishFrameSchema,
    RelayClientAuthAcceptedFrameSchema,
    RelayClientAuthRejectedFrameSchema,
])

export const ClientCredentialRegistrationStartSchema = z.object({
    credentialId: OpaqueIdSchema,
    registrationRequest: opaqueMessage,
}).strict()

export const RelayClientCredentialRegistrationResponseSchema = z.object({
    credentialId: OpaqueIdSchema,
    registrationResponse: opaqueMessage,
    serverStaticPublicKey: z.string().min(16).max(16_384),
}).strict()

export const ClientCredentialRegistrationCommitSchema = z.object({
    credentialId: OpaqueIdSchema,
    registrationRecord: opaqueMessage,
}).strict()

export const RelayClientCredentialRegistrationAcceptedSchema = z.object({
    credentialId: OpaqueIdSchema,
    registeredAt: IsoDateTimeSchema,
}).strict()

export const ClientCredentialRegistrationStartFrameSchema = relayClientFrame(
    'client.credential.registration.start',
    ClientCredentialRegistrationStartSchema,
)
export const RelayClientCredentialRegistrationResponseFrameSchema = relayClientFrame(
    'relay.client-credential.registration.response',
    RelayClientCredentialRegistrationResponseSchema,
)
export const ClientCredentialRegistrationCommitFrameSchema = relayClientFrame(
    'client.credential.registration.commit',
    ClientCredentialRegistrationCommitSchema,
)
export const RelayClientCredentialRegistrationAcceptedFrameSchema = relayClientFrame(
    'relay.client-credential.registration.accepted',
    RelayClientCredentialRegistrationAcceptedSchema,
)

export const RelayClientCredentialRegistrationFrameSchema = z.discriminatedUnion('type', [
    ClientCredentialRegistrationStartFrameSchema,
    RelayClientCredentialRegistrationResponseFrameSchema,
    ClientCredentialRegistrationCommitFrameSchema,
    RelayClientCredentialRegistrationAcceptedFrameSchema,
])

export const ClientRelayGatewaysRequestFrameSchema = z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal('client.relay.gateways.request'),
    requestId: OpaqueIdSchema,
}).strict()

export const RelayClientGatewaysResponseFrameSchema = z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal('relay.client.gateways.response'),
    requestId: OpaqueIdSchema,
    gateways: z.array(GatewaySchema),
}).strict()

export const RelayClientSecureControlFrameSchema = z.discriminatedUnion('type', [
    ClientCredentialRegistrationStartFrameSchema,
    RelayClientCredentialRegistrationResponseFrameSchema,
    ClientCredentialRegistrationCommitFrameSchema,
    RelayClientCredentialRegistrationAcceptedFrameSchema,
    ClientRelayGatewaysRequestFrameSchema,
    RelayClientGatewaysResponseFrameSchema,
])

export const ClientRelaySecureDataPayloadSchema = z.union([
    ClientDeviceTunnelRequestFrameSchema,
    RelayClientSecureControlFrameSchema,
])

export type ClientRelayAuthStart = z.infer<typeof ClientRelayAuthStartSchema>
export type RelayClientAuthResponse = z.infer<typeof RelayClientAuthResponseSchema>
export type ClientRelayAuthFinish = z.infer<typeof ClientRelayAuthFinishSchema>
export type RelayClientAuthAccepted = z.infer<typeof RelayClientAuthAcceptedSchema>
export type RelayClientAuthAcceptedPayload = z.infer<typeof RelayClientAuthAcceptedPayloadSchema>
export type RelayClientAuthRejected = z.infer<typeof RelayClientAuthRejectedSchema>
export type ClientRelayAuthStartFrame = z.infer<typeof ClientRelayAuthStartFrameSchema>
export type RelayClientAuthResponseFrame = z.infer<typeof RelayClientAuthResponseFrameSchema>
export type ClientRelayAuthFinishFrame = z.infer<typeof ClientRelayAuthFinishFrameSchema>
export type RelayClientAuthAcceptedFrame = z.infer<typeof RelayClientAuthAcceptedFrameSchema>
export type RelayClientAuthRejectedFrame = z.infer<typeof RelayClientAuthRejectedFrameSchema>
export type RelayClientSecureHandshakeFrame = z.infer<typeof RelayClientSecureHandshakeFrameSchema>
export type ClientCredentialRegistrationStart = z.infer<typeof ClientCredentialRegistrationStartSchema>
export type RelayClientCredentialRegistrationResponse = z.infer<typeof RelayClientCredentialRegistrationResponseSchema>
export type ClientCredentialRegistrationCommit = z.infer<typeof ClientCredentialRegistrationCommitSchema>
export type RelayClientCredentialRegistrationAccepted = z.infer<typeof RelayClientCredentialRegistrationAcceptedSchema>
export type ClientCredentialRegistrationStartFrame = z.infer<typeof ClientCredentialRegistrationStartFrameSchema>
export type RelayClientCredentialRegistrationResponseFrame = z.infer<typeof RelayClientCredentialRegistrationResponseFrameSchema>
export type ClientCredentialRegistrationCommitFrame = z.infer<typeof ClientCredentialRegistrationCommitFrameSchema>
export type RelayClientCredentialRegistrationAcceptedFrame = z.infer<typeof RelayClientCredentialRegistrationAcceptedFrameSchema>
export type RelayClientCredentialRegistrationFrame = z.infer<typeof RelayClientCredentialRegistrationFrameSchema>
export type ClientRelayGatewaysRequestFrame = z.infer<typeof ClientRelayGatewaysRequestFrameSchema>
export type RelayClientGatewaysResponseFrame = z.infer<typeof RelayClientGatewaysResponseFrameSchema>
export type RelayClientSecureControlFrame = z.infer<typeof RelayClientSecureControlFrameSchema>
export type ClientRelaySecureDataPayload = z.infer<typeof ClientRelaySecureDataPayloadSchema>

export const parseRelayClientSecureHandshakeFrame = (value: unknown): RelayClientSecureHandshakeFrame =>
    parseWithSchema(RelayClientSecureHandshakeFrameSchema, value)
export const parseRelayClientAuthAcceptedPayload = (value: unknown): RelayClientAuthAcceptedPayload =>
    parseWithSchema(RelayClientAuthAcceptedPayloadSchema, value)
export const parseRelayClientCredentialRegistrationFrame = (value: unknown): RelayClientCredentialRegistrationFrame =>
    parseWithSchema(RelayClientCredentialRegistrationFrameSchema, value)
export const parseClientRelayGatewaysRequestFrame = (value: unknown): ClientRelayGatewaysRequestFrame =>
    parseWithSchema(ClientRelayGatewaysRequestFrameSchema, value)
export const parseRelayClientGatewaysResponseFrame = (value: unknown): RelayClientGatewaysResponseFrame =>
    parseWithSchema(RelayClientGatewaysResponseFrameSchema, value)
export const parseRelayClientSecureControlFrame = (value: unknown): RelayClientSecureControlFrame =>
    parseWithSchema(RelayClientSecureControlFrameSchema, value)
export const parseClientRelaySecureDataPayload = (value: unknown): ClientRelaySecureDataPayload =>
    parseWithSchema(ClientRelaySecureDataPayloadSchema, value)
