import type { ConversationEvent, SessionEventEnvelope } from '@codever/protocol'
import { describe, expect, it } from 'vitest'
import { mergeSessionEvents } from '../src/sessionEvents'

function envelope(seq: number, eventId = `event-${seq}`): SessionEventEnvelope {
  return {
    schemaVersion: 1,
    gatewayId: 'gateway-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    seq,
    eventId,
    timestamp: `2026-07-17T00:00:${String(seq).padStart(2, '0')}.000Z`,
    event: { kind: 'status', level: 'info', message: String(seq) } satisfies ConversationEvent,
  }
}

describe('session event merging', () => {
  it('orders events by their authoritative session sequence', () => {
    expect(mergeSessionEvents([envelope(3), envelope(1)], [envelope(2)]).map(event => event.seq))
      .toEqual([1, 2, 3])
  })

  it('deduplicates replayed events by sequence even if their event IDs differ', () => {
    const merged = mergeSessionEvents([envelope(1, 'cached-id')], [envelope(1, 'gateway-id')])

    expect(merged).toHaveLength(1)
    expect(merged[0]?.eventId).toBe('gateway-id')
  })
})
