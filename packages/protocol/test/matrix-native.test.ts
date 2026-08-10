import { describe, expect, it } from 'vitest'
import {
  matrixGatewayCheckpointSchema,
  matrixGatewayRevisionSchema,
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

  it('keeps the Gateway checkpoint free of a session inventory', () => {
    const checkpoint = matrixGatewayCheckpointSchema.parse({
      version: 2,
      kind: 'gateway_checkpoint',
      gateway_id: 'gateway-1',
      conversation_id: 'conversation-1',
      revision: 5,
      revision_epoch: 'epoch-1',
      revision_epoch_generation: 1,
      state_version: 3,
      active_device_count: 2,
      workspace: {
        project: { id: 'project-1', name: 'codever', cwd: '/srv/codever' },
        provider: 'codex',
        permission_mode: 'default',
      },
      capabilities: { canCreateSession: true },
      updated_at: 20,
    })
    expect(checkpoint).not.toHaveProperty('sessions')
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
