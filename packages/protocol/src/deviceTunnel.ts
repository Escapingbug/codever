import { z } from 'zod'
import { IsoDateTimeSchema, OpaqueIdSchema, PROTOCOL_VERSION, parseWithSchema } from './common'

const deviceTunnelFrame = <TType extends string, TPayload extends z.ZodType>(type: TType, payload: TPayload) => z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal(type),
    messageId: OpaqueIdSchema,
    payload,
}).strict()

export const OpaquePayloadSchema = z.string()
    .min(1)
    .max(262_144)
    .regex(/^[A-Za-z0-9_-]+$/, 'opaquePayload must be base64url without padding')

export const DeviceTunnelCloseCodeSchema = z.enum([
    'normal',
    'gateway_offline',
    'gateway_replaced',
    'unauthorized',
    'protocol_error',
])

export const DeviceTunnelOpenPayloadSchema = z.object({
    gatewayId: OpaqueIdSchema,
}).strict()

export const DeviceTunnelDataPayloadSchema = z.object({
    tunnelId: OpaqueIdSchema,
    opaquePayload: OpaquePayloadSchema,
}).strict()

export const DeviceTunnelClosePayloadSchema = z.object({
    tunnelId: OpaqueIdSchema,
    reason: z.string().min(1).optional(),
}).strict()

export const RelayDeviceTunnelOpenedPayloadSchema = z.object({
    gatewayId: OpaqueIdSchema,
    tunnelId: OpaqueIdSchema,
    openedAt: IsoDateTimeSchema,
}).strict()

export const RelayDeviceTunnelDataPayloadSchema = DeviceTunnelDataPayloadSchema

export const RelayDeviceTunnelClosedPayloadSchema = z.object({
    tunnelId: OpaqueIdSchema,
    code: DeviceTunnelCloseCodeSchema,
    reason: z.string().min(1).optional(),
}).strict()

export const DeviceTunnelOpenFrameSchema = deviceTunnelFrame('device.tunnel.open', DeviceTunnelOpenPayloadSchema)
export const DeviceTunnelDataFrameSchema = deviceTunnelFrame('device.tunnel.data', DeviceTunnelDataPayloadSchema)
export const DeviceTunnelCloseFrameSchema = deviceTunnelFrame('device.tunnel.close', DeviceTunnelClosePayloadSchema)
export const RelayDeviceTunnelOpenedFrameSchema = deviceTunnelFrame('relay.device-tunnel.opened', RelayDeviceTunnelOpenedPayloadSchema)
export const RelayDeviceTunnelDataFrameSchema = deviceTunnelFrame('relay.device-tunnel.data', RelayDeviceTunnelDataPayloadSchema)
export const RelayDeviceTunnelClosedFrameSchema = deviceTunnelFrame('relay.device-tunnel.closed', RelayDeviceTunnelClosedPayloadSchema)

export const ClientDeviceTunnelRequestFrameSchema = z.discriminatedUnion('type', [
    DeviceTunnelOpenFrameSchema,
    DeviceTunnelDataFrameSchema,
    DeviceTunnelCloseFrameSchema,
])

export const RelayDeviceTunnelFrameSchema = z.discriminatedUnion('type', [
    RelayDeviceTunnelOpenedFrameSchema,
    RelayDeviceTunnelDataFrameSchema,
    RelayDeviceTunnelClosedFrameSchema,
])

export const ClientDeviceTunnelFrameSchema = z.discriminatedUnion('type', [
    DeviceTunnelOpenFrameSchema,
    DeviceTunnelDataFrameSchema,
    DeviceTunnelCloseFrameSchema,
    RelayDeviceTunnelOpenedFrameSchema,
    RelayDeviceTunnelDataFrameSchema,
    RelayDeviceTunnelClosedFrameSchema,
])

export const DeviceTunnelFrameSchema = ClientDeviceTunnelFrameSchema

export const GatewayDeviceTunnelOpenPayloadSchema = z.object({
    tunnelId: OpaqueIdSchema,
    openedAt: IsoDateTimeSchema,
}).strict()

export const GatewayDeviceTunnelDataPayloadSchema = z.object({
    tunnelId: OpaqueIdSchema,
    opaquePayload: OpaquePayloadSchema,
}).strict()

export const GatewayDeviceTunnelClosePayloadSchema = z.object({
    tunnelId: OpaqueIdSchema,
    reason: z.string().min(1).optional(),
    code: DeviceTunnelCloseCodeSchema.optional(),
}).strict()

export type OpaquePayload = z.infer<typeof OpaquePayloadSchema>
export type DeviceTunnelCloseCode = z.infer<typeof DeviceTunnelCloseCodeSchema>
export type DeviceTunnelOpenPayload = z.infer<typeof DeviceTunnelOpenPayloadSchema>
export type DeviceTunnelDataPayload = z.infer<typeof DeviceTunnelDataPayloadSchema>
export type DeviceTunnelClosePayload = z.infer<typeof DeviceTunnelClosePayloadSchema>
export type RelayDeviceTunnelOpenedPayload = z.infer<typeof RelayDeviceTunnelOpenedPayloadSchema>
export type RelayDeviceTunnelDataPayload = z.infer<typeof RelayDeviceTunnelDataPayloadSchema>
export type RelayDeviceTunnelClosedPayload = z.infer<typeof RelayDeviceTunnelClosedPayloadSchema>
export type DeviceTunnelOpenFrame = z.infer<typeof DeviceTunnelOpenFrameSchema>
export type DeviceTunnelDataFrame = z.infer<typeof DeviceTunnelDataFrameSchema>
export type DeviceTunnelCloseFrame = z.infer<typeof DeviceTunnelCloseFrameSchema>
export type RelayDeviceTunnelOpenedFrame = z.infer<typeof RelayDeviceTunnelOpenedFrameSchema>
export type RelayDeviceTunnelDataFrame = z.infer<typeof RelayDeviceTunnelDataFrameSchema>
export type RelayDeviceTunnelClosedFrame = z.infer<typeof RelayDeviceTunnelClosedFrameSchema>
export type ClientDeviceTunnelRequestFrame = z.infer<typeof ClientDeviceTunnelRequestFrameSchema>
export type ClientDeviceTunnelFrame = z.infer<typeof ClientDeviceTunnelFrameSchema>
export type RelayDeviceTunnelFrame = z.infer<typeof RelayDeviceTunnelFrameSchema>
export type DeviceTunnelFrame = z.infer<typeof DeviceTunnelFrameSchema>
export type GatewayDeviceTunnelOpenPayload = z.infer<typeof GatewayDeviceTunnelOpenPayloadSchema>
export type GatewayDeviceTunnelDataPayload = z.infer<typeof GatewayDeviceTunnelDataPayloadSchema>
export type GatewayDeviceTunnelClosePayload = z.infer<typeof GatewayDeviceTunnelClosePayloadSchema>

export const parseClientDeviceTunnelRequestFrame = (value: unknown): ClientDeviceTunnelRequestFrame => parseWithSchema(ClientDeviceTunnelRequestFrameSchema, value)
export const parseClientDeviceTunnelFrame = (value: unknown): ClientDeviceTunnelFrame => parseWithSchema(ClientDeviceTunnelFrameSchema, value)
export const parseRelayDeviceTunnelFrame = (value: unknown): RelayDeviceTunnelFrame => parseWithSchema(RelayDeviceTunnelFrameSchema, value)
export const parseDeviceTunnelFrame = (value: unknown): DeviceTunnelFrame => parseWithSchema(DeviceTunnelFrameSchema, value)
