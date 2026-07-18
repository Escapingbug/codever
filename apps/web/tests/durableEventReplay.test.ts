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
})
