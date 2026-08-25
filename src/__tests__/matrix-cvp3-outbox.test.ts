import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileMatrixCvp3Outbox } from '@/gateway/matrix/fileMatrixCvp3Outbox'

describe('FileMatrixCvp3Outbox', () => {
  it('uses one WAL for events and state while coalescing only replaceable state', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'codever-v3-outbox-')), 'outbox.jsonl')
    const outbox = new FileMatrixCvp3Outbox(path)
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
    const first = new FileMatrixCvp3Outbox(path)
    await first.initialize()
    const event = first.createEvent({
      roomId: '!project:example.org',
      transactionId: 'command-1',
      content: { body: 'ciphertext-1' },
      createdAt: 1,
    })
    await first.stage(event)

    const recovered = new FileMatrixCvp3Outbox(path)
    await recovered.initialize()
    expect(recovered.pending()).toEqual([event])
  })

  it('keeps the first exact ciphertext for one Matrix transaction id', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'codever-v3-outbox-')), 'outbox.jsonl')
    const outbox = new FileMatrixCvp3Outbox(path)
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

  it('durably supersedes a poison delivery so it cannot block later events after restart', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'codever-v3-outbox-')), 'outbox.jsonl')
    const first = new FileMatrixCvp3Outbox(path)
    await first.initialize()
    const poison = first.createEvent({
      roomId: '!project:example.org',
      transactionId: 'poison-event',
      content: { body: 'oversized ciphertext' },
      createdAt: 1,
    })
    await first.stage(poison)
    await first.markSuperseded(poison.deliveryId, 'content_too_large', 2)
    expect(first.pending()).toEqual([])

    const recovered = new FileMatrixCvp3Outbox(path)
    await recovered.initialize()
    expect(recovered.pending()).toEqual([])
    expect(await readFile(path, 'utf8')).toContain('"reason":"content_too_large"')
  })

  it('keeps only the newest pending multipart snapshot and prioritizes actionable control', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'codever-v3-outbox-')), 'outbox.jsonl')
    const outbox = new FileMatrixCvp3Outbox(path)
    await outbox.initialize()
    const event = (
      transactionId: string,
      version: number,
      part: number,
      priority: 'urgent' | 'control' | 'bulk' = 'bulk',
    ) => outbox.createEvent({
      roomId: '!project:example.org',
      transactionId,
      content: { body: `${version}:${part}` },
      createdAt: version * 10 + part,
      priority,
      ...(priority === 'bulk'
        ? { supersession: { key: 'assistant:session-1:tool-group-1', version } }
        : {}),
    })
    const old = [event('old-0', 1, 0), event('old-1', 1, 1)]
    const latest = [event('latest-0', 2, 0), event('latest-1', 2, 1)]
    const control = event('turn-started', 3, 0, 'control')
    const urgent = event('turn-completed', 4, 0, 'urgent')
    for (const delivery of [...old, ...latest, control, urgent]) await outbox.stage(delivery)
    const lateObsolete = event('late-obsolete', 1, 2)
    expect(await outbox.stage(lateObsolete)).toContain(lateObsolete.deliveryId)

    expect(outbox.pending().map(delivery => delivery.deliveryId)).toEqual([
      urgent.deliveryId,
      control.deliveryId,
      latest[0]!.deliveryId,
      latest[1]!.deliveryId,
    ])
    expect(await readFile(path, 'utf8')).toContain('newer_logical_version')

    const recovered = new FileMatrixCvp3Outbox(path)
    await recovered.initialize()
    expect(recovered.pending().map(delivery => delivery.deliveryId)).toEqual([
      urgent.deliveryId,
      control.deliveryId,
      latest[0]!.deliveryId,
      latest[1]!.deliveryId,
    ])
  })

  it('classifies and converges legacy pending versions in one durable migration', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'codever-v3-outbox-')), 'outbox.jsonl')
    const outbox = new FileMatrixCvp3Outbox(path)
    await outbox.initialize()
    const legacy = [1, 2, 3, 4].map(createdAt => outbox.createEvent({
      roomId: '!project:example.org',
      transactionId: `legacy-${createdAt}`,
      content: { body: `legacy-${createdAt}` },
      createdAt,
    }))
    for (const delivery of legacy) await outbox.stage(delivery)

    const superseded = await outbox.classifyMany(legacy.map((delivery, index) => ({
      deliveryId: delivery.deliveryId,
      metadata: {
        priority: 'bulk' as const,
        supersession: {
          key: 'assistant:session-1:tool-group-1',
          version: index < 2 ? 1 : 2,
        },
      },
    })), 10)
    expect(superseded).toHaveLength(2)
    expect(outbox.pending().map(delivery => delivery.deliveryId)).toEqual([
      legacy[2]!.deliveryId,
      legacy[3]!.deliveryId,
    ])

    const recovered = new FileMatrixCvp3Outbox(path)
    await recovered.initialize()
    expect(recovered.pending()).toMatchObject([
      { deliveryId: legacy[2]!.deliveryId, priority: 'bulk', supersession: { version: 2 } },
      { deliveryId: legacy[3]!.deliveryId, priority: 'bulk', supersession: { version: 2 } },
    ])
  })
})
