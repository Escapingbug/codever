import { describe, expect, it, vi } from 'vitest'
import { makeTopicKey, SessionManager } from '@/bridge/sessionManager'
import type { TopicSession } from '@/bridge/channelPort'

function createTopicSession(id: string, conversationId?: string | null): TopicSession {
    return {
        receiveInput: vi.fn(),
        dispatch: vi.fn(async () => {}),
        destroy: vi.fn(async () => {}),
        state: 'idle',
        sessionRecord: {
            id,
            conversationId: conversationId ?? null,
            groupChatId: -100,
            messageThreadId: 10,
        } as any,
        channelPort: {} as any,
        getProgress: vi.fn(() => null),
    }
}

describe('SessionManager integration boundaries', () => {
    it('normalizes Telegram General topic into a stable main topic key', () => {
        expect(makeTopicKey(-100, undefined)).toBe('-100:main')
        expect(makeTopicKey(-100, 1)).toBe('-100:main')
        expect(makeTopicKey(-100, 10)).toBe('-100:10')
    })

    it('finds topic sessions by provider conversation id for daemon send_message routing', () => {
        const manager = new SessionManager()
        const first = createTopicSession('query-1', 'provider-session-1')
        const second = createTopicSession('query-2', 'provider-session-2')

        manager.registerTopicSession('-100:10', first)
        manager.registerTopicSession('-100:20', second)

        expect(manager.getTopicSessionByConversationId('provider-session-1')).toBe(first)
        expect(manager.getTopicSessionByConversationId('provider-session-2')).toBe(second)
        expect(manager.getTopicSessionByConversationId('missing')).toBeUndefined()
    })

    it('finds topic sessions by metadata id for daemon fallback routing', () => {
        const manager = new SessionManager()
        const session = createTopicSession('query-1', 'provider-session-1')

        manager.registerTopicSession('-100:10', session)

        expect(manager.getTopicSessionBySessionId('query-1')).toBe(session)
        expect(manager.getTopicSessionBySessionId('query-2')).toBeUndefined()
    })

    it('removes topic-session lookup entries when a runtime is archived or dies', () => {
        const manager = new SessionManager()
        const session = createTopicSession('query-1', 'provider-session-1')
        manager.registerTopicSession('-100:10', session)

        manager.removeTopicSession('-100:10')

        expect(manager.getTopicSession('-100:10')).toBeUndefined()
        expect(manager.getTopicSessionByConversationId('provider-session-1')).toBeUndefined()
        expect(manager.getTopicSessionBySessionId('query-1')).toBeUndefined()
    })

    it('keeps topic-session map ownership centralized for bot and daemon code paths', () => {
        const manager = new SessionManager()
        const session = createTopicSession('query-1', 'provider-session-1')
        const map = manager.getTopicSessionsMap()

        map.set('-100:10', session)

        expect(manager.getTopicSession('-100:10')).toBe(session)
        expect(manager.getTopicSessionByConversationId('provider-session-1')).toBe(session)
    })
})
