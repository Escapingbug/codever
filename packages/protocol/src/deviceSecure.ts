import { z } from 'zod'
import { IsoDateTimeSchema, OpaqueIdSchema, PROTOCOL_VERSION, parseWithSchema } from './common'
import { SecureEnvelopeSchema } from './secure'

const deviceSecureFrame = <TType extends string, TPayload extends z.ZodType>(
    type: TType,
    payload: TPayload,
) => z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal(type),
    messageId: OpaqueIdSchema,
    payload,
}).strict()

const opaqueMessage = z.string().min(1).max(16_384)

export const ClientSecureAuthStartSchema = z.object({
    mode: z.enum(['pairing', 'credential']),
    credentialId: OpaqueIdSchema,
    subjectId: OpaqueIdSchema,
    startLoginRequest: opaqueMessage,
}).strict()

export const GatewaySecureAuthResponseSchema = z.object({
    gatewayId: OpaqueIdSchema,
    handshakeId: OpaqueIdSchema,
    loginResponse: opaqueMessage,
    expiresAt: IsoDateTimeSchema,
    attemptsRemaining: z.number().int().nonnegative().optional(),
}).strict()

export const ClientSecureAuthFinishSchema = z.object({
    handshakeId: OpaqueIdSchema,
    finishLoginRequest: opaqueMessage,
}).strict()

export const GatewaySecureAuthAcceptedSchema = z.object({
    handshakeId: OpaqueIdSchema,
    envelope: SecureEnvelopeSchema,
}).strict()

export const GatewaySecureAuthAcceptedPayloadSchema = z.object({
    gatewayId: OpaqueIdSchema,
    credentialId: OpaqueIdSchema,
    acceptedAt: IsoDateTimeSchema,
    credentialProvisioningRequired: z.boolean(),
}).strict()

export const GatewaySecureAuthRejectedSchema = z.object({
    code: z.enum([
        'pairing_closed',
        'pairing_expired',
        'attempts_exhausted',
        'unknown_device',
        'invalid_handshake',
        'authentication_failed',
        'protocol_error',
    ]),
    message: z.string().min(1).max(500),
}).strict()

export const ClientSecureAuthStartFrameSchema = deviceSecureFrame(
    'client.secure-auth.start',
    ClientSecureAuthStartSchema,
)
export const GatewaySecureAuthResponseFrameSchema = deviceSecureFrame(
    'gateway.secure-auth.response',
    GatewaySecureAuthResponseSchema,
)
export const ClientSecureAuthFinishFrameSchema = deviceSecureFrame(
    'client.secure-auth.finish',
    ClientSecureAuthFinishSchema,
)
export const GatewaySecureAuthAcceptedFrameSchema = deviceSecureFrame(
    'gateway.secure-auth.accepted',
    GatewaySecureAuthAcceptedSchema,
)
export const GatewaySecureAuthRejectedFrameSchema = deviceSecureFrame(
    'gateway.secure-auth.rejected',
    GatewaySecureAuthRejectedSchema,
)

export const DeviceSecureHandshakeFrameSchema = z.discriminatedUnion('type', [
    ClientSecureAuthStartFrameSchema,
    GatewaySecureAuthResponseFrameSchema,
    ClientSecureAuthFinishFrameSchema,
    GatewaySecureAuthAcceptedFrameSchema,
    GatewaySecureAuthRejectedFrameSchema,
])

export const DeviceCredentialRegistrationStartSchema = z.object({
    deviceId: OpaqueIdSchema,
    registrationRequest: opaqueMessage,
}).strict()

export const DeviceCredentialRegistrationResponseSchema = z.object({
    deviceId: OpaqueIdSchema,
    registrationResponse: opaqueMessage,
    serverStaticPublicKey: z.string().min(16),
}).strict()

export const DeviceCredentialRegistrationCommitSchema = z.object({
    deviceId: OpaqueIdSchema,
    registrationRecord: opaqueMessage,
}).strict()

export const DeviceCredentialRegistrationAcceptedSchema = z.object({
    deviceId: OpaqueIdSchema,
    registeredAt: IsoDateTimeSchema,
}).strict()

export const DeviceCredentialRegistrationStartFrameSchema = deviceSecureFrame(
    'device.credential.registration.start',
    DeviceCredentialRegistrationStartSchema,
)
export const DeviceCredentialRegistrationResponseFrameSchema = deviceSecureFrame(
    'device.credential.registration.response',
    DeviceCredentialRegistrationResponseSchema,
)
export const DeviceCredentialRegistrationCommitFrameSchema = deviceSecureFrame(
    'device.credential.registration.commit',
    DeviceCredentialRegistrationCommitSchema,
)
export const DeviceCredentialRegistrationAcceptedFrameSchema = deviceSecureFrame(
    'device.credential.registration.accepted',
    DeviceCredentialRegistrationAcceptedSchema,
)

export const DeviceCredentialFrameSchema = z.discriminatedUnion('type', [
    DeviceCredentialRegistrationStartFrameSchema,
    DeviceCredentialRegistrationResponseFrameSchema,
    DeviceCredentialRegistrationCommitFrameSchema,
    DeviceCredentialRegistrationAcceptedFrameSchema,
])

export type ClientSecureAuthStart = z.infer<typeof ClientSecureAuthStartSchema>
export type GatewaySecureAuthResponse = z.infer<typeof GatewaySecureAuthResponseSchema>
export type ClientSecureAuthFinish = z.infer<typeof ClientSecureAuthFinishSchema>
export type GatewaySecureAuthAccepted = z.infer<typeof GatewaySecureAuthAcceptedSchema>
export type GatewaySecureAuthAcceptedPayload = z.infer<typeof GatewaySecureAuthAcceptedPayloadSchema>
export type GatewaySecureAuthRejected = z.infer<typeof GatewaySecureAuthRejectedSchema>
export type ClientSecureAuthStartFrame = z.infer<typeof ClientSecureAuthStartFrameSchema>
export type GatewaySecureAuthResponseFrame = z.infer<typeof GatewaySecureAuthResponseFrameSchema>
export type ClientSecureAuthFinishFrame = z.infer<typeof ClientSecureAuthFinishFrameSchema>
export type GatewaySecureAuthAcceptedFrame = z.infer<typeof GatewaySecureAuthAcceptedFrameSchema>
export type GatewaySecureAuthRejectedFrame = z.infer<typeof GatewaySecureAuthRejectedFrameSchema>
export type DeviceSecureHandshakeFrame = z.infer<typeof DeviceSecureHandshakeFrameSchema>
export type DeviceCredentialRegistrationStart = z.infer<typeof DeviceCredentialRegistrationStartSchema>
export type DeviceCredentialRegistrationResponse = z.infer<typeof DeviceCredentialRegistrationResponseSchema>
export type DeviceCredentialRegistrationCommit = z.infer<typeof DeviceCredentialRegistrationCommitSchema>
export type DeviceCredentialRegistrationAccepted = z.infer<typeof DeviceCredentialRegistrationAcceptedSchema>
export type DeviceCredentialFrame = z.infer<typeof DeviceCredentialFrameSchema>

export const parseDeviceSecureHandshakeFrame = (value: unknown): DeviceSecureHandshakeFrame =>
    parseWithSchema(DeviceSecureHandshakeFrameSchema, value)
export const parseDeviceCredentialFrame = (value: unknown): DeviceCredentialFrame =>
    parseWithSchema(DeviceCredentialFrameSchema, value)
export const parseGatewaySecureAuthAcceptedPayload = (value: unknown): GatewaySecureAuthAcceptedPayload =>
    parseWithSchema(GatewaySecureAuthAcceptedPayloadSchema, value)
