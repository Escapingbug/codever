import { describe, expect, it } from 'vitest'
import {
  CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE,
  CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE,
  matrixGatewayStateSchema,
  matrixSessionStateSchema,
  matrixGatewayRevisionSchema,
  matrixSessionLifecycleSchema,
  matrixSessionRootSchema,
  matrixThreadRelationSchema,
  matrixTimelineKeyGrantSchema,
  matrixTimelineKeyRingGrantSchema,
} from '../src/index.js'

describe('Matrix native conversation protocol', () => {
  it('models a Codever session as a Matrix thread root', () => {
    expect(matrixSessionRootSchema.parse({
      version: 2,
      kind: 'session_root',
      revision: 5,
      revision_epoch: 'revision-epoch-1',
      revision_epoch_generation: 1,
      session_id: 'session-1',
      title: 'Investigate sync',
      project: { id: 'project-1', name: 'codever', cwd: '/srv/codever' },
      created_at: 10,
      updated_at: 11,
      archived: false,
      status: 'running',
      provider: 'codex',
      permission_mode: 'default',
      extensions: [],
      source_command_id: 'command-1',
    }).session_id).toBe('session-1')
    expect(matrixThreadRelationSchema.parse({
      rel_type: 'm.thread',
      event_id: '$root:example.org',
      is_falling_back: true,
      'm.in_reply_to': { event_id: '$root:example.org' },
    }).rel_type).toBe('m.thread')
  })

  it('binds a lifecycle transition to the command whose result it proves', () => {
    expect(matrixSessionLifecycleSchema.parse({
      version: 2,
      kind: 'session_lifecycle',
      revision: 7,
      revision_epoch: 'revision-epoch-1',
      revision_epoch_generation: 1,
      session_id: 'session-1',
      state: 'deleted',
      updated_at: 12,
      source_command_id: 'command-delete-1',
    }).source_command_id).toBe('command-delete-1')
  })

  it('carries current Gateway metadata for a newly paired device', () => {
    const state = matrixGatewayStateSchema.parse({
      version: 2,
      kind: 'gateway_state',
      gateway_id: 'gateway-1',
      conversation_id: 'conversation-1',
      revision: 5,
      revision_epoch: 'epoch-1',
      revision_epoch_generation: 1,
      state_version: 3,
      active_device_count: 2,
      command_sequences: [
        { device_id: 'device-1', sequence_epoch: 'certificate-1', sequence: 4 },
        { device_id: 'device-2', sequence_epoch: 'certificate-2', sequence: 2 },
      ],
      workspace: {
        project: { id: 'project-1', name: 'codever', cwd: '/srv/codever' },
        provider: 'codex',
        permission_mode: 'default',
      },
      capabilities: {
        models: [],
        permission_modes: [{ id: 'default', name: 'Default' }],
        can_create_session: true,
        can_select_session: false,
        can_archive_session: true,
        can_delete_session: true,
        session_extensions: [],
      },
      session_directory: directory(3),
      updated_at: 20,
    })
    expect(state.workspace.project.id).toBe('project-1')
  })

  it('rejects incomplete or duplicate Gateway capabilities', () => {
    const base = {
      version: 2,
      kind: 'gateway_state',
      gateway_id: 'gateway-1',
      conversation_id: 'conversation-1',
      revision: 5,
      revision_epoch: 'epoch-1',
      revision_epoch_generation: 1,
      state_version: 3,
      active_device_count: 1,
      command_sequences: [],
      workspace: {
        project: { id: 'project-1', name: 'codever', cwd: '/srv/codever' },
        provider: 'codex',
        permission_mode: 'default',
      },
      session_directory: directory(3),
      updated_at: 20,
    }
    expect(matrixGatewayStateSchema.safeParse({
      ...base,
      capabilities: { can_create_session: true },
    }).success).toBe(false)
    expect(matrixGatewayStateSchema.safeParse({
      ...base,
      capabilities: {
        models: [],
        permission_modes: [
          { id: 'default', name: 'Default' },
          { id: 'default', name: 'Duplicate' },
        ],
        can_create_session: true,
        can_select_session: false,
        can_archive_session: true,
        can_delete_session: true,
        session_extensions: [],
      },
    }).success).toBe(false)
  })

  it('models each current session as its own Matrix room-state entity', () => {
    expect(CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE).toBe(
      'io.codever.gateway.current.v2',
    )
    expect(CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE).toBe(
      'io.codever.session.current.v2',
    )
    expect(matrixSessionStateSchema.parse({
      version: 2,
      kind: 'session_state',
      gateway_id: 'gateway-1',
      conversation_id: 'conversation-1',
      revision: 5,
      revision_epoch: 'epoch-1',
      revision_epoch_generation: 1,
      state_version: 3,
      session_id: 'session-1',
      state: 'active',
      session: {
        session_id: 'session-1',
        thread_root_event_id: '$session-root:example.org',
        title: 'Fix sync',
        updated_at: 19,
        archived: false,
        status: 'running',
        project: { id: 'project-1', name: 'codever', cwd: '/srv/codever' },
        provider: 'codex',
        extensions: [],
      },
      updated_at: 20,
      source_command_id: 'command-create-1',
    })).toMatchObject({
      source_command_id: 'command-create-1',
      session: { thread_root_event_id: '$session-root:example.org' },
    })
  })

  it('requires deleted session state to be a data-free tombstone', () => {
    const base = {
      version: 2 as const,
      kind: 'session_state' as const,
      gateway_id: 'gateway-1',
      conversation_id: 'conversation-1',
      revision: 6,
      revision_epoch: 'epoch-1',
      revision_epoch_generation: 1,
      state_version: 4,
      session_id: 'session-1',
      state: 'deleted' as const,
      updated_at: 21,
    }
    expect(matrixSessionStateSchema.parse(base).state).toBe('deleted')
    expect(matrixSessionStateSchema.safeParse({
      ...base,
      session: {
        session_id: 'session-1',
        title: 'stale',
        updated_at: 20,
        archived: false,
        status: 'idle',
        project: { id: 'p', name: 'p', cwd: '/p' },
        provider: 'codex',
        extensions: [],
      },
    }).success).toBe(false)
  })

  it('advances cross-device concurrency without publishing a state snapshot', () => {
    expect(matrixGatewayRevisionSchema.parse({
      version: 2,
      kind: 'gateway_revision',
      gateway_id: 'gateway-1',
      conversation_id: 'conversation-1',
      revision: 6,
      revision_epoch: 'epoch-1',
      revision_epoch_generation: 1,
      updated_at: 21,
      source_command_id: 'command-6',
    })).not.toHaveProperty('sessions')
  })

  it('requires a complete room-bound 32-byte timeline key grant', () => {
    expect(matrixTimelineKeyGrantSchema.parse({
      kind: 'timeline_key_grant',
      version: 2,
      gateway_id: 'gateway-1',
      conversation_id: 'conversation-1',
      room_id: '!room:example.org',
      epoch_id: 'timeline-epoch-1',
      key: 'A'.repeat(43),
      created_at: 10,
    }).epoch_id).toBe('timeline-epoch-1')
    expect(matrixTimelineKeyGrantSchema.safeParse({
      kind: 'timeline_key_grant',
      version: 2,
      gateway_id: 'gateway-1',
      conversation_id: 'conversation-1',
      room_id: '!room:example.org',
      epoch_id: 'timeline-epoch-1',
      key: 'short',
      created_at: 10,
    }).success).toBe(false)
  })

  it('bounds retained key epochs to the Matrix event-size budget', () => {
    const epochs = Array.from({ length: 65 }, (_, index) => ({
      epoch_id: `timeline-epoch-${index}`,
      key: 'A'.repeat(43),
      created_at: index,
    }))
    expect(matrixTimelineKeyRingGrantSchema.safeParse({
      kind: 'timeline_key_ring_grant',
      version: 2,
      gateway_id: 'gateway-1',
      conversation_id: 'conversation-1',
      room_id: '!room:example.org',
      active_epoch_id: 'timeline-epoch-64',
      epochs,
    }).success).toBe(false)
  })
})

function directory(stateVersion: number) {
  return {
    generation: stateVersion,
    state_version: stateVersion,
    slot: stateVersion % 3,
    page_count: 0,
    state_key_prefix: 'codever.directory',
    digest: 'RBNvo1WzZ4oRRq0W9-hknpT7T8If536DEMBg9hyq_4o',
  }
}
