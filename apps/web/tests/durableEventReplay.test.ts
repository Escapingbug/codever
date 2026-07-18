import { describe, expect, it, vi } from 'vitest'
import { DurableEventReplayBuffer } from '../src/api/durableEventReplay'

describe('durable event replay batching', () => {
  it('publishes startup backlog in one UI batch, then publishes live values immediately', async () => {
    const replay = new DurableEventReplayBuffer<number>()
    const publish = vi.fn<(values: number[]) => void>()

    await replay.deliver(1, 2, publish)
    await replay.deliver(2, 1, publish)
    expect(publish).not.toHaveBeenCalled()

    await replay.deliver(3, 0, publish)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith([1, 2, 3])

    await replay.deliver(4, 0, publish)
    expect(publish).toHaveBeenLastCalledWith([4])
  })

  it('returns to batch mode after a disconnect', async () => {
    const replay = new DurableEventReplayBuffer<string>()
    const publish = vi.fn<(values: string[]) => void>()
    await replay.deliver('initial', 0, publish)
    replay.begin()

    await replay.deliver('missed-a', 1, publish)
    await replay.deliver('missed-b', 0, publish)

    expect(publish.mock.calls).toEqual([[['initial']], [['missed-a', 'missed-b']]])
  })

  it('publishes bounded batches even when a live producer keeps pending above zero', async () => {
    const replay = new DurableEventReplayBuffer<number>({ maxBatchSize: 4 })
    const publish = vi.fn<(values: number[]) => void>()

    for (let value = 1; value <= 10; value += 1) await replay.deliver(value, 10_000, publish)

    expect(publish.mock.calls).toEqual([[[1, 2, 3, 4]], [[5, 6, 7, 8]]])
    await replay.deliver(11, 0, publish)
    expect(publish).toHaveBeenLastCalledWith([9, 10, 11])
  })
})
