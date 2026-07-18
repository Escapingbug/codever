import { z } from 'zod'
import { IsoDateTimeSchema, OpaqueIdSchema, PROTOCOL_VERSION, parseWithSchema } from './common'
import { GatewaySchema } from './domain'

export const DURABLE_SYNC_PREFIX = 'cv.v1' as const

export const CODEVER_STREAMS = {
    commands: 'CV_COMMANDS',
    responses: 'CV_RESPONSES',
    events: 'CV_EVENTS',
    inventory: 'CV_INVENTORY',
    pairing: 'CV_PAIRING',
    presence: 'CV_PRESENCE',
} as const

const SubjectTokenSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, 'must be a NATS-safe subject token')

const routed = {
    version: z.literal(PROTOCOL_VERSION),
    messageId: OpaqueIdSchema,
    gatewayId: SubjectTokenSchema,
    credentialId: SubjectTokenSchema,
    createdAt: IsoDateTimeSchema,
    opaquePayload: z.string().min(1),
}

/** Relay-visible route metadata plus an HPKE-protected command body. */
export const DurableCommandEnvelopeSchema = z.object({
    ...routed,
    kind: z.literal('codever.command'),
    commandId: OpaqueIdSchema,
    expiresAt: IsoDateTimeSchema.optional(),
}).strict()

/** A durable, correlation-safe response. No live request/reply connection is required. */
export const DurableResponseEnvelopeSchema = z.object({
    ...routed,
    kind: z.literal('codever.response'),
    commandId: OpaqueIdSchema,
}).strict()

/** One encrypted AG-UI-compatible event, ordered by its JetStream stream sequence. */
export const DurableEventEnvelopeSchema = z.object({
    ...routed,
    kind: z.literal('codever.event'),
    projectId: SubjectTokenSchema,
    contextId: SubjectTokenSchema,
    eventId: OpaqueIdSchema,
    taskId: OpaqueIdSchema.optional(),
}).strict()

/** Latest encrypted Gateway inventory, stored as a replaceable materialized view. */
export const DurableInventoryEnvelopeSchema = z.object({
    ...routed,
    kind: z.literal('codever.inventory'),
    revision: z.number().int().positive(),
}).strict()

const pairingRoute = {
    version: z.literal(PROTOCOL_VERSION),
    messageId: OpaqueIdSchema,
    pairingSessionId: OpaqueIdSchema,
    gatewayId: SubjectTokenSchema,
    credentialId: SubjectTokenSchema,
    createdAt: IsoDateTimeSchema,
    opaquePayload: z.string().min(1).max(32_768),
}

/** Retryable, short-lived carrier for the OPAQUE device-pairing state machine. */
export const DurablePairingRequestEnvelopeSchema = z.object({
    ...pairingRoute,
    kind: z.literal('codever.pairing.request'),
}).strict()

export const DurablePairingResponseEnvelopeSchema = z.object({
    ...pairingRoute,
    kind: z.literal('codever.pairing.response'),
    inReplyTo: OpaqueIdSchema,
}).strict()

export const GatewayPresenceEnvelopeSchema = z.object({
    version: z.literal(PROTOCOL_VERSION),
    kind: z.literal('codever.gateway.presence'),
    messageId: OpaqueIdSchema,
    gateway: GatewaySchema,
}).strict()

export type DurableCommandEnvelope = z.infer<typeof DurableCommandEnvelopeSchema>
export type DurableResponseEnvelope = z.infer<typeof DurableResponseEnvelopeSchema>
export type DurableEventEnvelope = z.infer<typeof DurableEventEnvelopeSchema>
export type DurableInventoryEnvelope = z.infer<typeof DurableInventoryEnvelopeSchema>
export type DurablePairingRequestEnvelope = z.infer<typeof DurablePairingRequestEnvelopeSchema>
export type DurablePairingResponseEnvelope = z.infer<typeof DurablePairingResponseEnvelopeSchema>
export type GatewayPresenceEnvelope = z.infer<typeof GatewayPresenceEnvelopeSchema>

export const parseDurableCommandEnvelope = (value: unknown): DurableCommandEnvelope =>
    parseWithSchema(DurableCommandEnvelopeSchema, value)
export const parseDurableResponseEnvelope = (value: unknown): DurableResponseEnvelope =>
    parseWithSchema(DurableResponseEnvelopeSchema, value)
export const parseDurableEventEnvelope = (value: unknown): DurableEventEnvelope =>
    parseWithSchema(DurableEventEnvelopeSchema, value)
export const parseDurableInventoryEnvelope = (value: unknown): DurableInventoryEnvelope =>
    parseWithSchema(DurableInventoryEnvelopeSchema, value)
export const parseDurablePairingRequestEnvelope = (value: unknown): DurablePairingRequestEnvelope =>
    parseWithSchema(DurablePairingRequestEnvelopeSchema, value)
export const parseDurablePairingResponseEnvelope = (value: unknown): DurablePairingResponseEnvelope =>
    parseWithSchema(DurablePairingResponseEnvelopeSchema, value)
export const parseGatewayPresenceEnvelope = (value: unknown): GatewayPresenceEnvelope =>
    parseWithSchema(GatewayPresenceEnvelopeSchema, value)

export function gatewayCommandsSubject(gatewayId: string): string {
    return `${DURABLE_SYNC_PREFIX}.gateway.${token(gatewayId, 'gatewayId')}.commands`
}

export function clientResponsesSubject(credentialId: string): string {
    return `${DURABLE_SYNC_PREFIX}.client.${token(credentialId, 'credentialId')}.responses`
}

export function clientEventsSubject(credentialId: string): string {
    return `${DURABLE_SYNC_PREFIX}.client.${token(credentialId, 'credentialId')}.events`
}

export function clientInventorySubject(credentialId: string, gatewayId: string): string {
    return `${DURABLE_SYNC_PREFIX}.client.${token(credentialId, 'credentialId')}.inventory.${token(gatewayId, 'gatewayId')}`
}

export function gatewayPairingRequestsSubject(gatewayId: string): string {
    return `${DURABLE_SYNC_PREFIX}.gateway.${token(gatewayId, 'gatewayId')}.pairing.requests`
}

export function clientPairingResponsesSubject(clientId: string): string {
    return `${DURABLE_SYNC_PREFIX}.client.${token(clientId, 'clientId')}.pairing.responses`
}

export function gatewayPresenceSubject(gatewayId: string): string {
    return `${DURABLE_SYNC_PREFIX}.gateway.${token(gatewayId, 'gatewayId')}.presence`
}

export function gatewayConsumerName(gatewayId: string): string {
    return `gateway_${token(gatewayId, 'gatewayId')}`
}

export function gatewayObjectBucketName(gatewayId: string): string {
    return `CV_${token(gatewayId, 'gatewayId')}`
}

export function gatewayObjectStreamName(gatewayId: string): string {
    return `OBJ_${gatewayObjectBucketName(gatewayId)}`
}

export function clientConsumerName(credentialId: string, channel: 'responses' | 'events' | 'inventory' | 'presence'): string {
    return `client_${token(credentialId, 'credentialId')}_${channel}`
}

function token(value: string, field: string): string {
    const result = SubjectTokenSchema.safeParse(value)
    if (!result.success) throw new Error(`Invalid ${field}: must be a NATS-safe subject token`)
    return result.data
}
