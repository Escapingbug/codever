import { describe, expect, it } from 'vitest'
import { EventRouter } from '@/providers/opencode/EventRouter'
import { SSEEventListener } from '@/providers/opencode/SSEEventListener'

describe('OpenCode assistant message boundaries', () => {
    it('preserves messageID on streamed text deltas', () => {
        const listener = new SSEEventListener(
            () => ({}) as never,
            new EventRouter(),
            '/repo',
        )

        const events = (listener as any).adaptEvent({
            type: 'message.part.delta',
            properties: {
                sessionID: 'session-1',
                messageID: 'message-1',
                partID: 'part-1',
                field: 'text',
                delta: 'hello',
            },
        }, 'session-1')

        expect(events).toEqual([
            { kind: 'text', text: 'hello', messageId: 'message-1' },
        ])
    })
})
