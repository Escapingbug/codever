import { z } from 'zod'
import { IsoDateTimeSchema, NonNegativeIntegerSchema, OpaqueIdSchema, PROTOCOL_VERSION, PositiveIntegerSchema, parseWithSchema } from './common'
import { CommandAcceptedSchema, CommandFailedSchema, CommandRequestSchema, CommandResultSchema } from './commands'
import { CodeverSessionSchema, GatewayCapabilitiesSchema, GatewayPlatformSchema, ProjectSchema, SessionStateSchema } from './domain'
import { SessionEventEnvelopeSchema } from './events'
import {
    GatewayDeviceTunnelClosePayloadSchema,
    GatewayDeviceTunnelDataPayloadSchema,
    GatewayDeviceTunnelOpenPayloadSchema,
} from './deviceTunnel'

const handshakeFrame = <TType extends string, TPayload extends z.ZodType>(type: TType, payload: TPayload) => z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal(type),
    messageId: OpaqueIdSchema,
    payload,
}).strict()

const frame = <TType extends string, TPayload extends z.ZodType>(type: TType, payload: TPayload) => z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal(type),
    messageId: OpaqueIdSchema,
    gatewayId: OpaqueIdSchema,
    connectionEpoch: OpaqueIdSchema,
    sessionId: OpaqueIdSchema.optional(),
    idempotencyKey: OpaqueIdSchema.optional(),
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

export const RelayAuthChallengeSchema = z.object({
    relayId: OpaqueIdSchema,
    challengeId: OpaqueIdSchema,
    nonce: z.string().min(32),
    issuedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
}).strict()

export const GatewayAuthResponseSchema = z.object({
    gatewayId: OpaqueIdSchema,
    algorithm: z.literal('ECDSA-P256-SHA256'),
    fingerprint: z.string().startsWith('sha256:'),
    signature: z.string().min(1),
}).strict()

export const RelayAuthAcceptedSchema = z.object({
    gatewayId: OpaqueIdSchema,
    connectionEpoch: OpaqueIdSchema,
    acceptedAt: IsoDateTimeSchema,
}).strict()

export const RelayAuthRejectedSchema = z.object({
    code: z.enum(['unknown_gateway', 'invalid_signature', 'expired_challenge', 'gateway_disabled', 'protocol_error']),
    message: z.string().min(1),
}).strict()

export const RelayAuthChallengeFrameSchema = handshakeFrame('relay.auth.challenge', RelayAuthChallengeSchema)
export const GatewayAuthResponseFrameSchema = handshakeFrame('gateway.auth.response', GatewayAuthResponseSchema)
export const RelayAuthAcceptedFrameSchema = handshakeFrame('relay.auth.accepted', RelayAuthAcceptedSchema)
export const RelayAuthRejectedFrameSchema = handshakeFrame('relay.auth.rejected', RelayAuthRejectedSchema)

export const GatewayHandshakeFrameSchema = z.discriminatedUnion('type', [
    RelayAuthChallengeFrameSchema,
    GatewayAuthResponseFrameSchema,
    RelayAuthAcceptedFrameSchema,
    RelayAuthRejectedFrameSchema,
])

export const InventorySnapshotSchema = z.object({
    generatedAt: IsoDateTimeSchema,
    revision: NonNegativeIntegerSchema,
    projects: z.array(ProjectSchema),
    sessions: z.array(CodeverSessionSchema),
}).strict()

export const HeartbeatSchema = z.object({
    sentAt: IsoDateTimeSchema,
    uptimeMs: NonNegativeIntegerSchema,
    inventoryRevision: NonNegativeIntegerSchema,
    sessionStates: z.record(OpaqueIdSchema, SessionStateSchema),
}).strict()

export const SessionEventBatchSchema = z.object({ events: z.array(SessionEventEnvelopeSchema).min(1) }).strict()
export const SessionEventAckSchema = z.object({
    cursors: z.array(z.object({ sessionId: OpaqueIdSchema, seq: NonNegativeIntegerSchema }).strict()).min(1),
}).strict()

export const DecisionResponseSchema = z.object({
    decisionId: OpaqueIdSchema,
    value: z.json(),
    responderId: OpaqueIdSchema,
    respondedAt: IsoDateTimeSchema,
}).strict()

export const SyncRequestSchema = z.object({
    cursors: z.array(z.object({ sessionId: OpaqueIdSchema, afterSeq: NonNegativeIntegerSchema }).strict()),
    includeInventory: z.boolean(),
}).strict()

export const SyncCompleteSchema = z.object({
    completedAt: IsoDateTimeSchema,
    inventoryRevision: NonNegativeIntegerSchema,
    cursors: z.array(z.object({ sessionId: OpaqueIdSchema, seq: NonNegativeIntegerSchema }).strict()),
}).strict()

export const GatewayHelloFrameSchema = frame('gateway.hello', GatewayHelloSchema)
export const InventorySnapshotFrameSchema = frame('gateway.inventory.snapshot', InventorySnapshotSchema)
export const HeartbeatFrameSchema = frame('gateway.heartbeat', HeartbeatSchema)
export const SessionEventBatchFrameSchema = frame('session.event.batch', SessionEventBatchSchema)
export const SessionEventAckFrameSchema = frame('session.event.ack', SessionEventAckSchema)
export const CommandRequestFrameSchema = frame('command.request', CommandRequestSchema)
export const CommandAcceptedFrameSchema = frame('command.accepted', CommandAcceptedSchema)
export const CommandResultFrameSchema = frame('command.result', CommandResultSchema)
export const CommandFailedFrameSchema = frame('command.failed', CommandFailedSchema)
export const DecisionResponseFrameSchema = frame('decision.response', DecisionResponseSchema)
export const SyncRequestFrameSchema = frame('sync.request', SyncRequestSchema)
export const SyncCompleteFrameSchema = frame('sync.complete', SyncCompleteSchema)
export const GatewayDeviceTunnelOpenFrameSchema = frame('device.tunnel.open', GatewayDeviceTunnelOpenPayloadSchema)
export const GatewayDeviceTunnelDataFrameSchema = frame('device.tunnel.data', GatewayDeviceTunnelDataPayloadSchema)
export const GatewayDeviceTunnelCloseFrameSchema = frame('device.tunnel.close', GatewayDeviceTunnelClosePayloadSchema)

export const CommandLifecycleFrameSchema = z.discriminatedUnion('type', [
    CommandRequestFrameSchema,
    CommandAcceptedFrameSchema,
    CommandResultFrameSchema,
    CommandFailedFrameSchema,
])

export const GatewayDeviceTunnelFrameSchema = z.discriminatedUnion('type', [
    GatewayDeviceTunnelOpenFrameSchema,
    GatewayDeviceTunnelDataFrameSchema,
    GatewayDeviceTunnelCloseFrameSchema,
])

export const GatewayFrameSchema = z.discriminatedUnion('type', [
    GatewayHelloFrameSchema,
    InventorySnapshotFrameSchema,
    HeartbeatFrameSchema,
    SessionEventBatchFrameSchema,
    SessionEventAckFrameSchema,
    CommandRequestFrameSchema,
    CommandAcceptedFrameSchema,
    CommandResultFrameSchema,
    CommandFailedFrameSchema,
    DecisionResponseFrameSchema,
    SyncRequestFrameSchema,
    SyncCompleteFrameSchema,
    GatewayDeviceTunnelOpenFrameSchema,
    GatewayDeviceTunnelDataFrameSchema,
    GatewayDeviceTunnelCloseFrameSchema,
])

export type GatewayHello = z.infer<typeof GatewayHelloSchema>
export type RelayAuthChallenge = z.infer<typeof RelayAuthChallengeSchema>
export type GatewayAuthResponse = z.infer<typeof GatewayAuthResponseSchema>
export type RelayAuthAccepted = z.infer<typeof RelayAuthAcceptedSchema>
export type RelayAuthRejected = z.infer<typeof RelayAuthRejectedSchema>
export type GatewayHandshakeFrame = z.infer<typeof GatewayHandshakeFrameSchema>
export type InventorySnapshot = z.infer<typeof InventorySnapshotSchema>
export type Heartbeat = z.infer<typeof HeartbeatSchema>
export type SessionEventBatch = z.infer<typeof SessionEventBatchSchema>
export type SessionEventAck = z.infer<typeof SessionEventAckSchema>
export type DecisionResponse = z.infer<typeof DecisionResponseSchema>
export type SyncRequest = z.infer<typeof SyncRequestSchema>
export type SyncComplete = z.infer<typeof SyncCompleteSchema>
export type GatewayDeviceTunnelOpenFrame = z.infer<typeof GatewayDeviceTunnelOpenFrameSchema>
export type GatewayDeviceTunnelDataFrame = z.infer<typeof GatewayDeviceTunnelDataFrameSchema>
export type GatewayDeviceTunnelCloseFrame = z.infer<typeof GatewayDeviceTunnelCloseFrameSchema>
export type GatewayDeviceTunnelFrame = z.infer<typeof GatewayDeviceTunnelFrameSchema>
export type GatewayFrame = z.infer<typeof GatewayFrameSchema>
export type GatewayFrameType = GatewayFrame['type']
export type CommandLifecycleFrame = z.infer<typeof CommandLifecycleFrameSchema>

export const parseGatewayFrame = (value: unknown): GatewayFrame => parseWithSchema(GatewayFrameSchema, value)
export const parseGatewayHandshakeFrame = (value: unknown): GatewayHandshakeFrame => parseWithSchema(GatewayHandshakeFrameSchema, value)
export const parseCommandLifecycleFrame = (value: unknown): CommandLifecycleFrame => parseWithSchema(CommandLifecycleFrameSchema, value)
export const parseGatewayDeviceTunnelFrame = (value: unknown): GatewayDeviceTunnelFrame => parseWithSchema(GatewayDeviceTunnelFrameSchema, value)

/** Canonical, domain-separated bytes signed during Gateway authentication. */
export function serializeGatewayAuthPayload(
    challenge: RelayAuthChallenge,
    gatewayId: string,
    fingerprint: string,
): Uint8Array {
    const parsed = parseWithSchema(RelayAuthChallengeSchema, {
        relayId: challenge.relayId,
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        issuedAt: challenge.issuedAt,
        expiresAt: challenge.expiresAt,
    })
    const id = parseWithSchema(OpaqueIdSchema, gatewayId)
    const keyFingerprint = z.string().startsWith('sha256:').parse(fingerprint)
    return new TextEncoder().encode(`codever.gateway.relay-auth.v1\n${JSON.stringify([
        parsed.relayId,
        parsed.challengeId,
        parsed.nonce,
        parsed.issuedAt,
        parsed.expiresAt,
        id,
        keyFingerprint,
    ])}`)
}
