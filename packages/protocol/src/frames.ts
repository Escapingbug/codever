import { z } from 'zod'
import { IsoDateTimeSchema, NonNegativeIntegerSchema, OpaqueIdSchema, PROTOCOL_VERSION, PositiveIntegerSchema, parseWithSchema } from './common'
import { CodeverSessionSchema, GatewayCapabilitiesSchema, GatewayPlatformSchema, ProjectSchema } from './domain'
import {
    GatewayDeviceTunnelClosePayloadSchema,
    GatewayDeviceTunnelDataPayloadSchema,
    GatewayDeviceTunnelOpenPayloadSchema,
} from './deviceTunnel'
import { GatewayBlobRequestFrameSchema, RelayBlobResponseFrameSchema } from './relayBlob'

const frame = <TType extends string, TPayload extends z.ZodType>(type: TType, payload: TPayload) => z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal(type),
    messageId: OpaqueIdSchema,
    gatewayId: OpaqueIdSchema,
    connectionEpoch: OpaqueIdSchema,
    payload,
}).strict()

export const GatewayHelloSchema = z.object({
    workspaceId: OpaqueIdSchema,
    name: z.string().min(1),
    platform: GatewayPlatformSchema,
    gatewayVersion: z.string().min(1),
    supportedProtocolVersions: z.array(PositiveIntegerSchema).min(1),
    capabilities: GatewayCapabilitiesSchema,
    connectedAt: IsoDateTimeSchema,
}).strict()

export const InventorySnapshotSchema = z.object({
    generatedAt: IsoDateTimeSchema,
    revision: NonNegativeIntegerSchema,
    projects: z.array(ProjectSchema),
    sessions: z.array(CodeverSessionSchema),
}).strict()

export const HeartbeatSchema = z.object({
    sentAt: IsoDateTimeSchema,
    uptimeMs: NonNegativeIntegerSchema,
}).strict()

export const GatewayHelloFrameSchema = frame('gateway.hello', GatewayHelloSchema)
export const HeartbeatFrameSchema = frame('gateway.heartbeat', HeartbeatSchema)
export const GatewayDeviceTunnelOpenFrameSchema = frame('device.tunnel.open', GatewayDeviceTunnelOpenPayloadSchema)
export const GatewayDeviceTunnelDataFrameSchema = frame('device.tunnel.data', GatewayDeviceTunnelDataPayloadSchema)
export const GatewayDeviceTunnelCloseFrameSchema = frame('device.tunnel.close', GatewayDeviceTunnelClosePayloadSchema)

export const GatewayDeviceTunnelFrameSchema = z.discriminatedUnion('type', [
    GatewayDeviceTunnelOpenFrameSchema,
    GatewayDeviceTunnelDataFrameSchema,
    GatewayDeviceTunnelCloseFrameSchema,
])

export const GatewayFrameSchema = z.discriminatedUnion('type', [
    GatewayHelloFrameSchema,
    HeartbeatFrameSchema,
    GatewayDeviceTunnelOpenFrameSchema,
    GatewayDeviceTunnelDataFrameSchema,
    GatewayDeviceTunnelCloseFrameSchema,
    ...GatewayBlobRequestFrameSchema.options,
    RelayBlobResponseFrameSchema,
])

export type GatewayHello = z.infer<typeof GatewayHelloSchema>
export type InventorySnapshot = z.infer<typeof InventorySnapshotSchema>
export type Heartbeat = z.infer<typeof HeartbeatSchema>
export type GatewayDeviceTunnelOpenFrame = z.infer<typeof GatewayDeviceTunnelOpenFrameSchema>
export type GatewayDeviceTunnelDataFrame = z.infer<typeof GatewayDeviceTunnelDataFrameSchema>
export type GatewayDeviceTunnelCloseFrame = z.infer<typeof GatewayDeviceTunnelCloseFrameSchema>
export type GatewayDeviceTunnelFrame = z.infer<typeof GatewayDeviceTunnelFrameSchema>
export type GatewayFrame = z.infer<typeof GatewayFrameSchema>
export type GatewayFrameType = GatewayFrame['type']

export const parseGatewayFrame = (value: unknown): GatewayFrame => parseWithSchema(GatewayFrameSchema, value)
export const parseGatewayDeviceTunnelFrame = (value: unknown): GatewayDeviceTunnelFrame => parseWithSchema(GatewayDeviceTunnelFrameSchema, value)
