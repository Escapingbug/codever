import { z } from 'zod'
import {
    IsoDateTimeSchema,
    JsonValueSchema,
    NonNegativeIntegerSchema,
    OpaqueIdSchema,
    PositiveIntegerSchema,
    SCHEMA_VERSION,
    parseWithSchema,
} from './common'
import { SessionStateSchema } from './domain'

export const EventSourceSchema = z.enum(['live', 'replay', 'synthetic'])

export const EventMetaSchema = z.object({
    turnId: OpaqueIdSchema.optional(),
    source: EventSourceSchema,
}).strict()

export const DecisionOptionSchema = z.object({
    id: OpaqueIdSchema,
    label: z.string().min(1),
    value: JsonValueSchema,
    style: z.enum(['default', 'primary', 'danger']).optional(),
}).strict()

export const ToolContentSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string(), mimeType: z.string().optional() }).strict(),
    z.object({ type: z.literal('diff'), path: z.string(), oldText: z.string(), newText: z.string() }).strict(),
    z.object({ type: z.literal('terminal'), terminalId: OpaqueIdSchema, text: z.string().optional() }).strict(),
])

export const ToolOutputReferenceSchema = z.object({
    outputId: OpaqueIdSchema,
    sizeBytes: NonNegativeIntegerSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mediaType: z.literal('application/json'),
}).strict()

const event = <T extends z.ZodRawShape>(shape: T) => z.object({
    ...shape,
    meta: EventMetaSchema.optional(),
}).strict()

export const ConversationEventSchema = z.discriminatedUnion('kind', [
    event({
        kind: z.literal('user_message'),
        text: z.string(),
        clientMessageId: OpaqueIdSchema.optional(),
        actorId: OpaqueIdSchema.optional(),
        attachments: z.array(z.object({
            id: OpaqueIdSchema,
            filename: z.string().min(1),
            mimeType: z.string().min(1),
            sizeBytes: NonNegativeIntegerSchema,
        }).strict()).optional(),
    }),
    event({ kind: z.literal('turn_started') }),
    event({ kind: z.literal('assistant_text_delta'), text: z.string() }),
    event({
        kind: z.literal('tool'),
        phase: z.enum(['started', 'updated', 'completed', 'failed']),
        toolCallId: OpaqueIdSchema,
        toolName: z.string().min(1),
        category: z.enum(['read', 'edit', 'write', 'execute', 'search', 'agent', 'unknown']).optional(),
        outputRef: ToolOutputReferenceSchema.optional(),
        isError: z.boolean().optional(),
        displayTitle: z.string().optional(),
        content: z.array(ToolContentSchema).optional(),
    }),
    event({
        kind: z.literal('decision_request'),
        decisionId: OpaqueIdSchema,
        title: z.string().min(1),
        body: z.string().optional(),
        options: z.array(DecisionOptionSchema).min(1),
        required: z.boolean(),
        source: z.enum(['gateway', 'agent']),
        expiresAt: IsoDateTimeSchema.optional(),
    }),
    event({
        kind: z.literal('decision_resolved'),
        decisionId: OpaqueIdSchema,
        optionId: OpaqueIdSchema.optional(),
        value: JsonValueSchema,
        resolvedBy: OpaqueIdSchema.optional(),
    }),
    event({ kind: z.literal('mode_change'), mode: z.string().min(1) }),
    event({
        kind: z.literal('provider_session'),
        provider: z.string().min(1),
        providerSessionId: z.string().min(1),
        isNewSession: z.boolean().optional(),
    }),
    event({
        kind: z.literal('settings'),
        model: z.string().min(1).optional(),
        providerSettings: z.record(z.string(), JsonValueSchema),
    }),
    event({ kind: z.literal('session_state'), state: SessionStateSchema, reason: z.string().optional() }),
    event({ kind: z.literal('command_result'), command: z.string().min(1), output: JsonValueSchema }),
    event({ kind: z.literal('status'), level: z.enum(['info', 'warning', 'error']), message: z.string().min(1) }),
    event({
        kind: z.literal('turn_finished'),
        status: z.enum(['success', 'error', 'cancelled', 'max_turns']),
        summary: z.string().optional(),
    }),
])

export const SessionEventEnvelopeSchema = z.object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    gatewayId: OpaqueIdSchema,
    projectId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    seq: PositiveIntegerSchema,
    eventId: OpaqueIdSchema,
    timestamp: IsoDateTimeSchema,
    event: ConversationEventSchema,
}).strict()

export type EventSource = z.infer<typeof EventSourceSchema>
export type EventMeta = z.infer<typeof EventMetaSchema>
export type DecisionOption = z.infer<typeof DecisionOptionSchema>
export type ToolContent = z.infer<typeof ToolContentSchema>
export type ToolOutputReference = z.infer<typeof ToolOutputReferenceSchema>
export type ConversationEvent = z.infer<typeof ConversationEventSchema>
export type SessionEventEnvelope = z.infer<typeof SessionEventEnvelopeSchema>

export const parseConversationEvent = (value: unknown): ConversationEvent => parseWithSchema(ConversationEventSchema, value)
export const parseSessionEventEnvelope = (value: unknown): SessionEventEnvelope => parseWithSchema(SessionEventEnvelopeSchema, value)
