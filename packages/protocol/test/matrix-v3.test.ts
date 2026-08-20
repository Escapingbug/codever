import { describe, expect, it } from 'vitest'
import {
  codeverV3CommandSchema,
  codeverV3EventSchema,
  codeverV3ProjectKeyGrantPlaintextSchema,
} from '../src/matrix-v3.js'

describe('Matrix-native protocol v3', () => {
  it('uses a client-allocated session id without sequence or revision fields', () => {
    const command = codeverV3CommandSchema.parse({
      kind: 'codever.command',
      version: 3,
      commandId: 'command-create-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      deviceId: 'device-1',
      certificateId: 'certificate-1',
      createdAt: 1,
      operation: 'session.create',
      payload: {
        operation: 'session.create',
        title: 'Investigate bug',
        initialPrompt: { text: 'Reproduce the failure' },
      },
    })

    expect(command.sessionId).toBe('session-1')
    expect(command).not.toHaveProperty('sequence')
    expect(command).not.toHaveProperty('baseRevision')
    expect(command).not.toHaveProperty('revisionEpoch')
    expect(command).not.toHaveProperty('nonce')
  })

  it('requires the exact business address instead of a global revision', () => {
    expect(() => codeverV3CommandSchema.parse({
      kind: 'codever.command',
      version: 3,
      commandId: 'command-prompt-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      deviceId: 'device-1',
      certificateId: 'certificate-1',
      createdAt: 1,
      operation: 'prompt.submit',
      payload: { operation: 'prompt.submit', text: 'hello' },
    })).toThrow('Session is required')
  })

  it('models lifecycle as an idempotent desired state', () => {
    expect(codeverV3CommandSchema.parse({
      kind: 'codever.command',
      version: 3,
      commandId: 'command-delete-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      deviceId: 'device-1',
      certificateId: 'certificate-1',
      createdAt: 1,
      operation: 'session.set_lifecycle',
      payload: { operation: 'session.set_lifecycle', state: 'deleted' },
    }).payload).toEqual({ operation: 'session.set_lifecycle', state: 'deleted' })
  })

  it('uses entity-local message versions for streaming output', () => {
    const event = codeverV3EventSchema.parse({
      kind: 'codever.event',
      version: 3,
      eventId: 'event-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      occurredAt: 2,
      causationCommandId: 'command-prompt-1',
      payload: {
        type: 'assistant.message',
        messageId: 'message-1',
        messageVersion: 2,
        body: 'complete answer',
        final: true,
        projection: {
          title: 'Investigate bug',
          lifecycle: 'active',
          activity: 'idle',
          updatedAt: 2,
          stateVersion: 3,
        },
      },
    })
    expect(event.payload).toMatchObject({ messageId: 'message-1', messageVersion: 2 })
  })

  it('grants retained project keys once per device and validates the active key', () => {
    expect(codeverV3ProjectKeyGrantPlaintextSchema.parse({
      kind: 'project.key_grant',
      version: 3,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      roomId: '!project:example.org',
      deviceId: 'device-1',
      certificateId: 'certificate-1',
      activeKeyId: 'key-2',
      keys: [
        { keyId: 'key-1', key: 'A'.repeat(43), createdAt: 1 },
        { keyId: 'key-2', key: 'B'.repeat(43), createdAt: 2 },
      ],
    }).keys).toHaveLength(2)
  })
})

