import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileV3MatrixOutbox } from '@/gateway/matrix/fileV3MatrixOutbox'

describe('FileV3MatrixOutbox', () => {
  it('uses one WAL for events and state while coalescing only replaceable state', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'codever-v3-outbox-')), 'outbox.jsonl')
    const outbox = new FileV3MatrixOutbox(path)
    await outbox.initialize()
    const event = outbox.createEvent({
      roomId: '!project:example.org',
      transactionId: 'command-1',
      content: { body: 'ciphertext-1' },
      createdAt: 1,
    })
    const oldState = outbox.createState({
      roomId: '!project:example.org',
      eventType: 'io.codever.project.current.v3',
      stateKey: 'project-1',
      content: { eventId: '$old' },
      createdAt: 2,
    })
    const newState = outbox.createState({
      roomId: '!project:example.org',
      eventType: 'io.codever.project.current.v3',
      stateKey: 'project-1',
      content: { eventId: '$new' },
      createdAt: 3,
    })
    await outbox.stage(event)
    await outbox.stage(oldState)
    await outbox.stage(newState)

    expect(outbox.pending()).toEqual(expect.arrayContaining([
      expect.objectContaining({ deliveryId: event.deliveryId }),
      expect.objectContaining({ deliveryId: newState.deliveryId }),
    ]))
    expect(outbox.pending().map(value => value.deliveryId)).not.toContain(oldState.deliveryId)
  })

  it('restores an undelivered encrypted event across restart', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'codever-v3-outbox-')), 'outbox.jsonl')
    const first = new FileV3MatrixOutbox(path)
    await first.initialize()
    const event = first.createEvent({
      roomId: '!project:example.org',
      transactionId: 'command-1',
      content: { body: 'ciphertext-1' },
      createdAt: 1,
    })
    await first.stage(event)

    const recovered = new FileV3MatrixOutbox(path)
    await recovered.initialize()
    expect(recovered.pending()).toEqual([event])
  })

  it('keeps the first exact ciphertext for one Matrix transaction id', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'codever-v3-outbox-')), 'outbox.jsonl')
    const outbox = new FileV3MatrixOutbox(path)
    await outbox.initialize()
    const first = outbox.createEvent({
      roomId: '!project:example.org',
      transactionId: 'stable-transaction',
      content: { body: 'first-ciphertext' },
      createdAt: 1,
    })
    const retry = outbox.createEvent({
      roomId: '!project:example.org',
      transactionId: 'stable-transaction',
      content: { body: 'different-retry-ciphertext' },
      createdAt: 2,
    })
    expect(retry.deliveryId).toBe(first.deliveryId)
    await outbox.stage(first)
    await outbox.stage(retry)
    expect(outbox.delivery(first.deliveryId)).toEqual(first)
    expect(outbox.pending()).toEqual([first])
  })
})
