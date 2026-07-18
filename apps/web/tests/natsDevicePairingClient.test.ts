import type { DurablePairingRequestEnvelope, DurablePairingResponseEnvelope } from '@codever/protocol'
import type { NatsConnection, Subscription } from '@nats-io/nats-core'
import { describe, expect, it, vi } from 'vitest'
import { pairGatewayOverNats } from '../src/api/natsDevicePairingClient'
import type { DeviceSecureHandshake } from '../src/security/deviceSecureHandshake'

describe('NATS device pairing transport', () => {
  it('retries the exact same OPAQUE step after packet loss', async () => {
    const queue = new AsyncQueue<{ data: Uint8Array }>()
    const published: DurablePairingRequestEnvelope[] = []
    const connection = {
      subscribe: () => queue as unknown as Subscription,
      publish: (_subject: string, data: Uint8Array) => {
        const request = JSON.parse(new TextDecoder().decode(data)) as DurablePairingRequestEnvelope
        published.push(request)
        if (published.length !== 2) return
        const response: DurablePairingResponseEnvelope = {
          ...request,
          kind: 'codever.pairing.response',
          messageId: 'response-1',
          inReplyTo: request.messageId,
          opaquePayload: 'gateway-step',
        }
        queue.push({ data: new TextEncoder().encode(JSON.stringify(response)) })
      },
    } as unknown as NatsConnection
    let ready = false
    const handshake = {
      get ready() { return ready },
      start: vi.fn(async () => 'client-step'),
      handle: vi.fn(async (value: string) => { expect(value).toBe('gateway-step'); ready = true; return undefined }),
    } as unknown as DeviceSecureHandshake

    await pairGatewayOverNats({
      connection, gatewayId: 'gateway_1', credentialId: 'client_1', handshake, retryMs: 5, timeoutMs: 100,
    })

    expect(published).toHaveLength(2)
    expect(published[1]).toEqual(published[0])
    expect(handshake.handle).toHaveBeenCalledOnce()
  })
})

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = []
  private closed = false

  push(value: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.values.push(value)
  }

  unsubscribe(): void {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift()
        if (value) return Promise.resolve({ value, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise(resolve => this.waiters.push(resolve))
      },
    }
  }
}
