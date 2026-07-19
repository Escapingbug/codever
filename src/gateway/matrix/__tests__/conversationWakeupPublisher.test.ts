import type { SessionEventEnvelope } from '@codever/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationWakeupPublisher } from '../conversationWakeupPublisher'

afterEach(() => vi.useRealTimers())

describe('ConversationWakeupPublisher', () => {
    it('coalesces a Provider delta storm into bounded durable wake-ups', async () => {
        vi.useFakeTimers()
        const published: SessionEventEnvelope[] = []
        const publish = vi.fn(async (event: SessionEventEnvelope) => { published.push(event) })
        const publisher = new ConversationWakeupPublisher({ intervalMs: 5_000, publish })

        for (let seq = 1; seq <= 100; seq += 1) publisher.accept(delta(seq))
        expect(publish).toHaveBeenCalledTimes(1)
        expect(published.map(event => event.seq)).toEqual([1])

        await vi.advanceTimersByTimeAsync(5_000)
        expect(publish).toHaveBeenCalledTimes(2)
        expect(published.map(event => event.seq)).toEqual([1, 100])
    })

    it('replaces a pending detail with an immediate final state wake-up', async () => {
        vi.useFakeTimers()
        const published: SessionEventEnvelope[] = []
        const publish = vi.fn(async (event: SessionEventEnvelope) => { published.push(event) })
        const publisher = new ConversationWakeupPublisher({ intervalMs: 5_000, publish })
        publisher.accept(delta(1))
        publisher.accept(delta(2))
        publisher.accept(envelope(3, { kind: 'session_state', state: 'idle' }))

        expect(published.map(event => event.seq)).toEqual([1, 3])
        await vi.advanceTimersByTimeAsync(5_000)
        expect(publish).toHaveBeenCalledTimes(2)
    })
})

function delta(seq: number): SessionEventEnvelope {
    return envelope(seq, { kind: 'assistant_text_delta', text: `delta-${seq}` })
}

function envelope(seq: number, event: SessionEventEnvelope['event']): SessionEventEnvelope {
    return {
        schemaVersion: 1, gatewayId: 'gateway-1', projectId: 'project-1', sessionId: 'session-1',
        seq, eventId: `event-${seq}`, timestamp: '2026-07-19T00:00:00.000Z', event,
    }
}
