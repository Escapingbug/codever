import { z } from 'zod'
import { matrixGatewayCapabilitiesSchema } from './matrix-native.js'
import {
  attachmentSchema,
  jsonValueSchema,
  sessionExtensionActionIdSchema,
  sessionExtensionBindingSchema,
  sessionExtensionDescriptorSchema,
  sessionExtensionSummarySchema,
  sessionExtensionViewSchema,
  signatureSchema,
} from './schema.js'

/**
 * Codever Protocol version 3 (CVP/3).
 *
 * CVP owns execution authorization, business semantics and project-content
 * encryption. Matrix is the current durable transport and owns rooms,
 * threads, history, relations and incremental sync; it is not the protocol
 * named by this version number.
 */
export const CODEVER_PROTOCOL_NAME = 'Codever Protocol' as const
export const CODEVER_PROTOCOL_ACRONYM = 'CVP' as const
export const CODEVER_PROTOCOL_VERSION = 3 as const
export const CODEVER_PROTOCOL_LABEL = 'CVP/3' as const

export const CVP3_MATRIX_TIMELINE_EVENT_TYPE = 'm.room.message' as const
export const CODEVER_MATRIX_EXTENSION = 'io.codever' as const
export const CVP3_MATRIX_PROJECT_POINTER_EVENT_TYPE =
  'io.codever.project.current.v3' as const
export const CVP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE =
  'io.codever.workspace.current.v3' as const
export const CVP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE =
  'io.codever.project.key_grant.v3' as const

const opaqueId = z.string().min(1).max(256)
const requiredProjectId = z.string({ error: 'Project is required' }).min(1).max(256)
const requiredSessionId = z.string({ error: 'Session is required' }).min(1).max(256)
const matrixRoomId = z.string().min(1).max(512)
const matrixEventId = z.string().min(1).max(512)
const timestamp = z.number().int().nonnegative()
const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/)

export const webPushSubscriptionSchema = z
  .object({
    endpoint: z.string().url().max(4_096).refine(value => {
      try {
        const endpoint = new URL(value)
        return endpoint.protocol === 'https:'
          && !endpoint.username
          && !endpoint.password
          && !endpoint.hash
      } catch {
        return false
      }
    }, 'Web Push endpoint must be a credential-free HTTPS URL'),
    expirationTime: timestamp.nullable().optional(),
    keys: z
      .object({
        p256dh: base64Url.min(32).max(256),
        auth: base64Url.min(16).max(128),
      })
      .strict(),
  })
  .strict()

export type WebPushSubscription = z.infer<typeof webPushSubscriptionSchema>

export const cvp3SessionExtensionBindingSchema = sessionExtensionBindingSchema

const sessionSettingsPatchSchema = z
  .object({
    title: z.string().min(1).max(512).optional(),
    model: z.string().min(1).max(256).nullable().optional(),
    provider: z.string().min(1).max(256).optional(),
    reasoningEffort: z.string().min(1).max(64).nullable().optional(),
    permissionMode: z
      .enum(['default', 'accept_edits', 'plan', 'bypass_permissions'])
      .optional(),
    extensions: z.array(cvp3SessionExtensionBindingSchema).max(8).optional(),
  })
  .strict()
  .refine(value => Object.values(value).some(field => field !== undefined), {
    message: 'A session update requires at least one changed field',
  })

const sessionCreatePayloadSchema = z
  .object({
    operation: z.literal('session.create'),
    scope: z.enum(['project', 'scratch']).optional(),
    title: z.string().min(1).max(512).optional(),
    model: z.string().min(1).max(256).optional(),
    provider: z.string().min(1).max(256).optional(),
    reasoningEffort: z.string().min(1).max(64).optional(),
    permissionMode: z
      .enum(['default', 'accept_edits', 'plan', 'bypass_permissions'])
      .optional(),
    extensions: z.array(cvp3SessionExtensionBindingSchema).max(8).optional(),
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
    totp: z.string().regex(/^\d{6}$/u).optional(),
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
const projectUpdatePayloadSchema = z
  .object({
    operation: z.literal('project.update'),
    patch: z
      .object({
        defaultExtensions: z.array(cvp3SessionExtensionBindingSchema).max(8),
      })
      .strict(),
  })
  .strict()
const notificationSubscribePayloadSchema = z
  .object({
    operation: z.literal('notification.subscribe'),
    subscription: webPushSubscriptionSchema,
  })
  .strict()
const notificationUnsubscribePayloadSchema = z
  .object({
    operation: z.literal('notification.unsubscribe'),
    endpoint: z.string().url().max(4_096).optional(),
  })
  .strict()

export const cvp3CommandPayloadSchema = z.discriminatedUnion('operation', [
  sessionCreatePayloadSchema,
  promptSubmitPayloadSchema,
  turnCancelPayloadSchema,
  decisionAnswerPayloadSchema,
  sessionUpdatePayloadSchema,
  sessionLifecyclePayloadSchema,
  projectUpdatePayloadSchema,
  deviceInvitationPayloadSchema,
  notificationSubscribePayloadSchema,
  notificationUnsubscribePayloadSchema,
])

export type Cvp3CommandPayload = z.infer<
  typeof cvp3CommandPayloadSchema
>
export type Cvp3CommandOperation = Cvp3CommandPayload['operation']

const commandCommon = {
  kind: z.literal('codever.command'),
  version: z.literal(CODEVER_PROTOCOL_VERSION),
  commandId: opaqueId,
  workspaceId: opaqueId,
  deviceId: opaqueId,
  certificateId: opaqueId,
  createdAt: timestamp,
}

const projectCommandCommon = { ...commandCommon, projectId: requiredProjectId }
const sessionCommandCommon = { ...projectCommandCommon, sessionId: requiredSessionId }

/** The whole command is a discriminated union, not merely its payload. */
export const cvp3CommandSchema = z.union([
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
    ...projectCommandCommon,
    sessionId: z.undefined().optional(),
    operation: z.literal('project.update'),
    payload: projectUpdatePayloadSchema,
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
  z.object({
    ...projectCommandCommon,
    sessionId: z.undefined().optional(),
    operation: z.literal('notification.subscribe'),
    payload: notificationSubscribePayloadSchema,
  }).strict(),
  z.object({
    ...projectCommandCommon,
    sessionId: z.undefined().optional(),
    operation: z.literal('notification.unsubscribe'),
    payload: notificationUnsubscribePayloadSchema,
  }).strict(),
])

export type Cvp3Command = z.infer<typeof cvp3CommandSchema>

export const signedCvp3CommandSchema = z
  .object({ command: cvp3CommandSchema, signature: signatureSchema })
  .strict()

export type SignedCvp3Command = z.infer<
  typeof signedCvp3CommandSchema
>

const sessionProjectionSchema = z
  .object({
    title: z.string().min(1).max(512),
    scope: z.enum(['project', 'scratch']).optional(),
    cwd: z.string().min(1).max(8_192).optional(),
    lifecycle: z.enum(['active', 'archived', 'deleted']),
    activity: z.enum(['idle', 'queued', 'working', 'attention', 'failed']),
    updatedAt: timestamp,
    stateVersion: z.number().int().positive(),
    extensions: z.array(sessionExtensionSummarySchema).max(8).optional(),
    extensionRevision: z.number().int().positive().optional(),
  })
  .strict()

export type Cvp3SessionProjection = z.infer<
  typeof sessionProjectionSchema
>

export const cvp3EventPayloadSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('workspace.snapshot'),
      protocolMin: z.number().int().positive(),
      protocolMax: z.number().int().positive(),
      gatewayKeyId: opaqueId,
      capabilities: matrixGatewayCapabilitiesSchema,
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
      installedExtensions: z.array(sessionExtensionDescriptorSchema).max(64).optional(),
      defaultExtensions: z.array(cvp3SessionExtensionBindingSchema).max(8).optional(),
      extensionDefaultsRevision: z.number().int().positive().optional(),
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
      extensionBindings: z.array(cvp3SessionExtensionBindingSchema).max(8).optional(),
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
      type: z.literal('inbox.file.received'),
      fileId: opaqueId,
      caption: z.string().max(8_192).optional(),
      source: z
        .object({
          kind: z.literal('local-cli'),
          label: z.string().min(1).max(256).optional(),
        })
        .strict(),
      attachment: attachmentSchema,
    })
    .strict(),
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
      decisionType: z.enum(['permission', 'question', 'privilege']).default('permission'),
      requestId: opaqueId,
      title: z.string().min(1).max(1_024),
      details: jsonValueSchema.optional(),
      options: z
        .array(z.object({ label: z.string(), value: z.string() }).strict())
        .min(1)
        .max(16),
      expiresAt: timestamp.optional(),
      projection: sessionProjectionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('extension.interaction.requested'),
      requestId: opaqueId,
      extension: sessionExtensionSummarySchema,
      view: sessionExtensionViewSchema,
      cancelActionId: sessionExtensionActionIdSchema,
      projection: sessionProjectionSchema,
    })
    .strict()
    .refine(
      value => value.view.actions.some(action => action.id === value.cancelActionId),
      { message: 'Extension interaction cancel action must be present in the view' },
    ),
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
      type: z.literal('extension.interaction.resolved'),
      requestId: opaqueId,
      extensionId: opaqueId,
      actionId: sessionExtensionActionIdSchema,
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
  z
    .object({
      type: z.literal('notification.subscription.changed'),
      enabled: z.boolean(),
    })
    .strict(),
])

export type Cvp3EventPayload = z.infer<typeof cvp3EventPayloadSchema>

export const cvp3EventSchema = z
  .object({
    kind: z.literal('codever.event'),
    version: z.literal(CODEVER_PROTOCOL_VERSION),
    eventId: opaqueId,
    workspaceId: opaqueId,
    projectId: opaqueId.optional(),
    sessionId: opaqueId.optional(),
    occurredAt: timestamp,
    causationCommandId: opaqueId.optional(),
    payload: cvp3EventPayloadSchema,
  })
  .strict()

export type Cvp3Event = z.infer<typeof cvp3EventSchema>

export const signedCvp3EventSchema = z
  .object({ event: cvp3EventSchema, signature: signatureSchema })
  .strict()

export type SignedCvp3Event = z.infer<typeof signedCvp3EventSchema>

export const cvp3PlaintextSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('signed_command'),
      value: signedCvp3CommandSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('signed_event'),
      value: signedCvp3EventSchema,
    })
    .strict(),
])

export type Cvp3Plaintext = z.infer<typeof cvp3PlaintextSchema>

/** One content envelope is used for commands, events, edits and snapshots. */
export const cvp3ContentEnvelopeSchema = z
  .object({
    kind: z.literal('codever.project-envelope'),
    version: z.literal(CODEVER_PROTOCOL_VERSION),
    roomId: matrixRoomId,
    projectId: opaqueId,
    keyId: opaqueId,
    logicalEventId: opaqueId,
    nonce: base64Url.length(16),
    ciphertext: base64Url.min(22).max(128 * 1024),
  })
  .strict()

export type Cvp3ContentEnvelope = z.infer<
  typeof cvp3ContentEnvelopeSchema
>

export const cvp3TimelineContentSchema = z
  .object({
    msgtype: z.literal('m.notice'),
    body: z.literal('Encrypted Codever event'),
    'm.relates_to': z.record(z.string(), jsonValueSchema).optional(),
    [CODEVER_MATRIX_EXTENSION]: z
      .object({
        version: z.literal(CODEVER_PROTOCOL_VERSION),
        envelope: cvp3ContentEnvelopeSchema,
      })
      .strict(),
  })
  .strict()

export const cvp3CurrentPointerDocumentSchema = z
  .object({
    kind: z.enum(['workspace.current', 'project.current']),
    version: z.literal(CODEVER_PROTOCOL_VERSION),
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

export const cvp3CurrentPointerSchema = z
  .object({
    document: cvp3CurrentPointerDocumentSchema,
    signature: signatureSchema,
  })
  .strict()

export type Cvp3CurrentPointer = z.infer<
  typeof cvp3CurrentPointerSchema
>

/**
 * Key grants are the only pairwise application envelope in CVP/3. They are
 * directly addressable Matrix state and are never repeated on timeline data.
 */
export const cvp3ProjectKeyGrantStateSchema = z
  .object({
    kind: z.literal('project.key_grant'),
    version: z.literal(CODEVER_PROTOCOL_VERSION),
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
            version: z.literal(CODEVER_PROTOCOL_VERSION),
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

export const cvp3ProjectKeyGrantPlaintextSchema = z
  .object({
    kind: z.literal('project.key_grant'),
    version: z.literal(CODEVER_PROTOCOL_VERSION),
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

export type Cvp3ProjectKeyGrantPlaintext = z.infer<
  typeof cvp3ProjectKeyGrantPlaintextSchema
>

export const cvp3ProjectKeyGrantEnvelopeSchema =
  cvp3ProjectKeyGrantStateSchema.shape.sealedGrant

export type Cvp3ProjectKeyGrantEnvelope = z.infer<
  typeof cvp3ProjectKeyGrantEnvelopeSchema
>
