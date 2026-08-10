import { describe, expect, it } from 'vitest'
import { canonicalJson, commandSchema, eventSchema } from '../src/index.js'

describe('canonicalJson', () => {
  it('sorts nested object keys deterministically', () => {
    expect(canonicalJson({ z: 1, a: { y: true, b: 'text' }, list: [3, null] })).toBe(
      '{"a":{"b":"text","y":true},"list":[3,null],"z":1}',
    )
  })

  it('rejects ambiguous values', () => {
    expect(() => canonicalJson({ value: undefined })).toThrow('undefined')
    expect(() => canonicalJson(Number.NaN)).toThrow('non-finite')
  })
})

describe('protocol schemas', () => {
  it('accepts only bounded application-encrypted Matrix prompt attachments', () => {
    const attachment = {
      id: 'attachment-1',
      name: 'diagram.png',
      mimeType: 'image/png',
      size: 12,
      sha256: 'A'.repeat(43),
      media: {
        url: 'mxc://example.org/media-1',
        key: 'B'.repeat(43),
        iv: 'C'.repeat(16),
        sha256: 'D'.repeat(43),
        size: 28,
      },
    }
    const command = {
      kind: 'codever.command',
      version: 1,
      commandId: 'cmd-attachment',
      gatewayId: 'gateway-1',
      deviceId: 'device-1',
      sequenceEpoch: 'certificate-device-1',
      conversationId: 'conversation-1',
      revisionEpoch: 'runtime-epoch-1',
      sequence: 1,
      baseRevision: 0,
      operation: 'prompt',
      issuedAt: 1,
      expiresAt: 2,
      nonce: '0123456789abcdef-attachment',
      payload: {
        operation: 'prompt',
        sessionId: 'app-session-1',
        text: '',
        attachments: [attachment],
      },
    }

    expect(commandSchema.parse(command).payload).toMatchObject({
      operation: 'prompt',
      attachments: [attachment],
    })
    expect(commandSchema.safeParse({
      ...command,
      payload: {
        ...command.payload,
        attachments: [{
          ...attachment,
          media: { ...attachment.media, url: 'https://example.org/media-1' },
        }],
      },
    }).success).toBe(false)
  })

  it('requires commands to bind the pairing-certificate sequence epoch', () => {
    const result = commandSchema.safeParse({
      kind: 'codever.command',
      version: 1,
      commandId: 'cmd-1',
      gatewayId: 'gateway-1',
      deviceId: 'device-1',
      conversationId: 'conversation-1',
      revisionEpoch: 'runtime-epoch-1',
      sequence: 1,
      baseRevision: 0,
      operation: 'cancel',
      issuedAt: 1,
      expiresAt: 2,
      nonce: '0123456789abcdef',
      payload: { operation: 'cancel', sessionId: 'app-session-1' },
    })
    expect(result.success).toBe(false)
  })

  it('requires the outer signed operation to match the payload', () => {
    const result = commandSchema.safeParse({
      kind: 'codever.command',
      version: 1,
      commandId: 'cmd-1',
      gatewayId: 'gateway-1',
      deviceId: 'device-1',
      sequenceEpoch: 'certificate-device-1',
      conversationId: 'conversation-1',
      revisionEpoch: 'runtime-epoch-1',
      sequence: 1,
      operation: 'cancel',
      issuedAt: 1,
      expiresAt: 2,
      nonce: '0123456789abcdef',
      payload: {
        operation: 'prompt',
        sessionId: 'app-session-1',
        text: 'hello',
      },
    })
    expect(result.success).toBe(false)
  })

  it('accepts a versioned agent event', () => {
    expect(
      eventSchema.parse({
        kind: 'codever.event',
        version: 1,
        eventId: 'event-1',
        gatewayId: 'gateway-1',
        conversationId: 'conversation-1',
        sequence: 1,
        occurredAt: 10,
        payload: { type: 'agent.text.delta', streamId: 'stream-1', text: 'hello' },
      }),
    ).toMatchObject({ version: 1, sequence: 1 })
  })

  it('accepts strict app session creation', () => {
    const base = {
      kind: 'codever.command',
      version: 1,
      gatewayId: 'gateway-1',
      deviceId: 'device-1',
      sequenceEpoch: 'certificate-device-1',
      conversationId: 'conversation-1',
      revisionEpoch: 'runtime-epoch-1',
      baseRevision: 0,
      issuedAt: 1,
      expiresAt: 2,
    }
    expect(commandSchema.parse({
      ...base,
      commandId: 'create-1',
      sequence: 1,
      operation: 'session.create',
      nonce: '0123456789abcdef-create',
      payload: {
        operation: 'session.create',
        cwd: '/workspace/client',
        projectName: 'Client',
        model: 'gpt-5',
        reasoningEffort: 'high',
      },
    }).payload).toEqual({
      operation: 'session.create',
      cwd: '/workspace/client',
      projectName: 'Client',
      model: 'gpt-5',
      reasoningEffort: 'high',
    })

    const withExtension = {
      ...base,
      commandId: 'create-extension-1',
      sequence: 2,
      operation: 'session.create',
      nonce: '0123456789abcdef-create-extension',
      payload: {
        operation: 'session.create',
        extensions: [{
          id: 'has-privacy',
          config: { contextId: 'payroll-1', reviewRequired: true },
        }],
      },
    }
    expect(commandSchema.parse(withExtension).payload).toMatchObject({
      extensions: [{ id: 'has-privacy' }],
    })
    expect(commandSchema.safeParse({
      ...withExtension,
      payload: {
        ...withExtension.payload,
        extensions: [
          { id: 'has-privacy' },
          { id: 'has-privacy' },
        ],
      },
    }).success).toBe(false)
    expect(commandSchema.safeParse({
      ...withExtension,
      payload: {
        ...withExtension.payload,
        extensions: [{ id: 'has-privacy', endpoint: 'https://attacker.example' }],
      },
    }).success).toBe(false)
    expect(commandSchema.safeParse({
      ...withExtension,
      payload: {
        ...withExtension.payload,
        extensions: [{
          id: 'has-privacy',
          config: Object.fromEntries(
            Array.from({ length: 33 }, (_, index) => [`setting-${index}`, true]),
          ),
        }],
      },
    }).success).toBe(false)
  })

  it('accepts strict session lifecycle commands', () => {
    const base = {
      kind: 'codever.command',
      version: 1,
      gatewayId: 'gateway-1',
      deviceId: 'device-1',
      sequenceEpoch: 'certificate-device-1',
      conversationId: 'conversation-1',
      revisionEpoch: 'runtime-epoch-1',
      baseRevision: 0,
      issuedAt: 1,
      expiresAt: 2,
    }
    for (const [sequence, operation] of [
      [1, 'session.archive'],
      [2, 'session.restore'],
      [3, 'session.delete'],
    ] as const) {
      expect(commandSchema.parse({
        ...base,
        commandId: `${operation}-${sequence}`,
        sequence,
        operation,
        nonce: `0123456789abcdef-${operation}`,
        payload: {
          operation,
          sessionId: 'app-session-1',
        },
      }).payload).toEqual({ operation, sessionId: 'app-session-1' })
    }
  })

  it('accepts a bounded device invitation request without a session target', () => {
    expect(commandSchema.parse({
      kind: 'codever.command',
      version: 1,
      commandId: 'invite-1',
      gatewayId: 'gateway-1',
      deviceId: 'device-1',
      sequenceEpoch: 'certificate-device-1',
      conversationId: 'conversation-1',
      revisionEpoch: 'runtime-epoch-1',
      sequence: 1,
      baseRevision: 0,
      operation: 'device.invite',
      issuedAt: 1,
      expiresAt: 2,
      nonce: '0123456789abcdef-invite',
      payload: {
        operation: 'device.invite',
        lifetimeMs: 5 * 60_000,
      },
    }).payload).toEqual({
      operation: 'device.invite',
      lifetimeMs: 5 * 60_000,
    })
  })

  it('requires an explicit app session for every session-targeted command', () => {
    const base = {
      kind: 'codever.command',
      version: 1,
      gatewayId: 'gateway-1',
      deviceId: 'device-1',
      sequenceEpoch: 'certificate-device-1',
      conversationId: 'conversation-1',
      revisionEpoch: 'runtime-epoch-1',
      baseRevision: 0,
      issuedAt: 1,
      expiresAt: 2,
    }
    const payloads = [
      { operation: 'prompt', text: 'hello' },
      { operation: 'cancel' },
      { operation: 'decision', requestId: 'request-1', decision: 'deny' },
      { operation: 'session.settings', model: 'gpt-5' },
    ] as const

    for (const [index, payload] of payloads.entries()) {
      expect(commandSchema.safeParse({
        ...base,
        commandId: `targeted-${index}`,
        sequence: index + 1,
        operation: payload.operation,
        nonce: `0123456789abcdef-targeted-${index}`,
        payload,
      }).success).toBe(false)
    }
  })

  it('does not expose session selection as a Gateway command', () => {
    expect(commandSchema.safeParse({
      kind: 'codever.command',
      version: 1,
      commandId: 'select-1',
      gatewayId: 'gateway-1',
      deviceId: 'device-1',
      sequenceEpoch: 'certificate-device-1',
      conversationId: 'conversation-1',
      revisionEpoch: 'runtime-epoch-1',
      sequence: 1,
      baseRevision: 0,
      operation: 'session.select',
      issuedAt: 1,
      expiresAt: 2,
      nonce: '0123456789abcdef-select',
      payload: { operation: 'session.select', sessionId: 'app-session-1' },
    }).success).toBe(false)
  })
})
