import { z } from 'zod'
import {
    IsoDateTimeSchema,
    NonNegativeIntegerSchema,
    OpaqueIdSchema,
    PROTOCOL_VERSION,
    PositiveIntegerSchema,
    parseWithSchema,
} from './common'
import {
    CancelSessionDtoSchema,
    CreateProjectDtoSchema,
    CreateSessionDtoSchema,
    MutationReceiptDtoSchema,
    PatchSessionConfigDtoSchema,
    ProjectDtoSchema,
    ProviderSessionListDtoSchema,
    ResolveDecisionDtoSchema,
    SendMessageDtoSchema,
    SessionDtoSchema,
    SessionEventsDtoSchema,
} from './client'
import { ProtocolErrorSchema } from './commands'
import { InventorySnapshotSchema } from './frames'
import { SessionEventEnvelopeSchema } from './events'

export const ClientGatewayRequestPayloadSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('inventory.get') }).strict(),
    z.object({
        kind: z.literal('project.create'),
        input: CreateProjectDtoSchema,
    }).strict(),
    z.object({
        kind: z.literal('provider.sessions.list'),
        projectId: OpaqueIdSchema,
        provider: z.string().min(1),
    }).strict(),
    z.object({
        kind: z.literal('session.create'),
        projectId: OpaqueIdSchema,
        input: CreateSessionDtoSchema,
    }).strict(),
    z.object({
        kind: z.literal('session.message'),
        sessionId: OpaqueIdSchema,
        input: SendMessageDtoSchema,
    }).strict(),
    z.object({
        kind: z.literal('session.cancel'),
        sessionId: OpaqueIdSchema,
        input: CancelSessionDtoSchema,
    }).strict(),
    z.object({
        kind: z.literal('session.config.patch'),
        sessionId: OpaqueIdSchema,
        input: PatchSessionConfigDtoSchema,
    }).strict(),
    z.object({
        kind: z.literal('decision.respond'),
        sessionId: OpaqueIdSchema,
        decisionId: OpaqueIdSchema,
        input: ResolveDecisionDtoSchema,
    }).strict(),
    z.object({
        kind: z.literal('events.list'),
        sessionId: OpaqueIdSchema,
        after: NonNegativeIntegerSchema.optional(),
        limit: PositiveIntegerSchema.max(1_000).optional(),
    }).strict(),
])

export const ClientGatewayRequestFrameSchema = z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal('client.gateway.request'),
    requestId: OpaqueIdSchema,
    idempotencyKey: OpaqueIdSchema,
    payload: ClientGatewayRequestPayloadSchema,
}).strict()

export const ClientGatewayCompletedPayloadSchema = z.union([
    InventorySnapshotSchema,
    ProjectDtoSchema,
    ProviderSessionListDtoSchema,
    SessionDtoSchema,
    SessionEventsDtoSchema,
    MutationReceiptDtoSchema,
])

const clientGatewayResponseBase = {
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal('gateway.client.response'),
    requestId: OpaqueIdSchema,
}

export const ClientGatewayResponseFrameSchema = z.discriminatedUnion('status', [
    z.object({
        ...clientGatewayResponseBase,
        status: z.literal('accepted'),
        acceptedAt: IsoDateTimeSchema,
    }).strict(),
    z.object({
        ...clientGatewayResponseBase,
        status: z.literal('completed'),
        completedAt: IsoDateTimeSchema,
        payload: ClientGatewayCompletedPayloadSchema,
    }).strict(),
    z.object({
        ...clientGatewayResponseBase,
        status: z.literal('failed'),
        failedAt: IsoDateTimeSchema,
        error: ProtocolErrorSchema,
    }).strict(),
])

export const ClientGatewayEventBatchSchema = z.object({
    events: z.array(SessionEventEnvelopeSchema).min(1),
}).strict()

export const ClientGatewayEventFrameSchema = z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal('gateway.client.event'),
    payload: ClientGatewayEventBatchSchema,
}).strict()

export const ClientGatewayFrameSchema = z.union([
    ClientGatewayRequestFrameSchema,
    ClientGatewayResponseFrameSchema,
    ClientGatewayEventFrameSchema,
])

export type ClientGatewayRequestPayload = z.infer<typeof ClientGatewayRequestPayloadSchema>
export type ClientGatewayRequestFrame = z.infer<typeof ClientGatewayRequestFrameSchema>
export type ClientGatewayCompletedPayload = z.infer<typeof ClientGatewayCompletedPayloadSchema>
export type ClientGatewayResponseFrame = z.infer<typeof ClientGatewayResponseFrameSchema>
export type ClientGatewayEventBatch = z.infer<typeof ClientGatewayEventBatchSchema>
export type ClientGatewayEventFrame = z.infer<typeof ClientGatewayEventFrameSchema>
export type ClientGatewayFrame = z.infer<typeof ClientGatewayFrameSchema>

export const parseClientGatewayRequestFrame = (value: unknown): ClientGatewayRequestFrame =>
    parseWithSchema(ClientGatewayRequestFrameSchema, value)
export const parseClientGatewayResponseFrame = (value: unknown): ClientGatewayResponseFrame =>
    parseWithSchema(ClientGatewayResponseFrameSchema, value)
export const parseClientGatewayEventFrame = (value: unknown): ClientGatewayEventFrame =>
    parseWithSchema(ClientGatewayEventFrameSchema, value)
export const parseClientGatewayFrame = (value: unknown): ClientGatewayFrame =>
    parseWithSchema(ClientGatewayFrameSchema, value)
