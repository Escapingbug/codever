import { z } from 'zod'
import { IsoDateTimeSchema, JsonObjectSchema, JsonValueSchema, OpaqueIdSchema, parseWithSchema } from './common'

export const GatewayCommandSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('session.create'),
        provider: z.string().min(1),
        title: z.string().trim().min(1).optional(),
        model: z.string().min(1).optional(),
        mode: z.string().min(1).optional(),
        providerSessionId: z.string().min(1).optional(),
        config: JsonObjectSchema,
    }).strict(),
    z.object({ kind: z.literal('provider.sessions.list'), provider: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('session.message'), text: z.string().min(1), attachmentIds: z.array(OpaqueIdSchema).optional() }).strict(),
    z.object({ kind: z.literal('session.cancel'), reason: z.string().min(1).optional() }).strict(),
    z.object({
        kind: z.literal('session.config.patch'),
        config: JsonObjectSchema,
        model: z.string().min(1).nullable().optional(),
        mode: z.string().min(1).nullable().optional(),
    }).strict(),
    z.object({ kind: z.literal('session.close') }).strict(),
    z.object({ kind: z.literal('decision.respond'), decisionId: OpaqueIdSchema, value: JsonValueSchema }).strict(),
])

export const CommandTerminalStatusSchema = z.enum(['completed', 'rejected', 'expired', 'unknown'])

export const CommandRequestSchema = z.object({
    commandId: OpaqueIdSchema,
    projectId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    command: GatewayCommandSchema,
    requestedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema.optional(),
    actorId: OpaqueIdSchema.optional(),
    deviceId: OpaqueIdSchema.optional(),
}).strict()

export const CommandAcceptedSchema = z.object({
    commandId: OpaqueIdSchema,
    acceptedAt: IsoDateTimeSchema,
}).strict()

export const CommandResultSchema = z.object({
    commandId: OpaqueIdSchema,
    completedAt: IsoDateTimeSchema,
    result: JsonValueSchema.optional(),
}).strict()

export const ProtocolErrorSchema = z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
    details: JsonObjectSchema.optional(),
}).strict()

export const CommandFailedSchema = z.object({
    commandId: OpaqueIdSchema,
    failedAt: IsoDateTimeSchema,
    status: z.enum(['rejected', 'expired', 'unknown']),
    error: ProtocolErrorSchema,
}).strict()

export type GatewayCommand = z.infer<typeof GatewayCommandSchema>
export type CommandTerminalStatus = z.infer<typeof CommandTerminalStatusSchema>
export type CommandRequest = z.infer<typeof CommandRequestSchema>
export type CommandAccepted = z.infer<typeof CommandAcceptedSchema>
export type CommandResult = z.infer<typeof CommandResultSchema>
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>
export type CommandFailed = z.infer<typeof CommandFailedSchema>

export const parseGatewayCommand = (value: unknown): GatewayCommand => parseWithSchema(GatewayCommandSchema, value)
export const parseCommandRequest = (value: unknown): CommandRequest => parseWithSchema(CommandRequestSchema, value)
export const parseCommandAccepted = (value: unknown): CommandAccepted => parseWithSchema(CommandAcceptedSchema, value)
export const parseCommandResult = (value: unknown): CommandResult => parseWithSchema(CommandResultSchema, value)
export const parseCommandFailed = (value: unknown): CommandFailed => parseWithSchema(CommandFailedSchema, value)
