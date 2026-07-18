import { describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, type ClientGatewayResponseFrame, type ConversationEvent, type SessionEventEnvelope } from '@codever/protocol'
import { deliverDurableResponse } from '../src/api/durableSyncClient'
import { IndexedDbSessionEventStore } from '../src/api/sessionEventStore'

describe('durable Client liveness', () => {
  it('releases a waiting command before slow IndexedDB persistence finishes', async () => {
    const persisted = deferred<void>()
    const received = deferred<ClientGatewayResponseFrame>()
    const response: ClientGatewayResponseFrame = {
      version: PROTOCOL_VERSION,
      type: 'gateway.client.response',
      requestId: 'request-1',
      status: 'completed',
      completedAt: new Date().toISOString(),
      payload: { commandId: 'command-1', status: 'completed', acceptedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
    }

    const delivery = deliverDurableResponse(received, response, () => persisted.promise)

    await expect(received.promise).resolves.toBe(response)
    let deliveryFinished = false
    void delivery.then(() => { deliveryFinished = true })
    await Promise.resolve()
    expect(deliveryFinished).toBe(false)
    persisted.resolve()
    await delivery
  })

  it('batches concurrent event commits and bounds the cached snapshot', async () => {
    let cached: SessionEventEnvelope[] = []
    const write = vi.fn(async (_key: string, value: unknown) => { cached = value as SessionEventEnvelope[] })
    const store = new IndexedDbSessionEventStore({
      read: async <T>() => cached as T,
      write,
      maxEventsPerSession: 20,
      batchDelayMs: 0,
    })

    await Promise.all(Array.from({ length: 64 }, (_, index) => store.merge(envelope(index + 1))))

    expect(write).toHaveBeenCalledTimes(1)
    expect(cached.map(value => value.seq)).toEqual(Array.from({ length: 20 }, (_, index) => index + 45))
  })
})

function envelope(seq: number): SessionEventEnvelope {
  return {
    schemaVersion: 1,
    gatewayId: 'gateway-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    seq,
    eventId: `event-${seq}`,
    timestamp: new Date(1_700_000_000_000 + seq).toISOString(),
    event: { kind: 'status', level: 'info', message: String(seq) } satisfies ConversationEvent,
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}
