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
  it('requires the outer signed operation to match the payload', () => {
    const result = commandSchema.safeParse({
      kind: 'codever.command',
      version: 1,
      commandId: 'cmd-1',
      gatewayId: 'gateway-1',
      deviceId: 'device-1',
      conversationId: 'conversation-1',
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
})
