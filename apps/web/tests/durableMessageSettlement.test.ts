import type { JsMsg } from '@nats-io/jetstream'
import { describe, expect, it, vi } from 'vitest'
import {
  processDurableMessage,
  RetryableDurableMessageError,
} from '../src/api/durableSyncClient'

describe('durable message settlement', () => {
  it('redelivers after a transient cache failure and acknowledges the successful retry', async () => {
    const first = message(true)
    const second = message(true)
    const visible: string[] = []
    let deliveries = 0
    const handler = async () => {
      deliveries += 1
      if (deliveries === 1) throw new RetryableDurableMessageError('IndexedDB transaction was interrupted')
      if (!visible.includes('event-7')) visible.push('event-7')
    }

    await processDurableMessage(first.value, handler, vi.fn())
    await processDurableMessage(second.value, handler, vi.fn())

    expect(first.nak).toHaveBeenCalledWith(1_000)
    expect(first.term).not.toHaveBeenCalled()
    expect(second.ackAck).toHaveBeenCalledOnce()
    expect(second.nak).not.toHaveBeenCalled()
    expect(visible).toEqual(['event-7'])
  })

  it('requests redelivery when the acknowledgement itself is not confirmed', async () => {
    const delivery = message(false)

    await processDurableMessage(delivery.value, async () => undefined, vi.fn())

    expect(delivery.nak).toHaveBeenCalledWith(1_000)
    expect(delivery.term).not.toHaveBeenCalled()
  })

  it('terminates malformed durable data instead of retrying it forever', async () => {
    const delivery = message(true)

    await processDurableMessage(delivery.value, async () => { throw new Error('invalid envelope') }, vi.fn())

    expect(delivery.term).toHaveBeenCalledWith('invalid envelope')
    expect(delivery.nak).not.toHaveBeenCalled()
  })
})

function message(acknowledged: boolean) {
  const ackAck = vi.fn(async () => acknowledged)
  const nak = vi.fn()
  const term = vi.fn()
  return {
    value: { ackAck, nak, term } as unknown as JsMsg,
    ackAck,
    nak,
    term,
  }
}
