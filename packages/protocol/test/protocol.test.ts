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
