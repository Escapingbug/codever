import { describe, expect, it, vi } from 'vitest'
import { SessionActor } from '@/runtime/sessionActor'

describe('SessionActor', () => {
    it('serializes inputs through one mailbox', async () => {
        const handled: string[] = []
        const actor = new SessionActor({
            onUserMessage: async (input) => {
                await new Promise(resolve => setTimeout(resolve, input.text === 'first' ? 20 : 0))
                handled.push(input.text)
            },
        })

        const first = actor.dispatch({ kind: 'user_message', text: 'first', source: 'channel' })
        const second = actor.dispatch({ kind: 'user_message', text: 'second', source: 'channel' })
        await Promise.all([first, second])

        expect(handled).toEqual(['first', 'second'])
    })

    it('journals semantic events idempotently', () => {
        const onEvent = vi.fn()
        const actor = new SessionActor({
            onUserMessage: vi.fn(),
            onEvent,
        })
        const event = {
            kind: 'turn_started' as const,
            meta: {
                id: 'turn-1:started',
                sessionId: 's1',
                turnId: 'turn-1',
                provider: 'test',
                seq: 0,
                timestamp: 1,
                sourcePhase: 'synthetic' as const,
            },
        }

        expect(actor.record(event)).toBe(true)
        expect(actor.record(event)).toBe(false)

        expect(actor.journal.list()).toHaveLength(1)
        expect(onEvent).toHaveBeenCalledTimes(1)
    })

    it('runs finalization before returning to idle', async () => {
        const finalize = vi.fn(async () => {
            await new Promise(resolve => setTimeout(resolve, 1))
        })
        const actor = new SessionActor({
            onUserMessage: vi.fn(),
            onFinalize: finalize,
        })

        await actor.finalize()

        expect(finalize).toHaveBeenCalledTimes(1)
        expect(actor.state).toBe('idle')
    })
})
