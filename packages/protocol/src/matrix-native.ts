import { z } from 'zod'
import { jsonValueSchema, signatureSchema } from './schema.js'

export const MATRIX_NATIVE_PROTOCOL_VERSION = 2 as const
export const CODEVER_MATRIX_TIMELINE_CONTENT_TYPE =
  'io.codever.matrix-timeline-content.v2' as const

const opaqueId = z.string().min(1).max(256)
const timestamp = z.number().int().nonnegative()
const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/)
const keyId = base64Url.length(43)
const revisionFields = {
  revision: z.number().int().nonnegative(),
  revision_epoch: opaqueId,
  revision_epoch_generation: z.number().int().positive(),
}

export const matrixThreadRelationSchema = z
  .object({
    rel_type: z.literal('m.thread'),
    event_id: opaqueId,
    is_falling_back: z.boolean().optional(),
    'm.in_reply_to': z
      .object({ event_id: opaqueId })
      .strict()
      .optional(),
  })
  .strict()

export type MatrixThreadRelation = z.infer<typeof matrixThreadRelationSchema>

export const matrixTimelineKeyGrantSchema = z
  .object({
    kind: z.literal('timeline_key_grant'),
    version: z.literal(MATRIX_NATIVE_PROTOCOL_VERSION),
    gateway_id: opaqueId,
    conversation_id: opaqueId,
    room_id: opaqueId,
    epoch_id: opaqueId,
    /** Raw 32-byte AES key, base64url encoded without padding. */
    key: base64Url.length(43),
    created_at: timestamp,
  })
  .strict()

export type MatrixTimelineKeyGrant = z.infer<typeof matrixTimelineKeyGrantSchema>

export const matrixTimelineKeyRingGrantSchema = z
  .object({
    kind: z.literal('timeline_key_ring_grant'),
    version: z.literal(MATRIX_NATIVE_PROTOCOL_VERSION),
    gateway_id: opaqueId,
    conversation_id: opaqueId,
    room_id: opaqueId,
    active_epoch_id: opaqueId,
    epochs: z.array(
      z
        .object({
          epoch_id: opaqueId,
          key: base64Url.length(43),
          created_at: timestamp,
        })
        .strict(),
    ).min(1).max(64),
  })
  .strict()
  .superRefine((grant, context) => {
    const ids = new Set<string>()
    grant.epochs.forEach((epoch, index) => {
      if (ids.has(epoch.epoch_id)) {
        context.addIssue({
          code: 'custom',
          path: ['epochs', index, 'epoch_id'],
          message: 'Timeline key epoch IDs must be unique',
        })
      }
      ids.add(epoch.epoch_id)
    })
    if (!ids.has(grant.active_epoch_id)) {
      context.addIssue({
        code: 'custom',
        path: ['active_epoch_id'],
        message: 'Timeline key ring must contain its active epoch',
      })
    }
  })

export type MatrixTimelineKeyRingGrant = z.infer<
  typeof matrixTimelineKeyRingGrantSchema
>

export const matrixTimelineEnvelopeHeaderSchema = z
  .object({
    kind: z.literal('codever.matrix-timeline-envelope'),
    version: z.literal(MATRIX_NATIVE_PROTOCOL_VERSION),
    envelopeId: opaqueId,
    contentType: z.literal(CODEVER_MATRIX_TIMELINE_CONTENT_TYPE),
    gatewayId: opaqueId,
    conversationId: opaqueId,
    roomId: opaqueId,
    epochId: opaqueId,
    logicalEventId: opaqueId,
    sessionId: opaqueId.optional(),
    threadRootEventId: opaqueId.optional(),
    issuedAt: timestamp,
    /** 96-bit AES-GCM nonce, base64url encoded without padding. */
    nonce: base64Url.length(16),
  })
  .strict()
  .superRefine((header, context) => {
    if (header.threadRootEventId && !header.sessionId) {
      context.addIssue({
        code: 'custom',
        path: ['sessionId'],
        message: 'Threaded timeline events must bind a sessionId',
      })
    }
  })

export type MatrixTimelineEnvelopeHeader = z.infer<
  typeof matrixTimelineEnvelopeHeaderSchema
>

export const matrixTimelineEnvelopeSchema = matrixTimelineEnvelopeHeaderSchema
  .safeExtend({
    ciphertext: base64Url.min(22).max(32 * 1024),
  })
  .strict()

export type MatrixTimelineEnvelope = z.infer<typeof matrixTimelineEnvelopeSchema>

export const signedMatrixTimelineEnvelopeSchema = z
  .object({
    envelope: matrixTimelineEnvelopeSchema,
    signature: signatureSchema,
  })
  .strict()

export type SignedMatrixTimelineEnvelope = z.infer<
  typeof signedMatrixTimelineEnvelopeSchema
>

const projectSummarySchema = z
  .object({
    id: opaqueId,
    name: z.string().min(1).max(256),
    cwd: z.string().min(1).max(8_192),
  })
  .strict()

export const matrixSessionRootSchema = z
  .object({
    version: z.literal(MATRIX_NATIVE_PROTOCOL_VERSION),
    kind: z.literal('session_root'),
    ...revisionFields,
    session_id: opaqueId,
    title: z.string().min(1).max(512),
    project: projectSummarySchema,
    created_at: timestamp,
    updated_at: timestamp,
    archived: z.boolean(),
    status: z.enum(['idle', 'running', 'stopping', 'failed']),
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(256).optional(),
    reasoning_effort: z.string().min(1).max(64).optional(),
    permission_mode: z.string().min(1).max(128),
    extensions: z.array(
      z.object({
        id: opaqueId,
        name: z.string().min(1).max(256),
        version: z.string().min(1).max(64),
      }).strict(),
    ).max(128),
    source_command_id: opaqueId.optional(),
  })
  .strict()

export type MatrixSessionRoot = z.infer<typeof matrixSessionRootSchema>

export const matrixSessionUpdateSchema = z
  .object({
    version: z.literal(MATRIX_NATIVE_PROTOCOL_VERSION),
    kind: z.literal('session_update'),
    ...revisionFields,
    session_id: opaqueId,
    updated_at: timestamp,
    title: z.string().min(1).max(512).optional(),
    project: projectSummarySchema.optional(),
    provider: z.string().min(1).max(256).optional(),
    model: z.string().min(1).max(256).nullable().optional(),
    reasoning_effort: z.string().min(1).max(64).nullable().optional(),
    permission_mode: z.string().min(1).max(128).optional(),
    extensions: z.array(
      z.object({
        id: opaqueId,
        name: z.string().min(1).max(256),
        version: z.string().min(1).max(64),
      }).strict(),
    ).max(128).optional(),
    source_command_id: opaqueId.optional(),
  })
  .strict()

export type MatrixSessionUpdate = z.infer<typeof matrixSessionUpdateSchema>

export const matrixSessionLifecycleSchema = z
  .object({
    version: z.literal(MATRIX_NATIVE_PROTOCOL_VERSION),
    kind: z.literal('session_lifecycle'),
    ...revisionFields,
    session_id: opaqueId,
    state: z.enum(['idle', 'running', 'stopping', 'failed', 'archived', 'deleted']),
    updated_at: timestamp,
    source_command_id: opaqueId.optional(),
    error: z.string().max(8_192).optional(),
  })
  .strict()

export type MatrixSessionLifecycle = z.infer<typeof matrixSessionLifecycleSchema>

const matrixCheckpointSessionSchema = z
  .object({
    session_id: opaqueId,
    title: z.string().min(1).max(512),
    updated_at: timestamp,
    archived: z.boolean(),
    status: z.enum(['idle', 'running', 'stopping', 'failed']),
    activity_phase: z
      .enum(['starting', 'working', 'stopping', 'idle', 'failed'])
      .optional(),
    project: projectSummarySchema,
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(256).optional(),
    reasoning_effort: z.string().min(1).max(64).optional(),
    extensions: z.array(
      z.object({
        id: opaqueId,
        name: z.string().min(1).max(256),
        version: z.string().min(1).max(64),
      }).strict(),
    ).max(128),
  })
  .strict()

export const matrixGatewayCheckpointSchema = z
  .object({
    version: z.literal(MATRIX_NATIVE_PROTOCOL_VERSION),
    kind: z.literal('gateway_checkpoint'),
    gateway_id: opaqueId,
    conversation_id: opaqueId,
    revision: z.number().int().nonnegative(),
    revision_epoch: opaqueId,
    revision_epoch_generation: z.number().int().positive(),
    state_version: z.number().int().nonnegative(),
    active_device_count: z.number().int().positive(),
    sessions: z.array(matrixCheckpointSessionSchema).max(2_048),
    workspace: z
      .object({
        project: projectSummarySchema,
        provider: z.string().min(1).max(256),
        model: z.string().min(1).max(256).optional(),
        reasoning_effort: z.string().min(1).max(64).optional(),
        permission_mode: z.string().min(1).max(128),
      })
      .strict(),
    capabilities: jsonValueSchema,
    updated_at: timestamp,
  })
  .strict()

export type MatrixGatewayCheckpoint = z.infer<typeof matrixGatewayCheckpointSchema>

export const matrixGatewayRevisionSchema = z
  .object({
    version: z.literal(MATRIX_NATIVE_PROTOCOL_VERSION),
    kind: z.literal('gateway_revision'),
    ...revisionFields,
    gateway_id: opaqueId,
    conversation_id: opaqueId,
    updated_at: timestamp,
    source_command_id: opaqueId,
  })
  .strict()

export type MatrixGatewayRevision = z.infer<typeof matrixGatewayRevisionSchema>

export const matrixNativeContentSchema = z.discriminatedUnion('kind', [
  matrixSessionRootSchema,
  matrixSessionUpdateSchema,
  matrixSessionLifecycleSchema,
  matrixGatewayCheckpointSchema,
  matrixGatewayRevisionSchema,
])

export type MatrixNativeContent = z.infer<typeof matrixNativeContentSchema>
