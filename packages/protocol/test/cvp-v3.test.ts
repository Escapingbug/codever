import { describe, expect, it } from 'vitest'
import {
  cvp3CommandSchema,
  cvp3EventSchema,
  cvp3ProjectKeyGrantPlaintextSchema,
} from '../src/cvp-v3.js'

describe('Codever Protocol v3 (CVP/3)', () => {
  it('uses a client-allocated session id without sequence or revision fields', () => {
    const command = cvp3CommandSchema.parse({
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

  it('creates scratch sessions and workspace inbox files as explicit non-project semantics', () => {
    const command = cvp3CommandSchema.parse({
      kind: 'codever.command',
      version: 3,
      commandId: 'command-scratch-1',
      workspaceId: 'workspace-1',
      projectId: 'transport-project-1',
      sessionId: 'session-scratch-1',
      deviceId: 'device-1',
      certificateId: 'certificate-1',
      createdAt: 1,
      operation: 'session.create',
      payload: { operation: 'session.create', scope: 'scratch' },
    })
    expect(command.payload).toMatchObject({ scope: 'scratch' })

    const event = cvp3EventSchema.parse({
      kind: 'codever.event',
      version: 3,
      eventId: 'workspace-file-event-1',
      workspaceId: 'workspace-1',
      projectId: 'transport-project-1',
      occurredAt: 2,
      payload: {
        type: 'inbox.file.received',
        fileId: 'workspace-file-1',
        caption: 'Generated report',
        source: { kind: 'local-cli', label: 'review-agent' },
        attachment: testAttachment(),
      },
    })
    expect(event.sessionId).toBeUndefined()
    expect(event.payload).toMatchObject({ type: 'inbox.file.received' })
  })

  it('requires the exact business address instead of a global revision', () => {
    expect(() => cvp3CommandSchema.parse({
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
    expect(cvp3CommandSchema.parse({
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

  it('carries a six-digit TOTP only on an approval response', () => {
    const command = cvp3CommandSchema.parse({
      kind: 'codever.command',
      version: 3,
      commandId: 'command-privilege-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      deviceId: 'device-1',
      certificateId: 'certificate-1',
      createdAt: 1,
      operation: 'decision.answer',
      payload: {
        operation: 'decision.answer',
        requestId: 'privilege-request-1',
        decision: 'allow_once',
        totp: '123456',
      },
    })
    expect(command.payload).toMatchObject({ totp: '123456' })
    expect(() => cvp3CommandSchema.parse({
      ...command,
      payload: { ...command.payload, totp: '12345' },
    })).toThrow()
  })

  it('models extension-owned views and project defaults without privacy-specific fields', () => {
    const command = cvp3CommandSchema.parse({
      kind: 'codever.command',
      version: 3,
      commandId: 'project-extension-defaults-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      deviceId: 'device-1',
      certificateId: 'certificate-1',
      createdAt: 1,
      operation: 'project.update',
      payload: {
        operation: 'project.update',
        patch: { defaultExtensions: [{ id: 'prefix-transform', config: { prefix: 'SAFE:' } }] },
      },
    })
    expect(command.payload).toMatchObject({
      patch: { defaultExtensions: [{ id: 'prefix-transform' }] },
    })

    expect(cvp3EventSchema.parse({
      kind: 'codever.event',
      version: 3,
      eventId: 'extension-interaction-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      occurredAt: 2,
      payload: {
        type: 'extension.interaction.requested',
        requestId: 'request-1',
        extension: { id: 'prefix-transform', name: 'Prefix transform', version: '1' },
        cancelActionId: 'cancel',
        view: {
          version: 1,
          title: 'Review transformed input',
          elements: [{ type: 'readonly_textarea', label: 'Agent input', value: 'SAFE: hello' }],
          actions: [
            { id: 'continue', label: 'Continue', style: 'primary' },
            { id: 'cancel', label: 'Cancel', style: 'secondary' },
          ],
        },
        projection: {
          title: 'Session',
          lifecycle: 'active',
          activity: 'attention',
          updatedAt: 2,
          stateVersion: 2,
        },
      },
    }).payload).toMatchObject({ type: 'extension.interaction.requested' })
  })

  it('uses entity-local message versions for streaming output', () => {
    const event = cvp3EventSchema.parse({
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
    expect(cvp3ProjectKeyGrantPlaintextSchema.parse({
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

function testAttachment() {
  return {
    id: 'attachment-1',
    name: 'report.pdf',
    mimeType: 'application/pdf',
    size: 12,
    sha256: 'A'.repeat(43),
    media: {
      url: 'mxc://example.org/report',
      key: 'B'.repeat(43),
      iv: 'C'.repeat(16),
      sha256: 'D'.repeat(43),
      size: 28,
    },
  }
}
