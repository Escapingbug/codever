import { z } from 'zod'
import { IsoDateTimeSchema, OpaqueIdSchema, PROTOCOL_VERSION, parseWithSchema } from './common'
import { HpkeEnvelopeSchema, SecureEnvelopeSchema } from './secure'

const frame = <TType extends string, TPayload extends z.ZodType>(type: TType, payload: TPayload) => z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal(type),
    messageId: OpaqueIdSchema,
    payload,
}).strict()

const opaqueMessage = z.string().min(1).max(16_384)
const hpkePublicKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

export const ClientSecureAuthStartSchema = z.object({
    credentialId: OpaqueIdSchema,
    pairingId: OpaqueIdSchema,
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

export const GatewaySecureAuthAcceptedPayloadSchema = z.object({
    gatewayId: OpaqueIdSchema,
    credentialId: OpaqueIdSchema,
    acceptedAt: IsoDateTimeSchema,
    gatewayHpkePublicKey: hpkePublicKey,
    gatewayHpkeKeyId: OpaqueIdSchema,
}).strict()

export const GatewaySecureAuthAcceptedSchema = z.object({
    handshakeId: OpaqueIdSchema,
    envelope: SecureEnvelopeSchema,
}).strict()

export const GatewaySecureAuthRejectedSchema = z.object({
    code: z.enum([
        'pairing_closed', 'pairing_expired', 'attempts_exhausted',
        'invalid_handshake', 'authentication_failed', 'protocol_error',
    ]),
    message: z.string().min(1).max(500),
}).strict()

export const ClientSecureAuthStartFrameSchema = frame('client.secure-auth.start', ClientSecureAuthStartSchema)
export const GatewaySecureAuthResponseFrameSchema = frame('gateway.secure-auth.response', GatewaySecureAuthResponseSchema)
export const ClientSecureAuthFinishFrameSchema = frame('client.secure-auth.finish', ClientSecureAuthFinishSchema)
export const GatewaySecureAuthAcceptedFrameSchema = frame('gateway.secure-auth.accepted', GatewaySecureAuthAcceptedSchema)
export const GatewaySecureAuthRejectedFrameSchema = frame('gateway.secure-auth.rejected', GatewaySecureAuthRejectedSchema)

export const DeviceSecureHandshakeFrameSchema = z.discriminatedUnion('type', [
    ClientSecureAuthStartFrameSchema,
    GatewaySecureAuthResponseFrameSchema,
    ClientSecureAuthFinishFrameSchema,
    GatewaySecureAuthAcceptedFrameSchema,
    GatewaySecureAuthRejectedFrameSchema,
])

export const DeviceKeyRegisterFrameSchema = frame('device.key.register', z.object({
    deviceId: OpaqueIdSchema,
    deviceHpkePublicKey: hpkePublicKey,
    deviceHpkeKeyId: OpaqueIdSchema,
}).strict())

export const GatewayKeyRegisteredFrameSchema = frame('gateway.key.registered', z.object({
    deviceId: OpaqueIdSchema,
    gatewayHpkePublicKey: hpkePublicKey,
    gatewayHpkeKeyId: OpaqueIdSchema,
    registeredAt: IsoDateTimeSchema,
}).strict())

export const DeviceKeyProvisioningFrameSchema = z.discriminatedUnion('type', [
    DeviceKeyRegisterFrameSchema,
    GatewayKeyRegisteredFrameSchema,
])

export const DeviceHpkeDataFrameSchema = z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal('device.hpke-data'),
    messageId: OpaqueIdSchema,
    envelope: HpkeEnvelopeSchema,
}).strict()

export const DeviceBindFrameSchema = frame('device.bind', z.object({
    gatewayId: OpaqueIdSchema,
    credentialId: OpaqueIdSchema,
    boundAt: IsoDateTimeSchema,
}).strict())

export const GatewayBoundFrameSchema = frame('gateway.bound', z.object({
    gatewayId: OpaqueIdSchema,
    credentialId: OpaqueIdSchema,
    boundAt: IsoDateTimeSchema,
}).strict())

export const DeviceBindingFrameSchema = z.discriminatedUnion('type', [DeviceBindFrameSchema, GatewayBoundFrameSchema])

export type DeviceSecureHandshakeFrame = z.infer<typeof DeviceSecureHandshakeFrameSchema>
export type GatewaySecureAuthAcceptedPayload = z.infer<typeof GatewaySecureAuthAcceptedPayloadSchema>
export type DeviceKeyProvisioningFrame = z.infer<typeof DeviceKeyProvisioningFrameSchema>
export type DeviceHpkeDataFrame = z.infer<typeof DeviceHpkeDataFrameSchema>
export type DeviceBindingFrame = z.infer<typeof DeviceBindingFrameSchema>

export const parseDeviceSecureHandshakeFrame = (value: unknown): DeviceSecureHandshakeFrame =>
    parseWithSchema(DeviceSecureHandshakeFrameSchema, value)
export const parseGatewaySecureAuthAcceptedPayload = (value: unknown): GatewaySecureAuthAcceptedPayload =>
    parseWithSchema(GatewaySecureAuthAcceptedPayloadSchema, value)
export const parseDeviceKeyProvisioningFrame = (value: unknown): DeviceKeyProvisioningFrame =>
    parseWithSchema(DeviceKeyProvisioningFrameSchema, value)
export const parseDeviceHpkeDataFrame = (value: unknown): DeviceHpkeDataFrame =>
    parseWithSchema(DeviceHpkeDataFrameSchema, value)
export const parseDeviceBindingFrame = (value: unknown): DeviceBindingFrame =>
    parseWithSchema(DeviceBindingFrameSchema, value)
