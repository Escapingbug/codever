import { z } from 'zod'
import { signatureSchema } from './schema.js'
import { signedSecureEnvelopeBundleSchema } from './secure-envelope.js'

/** Pre-CVP/3 application envelope retained only for migration/boundary tests. */
export const LEGACY_MATRIX_NATIVE_ENVELOPE_VERSION = 2 as const
export const CODEVER_MATRIX_TIMELINE_CONTENT_TYPE =
  'io.codever.matrix-timeline-content.v2' as const
export const CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE =
  'io.codever.gateway.current.v2' as const
export const CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE =
  'io.codever.session.current.v2' as const
export const CODEVER_MATRIX_SESSION_DIRECTORY_EVENT_TYPE =
  'io.codever.session.directory.v2' as const
export const CODEVER_MATRIX_STATE_CONTENT_TYPE =
  'io.codever.matrix-state-content.v2' as const

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
    version: z.literal(LEGACY_MATRIX_NATIVE_ENVELOPE_VERSION),
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
    version: z.literal(LEGACY_MATRIX_NATIVE_ENVELOPE_VERSION),
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
    version: z.literal(LEGACY_MATRIX_NATIVE_ENVELOPE_VERSION),
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

const matrixCapabilityOptionSchema = z
  .object({
    id: opaqueId,
    name: z.string().min(1).max(256),
  })
  .strict()

const matrixSessionExtensionSettingSchema = z.discriminatedUnion('type', [
  z
    .object({
      id: z.string().min(1).max(128),
      type: z.literal('text'),
      label: z.string().min(1).max(256),
      description: z.string().max(2_048).optional(),
      required: z.boolean().optional(),
      placeholder: z.string().max(512).optional(),
      default_value: z.string().max(4_096).optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(128),
      type: z.literal('boolean'),
      label: z.string().min(1).max(256),
      description: z.string().max(2_048).optional(),
      default_value: z.boolean().optional(),
    })
    .strict(),
])

const matrixSessionExtensionCapabilitySchema = z
  .object({
    id: opaqueId,
    name: z.string().min(1).max(256),
    description: z.string().min(1).max(4_096),
    version: z.string().min(1).max(128),
    settings: z.array(matrixSessionExtensionSettingSchema).max(32),
  })
  .strict()
  .superRefine((extension, context) => {
    const ids = new Set<string>()
    extension.settings.forEach((setting, index) => {
      if (ids.has(setting.id)) {
        context.addIssue({
          code: 'custom',
          path: ['settings', index, 'id'],
          message: 'Session extension setting IDs must be unique',
        })
      }
      ids.add(setting.id)
    })
  })

export const matrixGatewayCapabilitiesSchema = z
  .object({
    models: z.array(
      matrixCapabilityOptionSchema.safeExtend({
        default_reasoning_level: z.string().min(1).max(64).optional(),
        supported_reasoning_levels: z.array(
          z.object({
            effort: z.string().min(1).max(64),
            description: z.string().max(4_096).optional(),
          }).strict(),
        ).max(64).optional(),
      }).strict(),
    ).max(256),
    permission_modes: z.array(matrixCapabilityOptionSchema).max(128),
    can_create_session: z.boolean(),
    can_select_session: z.boolean(),
    can_archive_session: z.boolean(),
    can_delete_session: z.boolean(),
    session_extensions: z.array(matrixSessionExtensionCapabilitySchema).max(128),
    web_push: z
      .object({
        /** VAPID P-256 public key, base64url encoded without padding. */
        vapid_public_key: base64Url.length(87),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((capabilities, context) => {
    for (const [field, values] of [
      ['models', capabilities.models],
      ['permission_modes', capabilities.permission_modes],
      ['session_extensions', capabilities.session_extensions],
    ] as const) {
      const ids = new Set<string>()
      values.forEach((value, index) => {
        if (ids.has(value.id)) {
          context.addIssue({
            code: 'custom',
            path: [field, index, 'id'],
            message: `${field} IDs must be unique`,
          })
        }
        ids.add(value.id)
      })
    }
  })

export type MatrixGatewayCapabilities = z.infer<
  typeof matrixGatewayCapabilitiesSchema
>

export const matrixSessionRootSchema = z
  .object({
    version: z.literal(LEGACY_MATRIX_NATIVE_ENVELOPE_VERSION),
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
    version: z.literal(LEGACY_MATRIX_NATIVE_ENVELOPE_VERSION),
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
    version: z.literal(LEGACY_MATRIX_NATIVE_ENVELOPE_VERSION),
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

export const matrixRoomSessionSchema = z
  .object({
    session_id: opaqueId,
    thread_root_event_id: z.string().min(1).max(512).optional(),
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

export type MatrixRoomSession = z.infer<typeof matrixRoomSessionSchema>

export const matrixSessionDirectoryDescriptorSchema = z
  .object({
    generation: z.number().int().nonnegative(),
    state_version: z.number().int().nonnegative(),
    slot: z.number().int().min(0).max(2),
    page_count: z.number().int().nonnegative().max(100_000),
    state_key_prefix: z.string().min(1).max(128),
    digest: keyId,
  })
  .strict()

export type MatrixSessionDirectoryDescriptor = z.infer<
  typeof matrixSessionDirectoryDescriptorSchema
>

export const matrixGatewayStateSchema = z
  .object({
    version: z.literal(LEGACY_MATRIX_NATIVE_ENVELOPE_VERSION),
    kind: z.literal('gateway_state'),
    gateway_id: opaqueId,
    conversation_id: opaqueId,
    revision: z.number().int().nonnegative(),
    revision_epoch: opaqueId,
    revision_epoch_generation: z.number().int().positive(),
    state_version: z.number().int().nonnegative(),
    active_device_count: z.number().int().positive(),
    command_sequences: z
      .array(z.object({
        device_id: opaqueId,
        sequence_epoch: opaqueId,
        sequence: z.number().int().nonnegative(),
      }).strict())
      .max(256)
      .superRefine((values, context) => {
        const identities = values.map(value => `${value.device_id}\u0000${value.sequence_epoch}`)
        if (new Set(identities).size !== identities.length) {
          context.addIssue({
            code: 'custom',
            message: 'Gateway command sequence identities must be unique',
          })
        }
      }),
    workspace: z
      .object({
        project: projectSummarySchema,
        provider: z.string().min(1).max(256),
        model: z.string().min(1).max(256).optional(),
        reasoning_effort: z.string().min(1).max(64).optional(),
        permission_mode: z.string().min(1).max(128),
      })
      .strict(),
    capabilities: matrixGatewayCapabilitiesSchema,
    session_directory: matrixSessionDirectoryDescriptorSchema,
    updated_at: timestamp,
  })
  .strict()

export type MatrixGatewayState = z.infer<
  typeof matrixGatewayStateSchema
>

export const matrixSessionStateSchema = z
  .object({
    version: z.literal(LEGACY_MATRIX_NATIVE_ENVELOPE_VERSION),
    kind: z.literal('session_state'),
    gateway_id: opaqueId,
    conversation_id: opaqueId,
    ...revisionFields,
    state_version: z.number().int().nonnegative(),
    session_id: opaqueId,
    state: z.enum(['active', 'archived', 'deleted']),
    session: matrixRoomSessionSchema.optional(),
    updated_at: timestamp,
    /** The desired-state command whose durable result is this entity value. */
    source_command_id: opaqueId.optional(),
  })
  .strict()
  .superRefine((state, context) => {
    if (state.state === 'deleted' && state.session !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['session'],
        message: 'Deleted session state must be a tombstone without session data',
      })
    }
    if (state.state !== 'deleted' && state.session === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['session'],
        message: 'Active and archived session state requires session data',
      })
    }
    if (state.session && state.session.session_id !== state.session_id) {
      context.addIssue({
        code: 'custom',
        path: ['session', 'session_id'],
        message: 'Nested session ID must match the state entity ID',
      })
    }
  })

export type MatrixSessionState = z.infer<
  typeof matrixSessionStateSchema
>

export const matrixSessionDirectoryPageSchema = z
  .object({
    version: z.literal(LEGACY_MATRIX_NATIVE_ENVELOPE_VERSION),
    kind: z.literal('session_directory'),
    gateway_id: opaqueId,
    conversation_id: opaqueId,
    ...revisionFields,
    state_version: z.number().int().nonnegative(),
    directory_generation: z.number().int().nonnegative(),
    directory_slot: z.number().int().min(0).max(2),
    directory_digest: keyId,
    state_key_prefix: z.string().min(1).max(128),
    page_index: z.number().int().nonnegative().max(99_999),
    page_count: z.number().int().positive().max(100_000),
    sessions: z.array(matrixRoomSessionSchema).max(32),
    updated_at: timestamp,
  })
  .strict()
  .superRefine((page, context) => {
    if (page.page_index >= page.page_count) {
      context.addIssue({
        code: 'custom',
        path: ['page_index'],
        message: 'Directory page index must be smaller than page count',
      })
    }
    const sessionIds = page.sessions.map(session => session.session_id)
    if (new Set(sessionIds).size !== sessionIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['sessions'],
        message: 'Directory page session IDs must be unique',
      })
    }
  })

export type MatrixSessionDirectoryPage = z.infer<
  typeof matrixSessionDirectoryPageSchema
>

export const matrixStateEnvelopeHeaderSchema = z
  .object({
    kind: z.literal('codever.matrix-state-envelope'),
    version: z.literal(LEGACY_MATRIX_NATIVE_ENVELOPE_VERSION),
    contentType: z.literal(CODEVER_MATRIX_STATE_CONTENT_TYPE),
    gatewayId: opaqueId,
    conversationId: opaqueId,
    roomId: opaqueId,
    eventType: z.enum([
      CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE,
      CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE,
      CODEVER_MATRIX_SESSION_DIRECTORY_EVENT_TYPE,
    ]),
    stateKey: opaqueId,
    epochId: opaqueId,
    stateVersion: z.number().int().nonnegative(),
    issuedAt: timestamp,
    nonce: base64Url.length(16),
  })
  .strict()

export const matrixStateEnvelopeSchema = matrixStateEnvelopeHeaderSchema
  .safeExtend({ ciphertext: base64Url.min(22).max(32 * 1024) })
  .strict()

export const signedMatrixStateEnvelopeSchema = z
  .object({
    envelope: matrixStateEnvelopeSchema,
    signature: signatureSchema,
  })
  .strict()

export type SignedMatrixStateEnvelope = z.infer<
  typeof signedMatrixStateEnvelopeSchema
>

export const matrixStateContentSchema = z.discriminatedUnion('kind', [
  matrixGatewayStateSchema,
  matrixSessionStateSchema,
  matrixSessionDirectoryPageSchema,
])

export type MatrixStateContent = z.infer<typeof matrixStateContentSchema>

export const matrixStateEventContentSchema = z
  .object({
    version: z.literal(LEGACY_MATRIX_NATIVE_ENVELOPE_VERSION),
    kind: z.literal('state_envelope'),
    state_envelope: signedMatrixStateEnvelopeSchema,
    // Gateway state distributes the addressed key ring. Session entities reuse
    // that epoch key so their independent replacement events stay small.
    timeline_key_ring_bundle: signedSecureEnvelopeBundleSchema.optional(),
  })
    .strict()

export type MatrixStateEventContent = z.infer<
  typeof matrixStateEventContentSchema
>

export const matrixGatewayRevisionSchema = z
  .object({
    version: z.literal(LEGACY_MATRIX_NATIVE_ENVELOPE_VERSION),
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
  matrixGatewayRevisionSchema,
])

export type MatrixNativeContent = z.infer<typeof matrixNativeContentSchema>
