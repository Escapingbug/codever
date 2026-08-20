import { z } from 'zod'
import { attachmentSchema, jsonValueSchema, signatureSchema } from './schema.js'

/**
 * Codever's final Matrix-native protocol.
 *
 * Matrix owns room discovery, threads, history, relations and incremental
 * sync. Codever owns only execution authorization, business semantics and a
 * thin project-content encryption layer.
 */
export const CODEVER_MATRIX_PROTOCOL_VERSION = 3 as const

export const CODEVER_MATRIX_TIMELINE_EVENT_TYPE = 'm.room.message' as const
export const CODEVER_MATRIX_EXTENSION = 'io.codever' as const
export const CODEVER_MATRIX_PROJECT_POINTER_EVENT_TYPE =
  'io.codever.project.current.v3' as const
export const CODEVER_MATRIX_WORKSPACE_POINTER_EVENT_TYPE =
  'io.codever.workspace.current.v3' as const
export const CODEVER_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE =
  'io.codever.project.key_grant.v3' as const

const opaqueId = z.string().min(1).max(256)
const requiredProjectId = z.string({ error: 'Project is required' }).min(1).max(256)
const requiredSessionId = z.string({ error: 'Session is required' }).min(1).max(256)
const matrixRoomId = z.string().min(1).max(512)
const matrixEventId = z.string().min(1).max(512)
const timestamp = z.number().int().nonnegative()
const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/)

export const codeverV3SessionExtensionBindingSchema = z
  .object({
    id: opaqueId,
    config: z.record(z.string().min(1).max(128), jsonValueSchema).optional(),
  })
  .strict()

const sessionSettingsPatchSchema = z
  .object({
    title: z.string().min(1).max(512).optional(),
    model: z.string().min(1).max(256).nullable().optional(),
    provider: z.string().min(1).max(256).optional(),
    reasoningEffort: z.string().min(1).max(64).nullable().optional(),
    permissionMode: z
      .enum(['default', 'accept_edits', 'plan', 'bypass_permissions'])
      .optional(),
    extensions: z.array(codeverV3SessionExtensionBindingSchema).max(8).optional(),
  })
  .strict()
  .refine(value => Object.values(value).some(field => field !== undefined), {
    message: 'A session update requires at least one changed field',
  })

const sessionCreatePayloadSchema = z
  .object({
    operation: z.literal('session.create'),
    title: z.string().min(1).max(512).optional(),
    model: z.string().min(1).max(256).optional(),
    provider: z.string().min(1).max(256).optional(),
    reasoningEffort: z.string().min(1).max(64).optional(),
    permissionMode: z
      .enum(['default', 'accept_edits', 'plan', 'bypass_permissions'])
      .optional(),
    extensions: z.array(codeverV3SessionExtensionBindingSchema).max(8).optional(),
    initialPrompt: z
      .object({
        text: z.string(),
        attachments: z.array(attachmentSchema).max(10).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.initialPrompt
      && value.initialPrompt.text.length === 0
      && (value.initialPrompt.attachments?.length ?? 0) === 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['initialPrompt'],
        message: 'An initial prompt requires text or an attachment',
      })
    }
  })

const promptSubmitPayloadSchema = z
  .object({
    operation: z.literal('prompt.submit'),
    text: z.string(),
    attachments: z.array(attachmentSchema).max(10).optional(),
  })
  .strict()
  .refine(
    value => value.text.length > 0 || (value.attachments?.length ?? 0) > 0,
    { message: 'A prompt requires text or an attachment' },
  )

const turnCancelPayloadSchema = z
  .object({ operation: z.literal('turn.cancel'), turnId: opaqueId })
  .strict()
const decisionAnswerPayloadSchema = z
  .object({
    operation: z.literal('decision.answer'),
    requestId: opaqueId,
    decision: z.string().min(1).max(256),
  })
  .strict()
const sessionUpdatePayloadSchema = z
  .object({ operation: z.literal('session.update'), patch: sessionSettingsPatchSchema })
  .strict()
const sessionLifecyclePayloadSchema = z
  .object({
    operation: z.literal('session.set_lifecycle'),
    state: z.enum(['active', 'archived', 'deleted']),
  })
  .strict()
const deviceInvitationPayloadSchema = z
  .object({
    operation: z.literal('device.invitation.create'),
    lifetimeMs: z.number().int().min(30_000).max(10 * 60_000).optional(),
  })
  .strict()

export const codeverV3CommandPayloadSchema = z.discriminatedUnion('operation', [
  sessionCreatePayloadSchema,
  promptSubmitPayloadSchema,
  turnCancelPayloadSchema,
  decisionAnswerPayloadSchema,
  sessionUpdatePayloadSchema,
  sessionLifecyclePayloadSchema,
  deviceInvitationPayloadSchema,
])

export type CodeverV3CommandPayload = z.infer<
  typeof codeverV3CommandPayloadSchema
>
export type CodeverV3CommandOperation = CodeverV3CommandPayload['operation']

const commandCommon = {
  kind: z.literal('codever.command'),
  version: z.literal(CODEVER_MATRIX_PROTOCOL_VERSION),
  commandId: opaqueId,
  workspaceId: opaqueId,
  deviceId: opaqueId,
  certificateId: opaqueId,
  createdAt: timestamp,
}

const projectCommandCommon = { ...commandCommon, projectId: requiredProjectId }
const sessionCommandCommon = { ...projectCommandCommon, sessionId: requiredSessionId }

/** The whole command is a discriminated union, not merely its payload. */
export const codeverV3CommandSchema = z.union([
  z.object({
    ...projectCommandCommon,
    sessionId: requiredSessionId,
    operation: z.literal('session.create'),
    payload: sessionCreatePayloadSchema,
  }).strict(),
  z.object({
    ...sessionCommandCommon,
    operation: z.literal('prompt.submit'),
    payload: promptSubmitPayloadSchema,
  }).strict(),
  z.object({
    ...sessionCommandCommon,
    operation: z.literal('turn.cancel'),
    payload: turnCancelPayloadSchema,
  }).strict(),
  z.object({
    ...sessionCommandCommon,
    operation: z.literal('decision.answer'),
    payload: decisionAnswerPayloadSchema,
  }).strict(),
  z.object({
    ...sessionCommandCommon,
    operation: z.literal('session.update'),
    payload: sessionUpdatePayloadSchema,
  }).strict(),
  z.object({
    ...sessionCommandCommon,
    operation: z.literal('session.set_lifecycle'),
    payload: sessionLifecyclePayloadSchema,
  }).strict(),
  z.object({
    ...commandCommon,
    projectId: opaqueId.optional(),
    sessionId: opaqueId.optional(),
    operation: z.literal('device.invitation.create'),
    payload: deviceInvitationPayloadSchema,
  }).strict(),
])

export type CodeverV3Command = z.infer<typeof codeverV3CommandSchema>

export const signedCodeverV3CommandSchema = z
  .object({ command: codeverV3CommandSchema, signature: signatureSchema })
  .strict()

export type SignedCodeverV3Command = z.infer<
  typeof signedCodeverV3CommandSchema
>

const sessionProjectionSchema = z
  .object({
    title: z.string().min(1).max(512),
    lifecycle: z.enum(['active', 'archived', 'deleted']),
    activity: z.enum(['idle', 'queued', 'working', 'attention', 'failed']),
    updatedAt: timestamp,
    stateVersion: z.number().int().positive(),
  })
  .strict()

export type CodeverV3SessionProjection = z.infer<
  typeof sessionProjectionSchema
>

export const codeverV3EventPayloadSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('workspace.snapshot'),
      protocolMin: z.number().int().positive(),
      protocolMax: z.number().int().positive(),
      gatewayKeyId: opaqueId,
      capabilities: jsonValueSchema,
      snapshotVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal('project.snapshot'),
      name: z.string().min(1).max(256),
      cwd: z.string().min(1).max(8_192),
      provider: z.string().min(1).max(256),
      model: z.string().min(1).max(256).optional(),
      reasoningEffort: z.string().min(1).max(64).optional(),
      permissionMode: z.string().min(1).max(128),
      snapshotVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.ready'),
      rootCommandId: opaqueId.optional(),
      originDeviceId: opaqueId.optional(),
      initialPrompt: z
        .object({
          text: z.string(),
          attachments: z.array(attachmentSchema).max(10).optional(),
        })
        .strict()
        .optional(),
      projection: sessionProjectionSchema,
      provider: z.string().min(1).max(256),
      model: z.string().min(1).max(256).optional(),
      reasoningEffort: z.string().min(1).max(64).optional(),
      permissionMode: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.updated'),
      projection: sessionProjectionSchema,
      patch: sessionSettingsPatchSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('session.lifecycle'),
      projection: sessionProjectionSchema,
      state: z.enum(['active', 'archived', 'deleted']),
      alreadyApplied: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('turn.queued'),
      turnId: opaqueId,
      originDeviceId: opaqueId,
      text: z.string(),
      attachments: z.array(attachmentSchema).max(10).optional(),
      projection: sessionProjectionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('turn.started'),
      turnId: opaqueId,
      projection: sessionProjectionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('turn.completed'),
      turnId: opaqueId,
      projection: sessionProjectionSchema,
      outcome: z.enum(['succeeded', 'cancelled']),
    })
    .strict(),
  z
    .object({
      type: z.literal('turn.failed'),
      turnId: opaqueId,
      projection: sessionProjectionSchema,
      code: z.string().min(1).max(128),
      message: z.string().min(1).max(8_192),
    })
    .strict(),
  z
    .object({
      type: z.literal('assistant.message'),
      messageId: opaqueId,
      messageVersion: z.number().int().positive(),
      body: z.string(),
      format: z.enum(['plain', 'markdown']).default('markdown'),
      final: z.boolean(),
      partIndex: z.number().int().nonnegative().optional(),
      partCount: z.number().int().positive().optional(),
      projection: sessionProjectionSchema,
      ui: jsonValueSchema.optional(),
      attachments: z.array(attachmentSchema).max(10).optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if ((value.partIndex === undefined) !== (value.partCount === undefined)) {
        context.addIssue({
          code: 'custom',
          path: ['partIndex'],
          message: 'Message part index and count must be provided together',
        })
      } else if (
        value.partIndex !== undefined
        && value.partCount !== undefined
        && value.partIndex >= value.partCount
      ) {
        context.addIssue({
          code: 'custom',
          path: ['partIndex'],
          message: 'Message part index must be smaller than part count',
        })
      }
    }),
  z
    .object({
      type: z.literal('tool.activity'),
      toolCallId: opaqueId,
      toolVersion: z.number().int().positive(),
      name: z.string().min(1).max(256),
      phase: z.enum(['started', 'updated', 'completed', 'failed']),
      input: jsonValueSchema.optional(),
      output: jsonValueSchema.optional(),
      projection: sessionProjectionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('decision.requested'),
      requestId: opaqueId,
      title: z.string().min(1).max(1_024),
      details: jsonValueSchema.optional(),
      options: z
        .array(z.object({ label: z.string(), value: z.string() }).strict())
        .min(1)
        .max(16),
      projection: sessionProjectionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('decision.resolved'),
      requestId: opaqueId,
      decision: z.string().min(1).max(128),
      projection: sessionProjectionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('command.rejected'),
      commandId: opaqueId,
      code: z.string().min(1).max(128),
      message: z.string().min(1).max(8_192),
      retryable: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal('device.invitation.created'),
      pairingLink: z.string().min(1).max(128 * 1024),
      expiresAt: timestamp,
    })
    .strict(),
])

export type CodeverV3EventPayload = z.infer<typeof codeverV3EventPayloadSchema>

export const codeverV3EventSchema = z
  .object({
    kind: z.literal('codever.event'),
    version: z.literal(CODEVER_MATRIX_PROTOCOL_VERSION),
    eventId: opaqueId,
    workspaceId: opaqueId,
    projectId: opaqueId.optional(),
    sessionId: opaqueId.optional(),
    occurredAt: timestamp,
    causationCommandId: opaqueId.optional(),
    payload: codeverV3EventPayloadSchema,
  })
  .strict()

export type CodeverV3Event = z.infer<typeof codeverV3EventSchema>

export const signedCodeverV3EventSchema = z
  .object({ event: codeverV3EventSchema, signature: signatureSchema })
  .strict()

export type SignedCodeverV3Event = z.infer<typeof signedCodeverV3EventSchema>

export const codeverV3PlaintextSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('signed_command'),
      value: signedCodeverV3CommandSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('signed_event'),
      value: signedCodeverV3EventSchema,
    })
    .strict(),
])

export type CodeverV3Plaintext = z.infer<typeof codeverV3PlaintextSchema>

/** One content envelope is used for commands, events, edits and snapshots. */
export const codeverV3ContentEnvelopeSchema = z
  .object({
    kind: z.literal('codever.project-envelope'),
    version: z.literal(CODEVER_MATRIX_PROTOCOL_VERSION),
    roomId: matrixRoomId,
    projectId: opaqueId,
    keyId: opaqueId,
    logicalEventId: opaqueId,
    nonce: base64Url.length(16),
    ciphertext: base64Url.min(22).max(128 * 1024),
  })
  .strict()

export type CodeverV3ContentEnvelope = z.infer<
  typeof codeverV3ContentEnvelopeSchema
>

export const codeverV3TimelineContentSchema = z
  .object({
    msgtype: z.literal('m.notice'),
    body: z.literal('Encrypted Codever event'),
    'm.relates_to': z.record(z.string(), jsonValueSchema).optional(),
    [CODEVER_MATRIX_EXTENSION]: z
      .object({
        version: z.literal(CODEVER_MATRIX_PROTOCOL_VERSION),
        envelope: codeverV3ContentEnvelopeSchema,
      })
      .strict(),
  })
  .strict()

export const codeverV3CurrentPointerDocumentSchema = z
  .object({
    kind: z.enum(['workspace.current', 'project.current']),
    version: z.literal(CODEVER_MATRIX_PROTOCOL_VERSION),
    workspaceId: opaqueId,
    projectId: opaqueId.optional(),
    roomId: matrixRoomId,
    eventId: matrixEventId,
    logicalEventId: opaqueId,
    snapshotVersion: z.number().int().positive(),
    gatewayKeyId: opaqueId,
    updatedAt: timestamp,
  })
  .strict()

export const codeverV3CurrentPointerSchema = z
  .object({
    document: codeverV3CurrentPointerDocumentSchema,
    signature: signatureSchema,
  })
  .strict()

export type CodeverV3CurrentPointer = z.infer<
  typeof codeverV3CurrentPointerSchema
>

/**
 * Key grants are the only pairwise application envelope in v3. They are
 * directly addressable Matrix state and are never repeated on timeline data.
 */
export const codeverV3ProjectKeyGrantStateSchema = z
  .object({
    kind: z.literal('project.key_grant'),
    version: z.literal(CODEVER_MATRIX_PROTOCOL_VERSION),
    workspaceId: opaqueId,
    projectId: opaqueId,
    roomId: matrixRoomId,
    deviceId: opaqueId,
    certificateId: opaqueId,
    grantId: opaqueId,
    sealedGrant: z
      .object({
        envelope: z
          .object({
            kind: z.literal('codever.project-key-grant-envelope'),
            version: z.literal(CODEVER_MATRIX_PROTOCOL_VERSION),
            grantId: opaqueId,
            workspaceId: opaqueId,
            projectId: opaqueId,
            roomId: matrixRoomId,
            deviceId: opaqueId,
            certificateId: opaqueId,
            senderKeyId: base64Url.length(43),
            recipientKeyId: base64Url.length(43),
            nonce: base64Url.length(16),
            ciphertext: base64Url.min(22).max(64 * 1024),
          })
          .strict(),
        signature: signatureSchema,
      })
      .strict(),
  })
  .strict()

export const codeverV3ProjectKeyGrantPlaintextSchema = z
  .object({
    kind: z.literal('project.key_grant'),
    version: z.literal(CODEVER_MATRIX_PROTOCOL_VERSION),
    workspaceId: opaqueId,
    projectId: opaqueId,
    roomId: matrixRoomId,
    deviceId: opaqueId,
    certificateId: opaqueId,
    activeKeyId: opaqueId,
    keys: z
      .array(
        z
          .object({
            keyId: opaqueId,
            key: base64Url.length(43),
            createdAt: timestamp,
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict()
  .superRefine((grant, context) => {
    const ids = grant.keys.map(key => key.keyId)
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', path: ['keys'], message: 'Key IDs must be unique' })
    }
    if (!ids.includes(grant.activeKeyId)) {
      context.addIssue({
        code: 'custom',
        path: ['activeKeyId'],
        message: 'The active key must be included in the grant',
      })
    }
  })

export type CodeverV3ProjectKeyGrantPlaintext = z.infer<
  typeof codeverV3ProjectKeyGrantPlaintextSchema
>

export const codeverV3ProjectKeyGrantEnvelopeSchema =
  codeverV3ProjectKeyGrantStateSchema.shape.sealedGrant

export type CodeverV3ProjectKeyGrantEnvelope = z.infer<
  typeof codeverV3ProjectKeyGrantEnvelopeSchema
>
