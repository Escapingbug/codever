import { z } from 'zod'

export const PROTOCOL_VERSION = 1 as const

const opaqueId = z.string().min(1).max(256)
const timestamp = z.number().int().nonnegative()
const jsonPrimitive: z.ZodType<null | boolean | number | string> = z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
])
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([jsonPrimitive, z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
)

export const attachmentSchema = z
  .object({
    id: opaqueId,
    name: z.string().min(1).max(1024),
    mimeType: z.string().min(1).max(256),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict()

export const commandPayloadSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('prompt'),
      text: z.string(),
      attachments: z.array(attachmentSchema).max(100).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('cancel'),
      targetCommandId: opaqueId.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('decision'),
      requestId: opaqueId,
      decision: z.enum(['allow_once', 'allow_session', 'deny']),
    })
    .strict(),
  z
    .object({
      operation: z.literal('session.settings'),
      model: z.string().min(1).max(256).optional(),
      provider: z.string().min(1).max(256).optional(),
      reasoningEffort: z.string().min(1).max(64).optional(),
      permissionMode: z.enum(['default', 'accept_edits', 'plan', 'bypass_permissions']).optional(),
      cwd: z.string().min(1).max(4096).optional(),
      projectName: z.string().min(1).max(256).optional(),
    })
    .strict()
    .refine(
      (settings) =>
        settings.model !== undefined ||
        settings.provider !== undefined ||
        settings.reasoningEffort !== undefined ||
        settings.permissionMode !== undefined ||
        settings.cwd !== undefined ||
        settings.projectName !== undefined,
      'At least one session setting is required',
    ),
  z
    .object({
      operation: z.literal('session.create'),
      cwd: z.string().min(1).max(4096).optional(),
      projectName: z.string().min(1).max(256).optional(),
      provider: z.string().min(1).max(256).optional(),
      model: z.string().min(1).max(256).optional(),
      reasoningEffort: z.string().min(1).max(64).optional(),
      permissionMode: z.enum(['default', 'accept_edits', 'plan', 'bypass_permissions']).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('session.select'),
      sessionId: opaqueId,
    })
    .strict(),
])

export type CommandPayload = z.infer<typeof commandPayloadSchema>
export type CommandOperation = CommandPayload['operation']

export const commandSchema = z
  .object({
    kind: z.literal('codever.command'),
    version: z.literal(PROTOCOL_VERSION),
    commandId: opaqueId,
    gatewayId: opaqueId,
    deviceId: opaqueId,
    /** Pairing-certificate generation that authorized this device command. */
    sequenceEpoch: opaqueId,
    conversationId: opaqueId,
    revisionEpoch: opaqueId,
    sequence: z.number().int().positive(),
    /** Last Gateway-assigned conversation revision observed by this device. */
    baseRevision: z.number().int().nonnegative(),
    operation: z.enum([
      'prompt',
      'cancel',
      'decision',
      'session.settings',
      'session.create',
      'session.select',
    ]),
    issuedAt: timestamp,
    expiresAt: timestamp,
    nonce: z.string().min(16).max(256),
    payload: commandPayloadSchema,
  })
  .strict()
  .superRefine((command, context) => {
    if (command.operation !== command.payload.operation) {
      context.addIssue({
        code: 'custom',
        path: ['payload', 'operation'],
        message: 'Payload operation must match the signed operation binding',
      })
    }
    if (command.expiresAt <= command.issuedAt) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'expiresAt must be later than issuedAt',
      })
    }
  })

export type CodeverCommand = z.infer<typeof commandSchema>

export const eventPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('command.accepted'), commandId: opaqueId }).strict(),
  z.object({ type: z.literal('agent.text.delta'), streamId: opaqueId, text: z.string() }).strict(),
  z.object({ type: z.literal('agent.text.completed'), streamId: opaqueId, text: z.string() }).strict(),
  z
    .object({
      type: z.literal('agent.tool.started'),
      toolCallId: opaqueId,
      name: z.string().min(1).max(256),
      input: jsonValueSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('agent.tool.completed'),
      toolCallId: opaqueId,
      status: z.enum(['succeeded', 'failed']),
      output: jsonValueSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('agent.permission.requested'),
      requestId: opaqueId,
      title: z.string().min(1).max(1024),
      details: jsonValueSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.updated'),
      status: z.enum(['idle', 'running', 'stopping', 'failed']),
      model: z.string().optional(),
      provider: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('command.completed'),
      commandId: opaqueId,
      outcome: z.enum(['succeeded', 'cancelled', 'failed']),
      error: z.string().optional(),
    })
    .strict(),
  z.object({ type: z.literal('agent.error'), code: z.string(), message: z.string() }).strict(),
])

export type AgentEventPayload = z.infer<typeof eventPayloadSchema>

export const eventSchema = z
  .object({
    kind: z.literal('codever.event'),
    version: z.literal(PROTOCOL_VERSION),
    eventId: opaqueId,
    gatewayId: opaqueId,
    conversationId: opaqueId,
    sequence: z.number().int().positive(),
    occurredAt: timestamp,
    causationCommandId: opaqueId.optional(),
    payload: eventPayloadSchema,
  })
  .strict()

export type CodeverEvent = z.infer<typeof eventSchema>

export const signatureSchema = z
  .object({
    algorithm: z.literal('ES256'),
    keyId: opaqueId,
    value: z.string().regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict()

export type CodeverSignature = z.infer<typeof signatureSchema>

export const signedCommandSchema = z
  .object({
    command: commandSchema,
    signature: signatureSchema,
  })
  .strict()

export type SignedCommand = z.infer<typeof signedCommandSchema>

export const signedEventSchema = z
  .object({
    event: eventSchema,
    signature: signatureSchema,
  })
  .strict()

export type SignedEvent = z.infer<typeof signedEventSchema>

export function parseCommand(input: unknown): CodeverCommand {
  return commandSchema.parse(input)
}

export function parseEvent(input: unknown): CodeverEvent {
  return eventSchema.parse(input)
}
