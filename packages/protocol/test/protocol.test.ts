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
      payload: { operation: 'cancel' },
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
      payload: { operation: 'prompt', text: 'hello' },
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

  it('accepts strict app session create and select commands', () => {
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
      payload: { operation: 'session.create' },
    }).payload).toEqual({ operation: 'session.create' })
    expect(commandSchema.parse({
      ...base,
      commandId: 'select-1',
      sequence: 2,
      operation: 'session.select',
      nonce: '0123456789abcdef-select',
      payload: { operation: 'session.select', sessionId: 'app-session-1' },
    }).payload).toEqual({
      operation: 'session.select',
      sessionId: 'app-session-1',
    })
    expect(commandSchema.safeParse({
      ...base,
      commandId: 'select-invalid',
      sequence: 3,
      operation: 'session.select',
      nonce: '0123456789abcdef-invalid',
      payload: { operation: 'session.select' },
    }).success).toBe(false)
  })
})
