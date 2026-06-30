import { describe, expect, it, vi } from 'vitest'
import type { TopicSession } from '@/bridge/channelPort'
import { SessionManager } from '@/bridge/sessionManager'
import { findTopicSessionForApiSession, getTopicKeyForTopicSession, isScheduledTaskForTopicSession, resolveTopicSessionForApiSession } from '@/daemon/sessionRouting'

function createTopicSession(id: string, conversationId?: string | null, threadId: number | null = 10): TopicSession {
    return {
        receiveInput: vi.fn(),
        dispatch: vi.fn(async () => {}),
        destroy: vi.fn(async () => {}),
        state: 'idle',
        sessionRecord: {
            id,
            conversationId: conversationId ?? null,
            groupChatId: -100,
            messageThreadId: threadId,
        } as any,
        channelPort: {} as any,
        getProgress: vi.fn(() => null),
        getDeliveryStatus: vi.fn(() => ({ deliveries: [] })),
        retryDelivery: vi.fn(async () => ({ status: 'not_found' as const })),
    }
}

describe('daemon session routing', () => {
    it('resolves daemon API targets by topic key, provider conversation id, and core session id', () => {
        const manager = new SessionManager()
        const topicSession = createTopicSession('core-session-1', 'provider-session-1')

        manager.registerSession(topicSession.sessionRecord, -100, 10)
        manager.registerTopicSession('-100:10', topicSession)

        expect(findTopicSessionForApiSession(manager, '-100:10')).toBe(topicSession)
        expect(findTopicSessionForApiSession(manager, 'provider-session-1')).toBe(topicSession)
        expect(findTopicSessionForApiSession(manager, 'core-session-1')).toBe(topicSession)
        expect(findTopicSessionForApiSession(manager, 'missing-session')).toBeUndefined()
    })

    it('derives the real Telegram topic key from a provider session target', () => {
        const manager = new SessionManager()
        const topicSession = createTopicSession('core-session-1', 'provider-session-1')

        manager.registerSession(topicSession.sessionRecord, -100, 10)
        manager.registerTopicSession('-100:10', topicSession)

        const resolved = resolveTopicSessionForApiSession(manager, 'provider-session-1')

        expect(getTopicKeyForTopicSession(resolved)).toBe('-100:10')
    })

    it('normalizes Telegram General topic sessions to the main topic key', () => {
        const topicSession = createTopicSession('core-session-1', 'provider-session-1', 1)

        expect(getTopicKeyForTopicSession(topicSession)).toBe('-100:main')
    })

    it('matches scheduled tasks stored with topic key, provider conversation id, or core session id', () => {
        const topicSession = createTopicSession('core-session-1', 'provider-session-1')

        expect(isScheduledTaskForTopicSession({
            id: 'task-1',
            topicKey: '-100:10',
            triggerAt: Date.now(),
            message: 'topic task',
        }, topicSession)).toBe(true)

        expect(isScheduledTaskForTopicSession({
            id: 'task-2',
            topicKey: 'provider-session-1',
            triggerAt: Date.now(),
            message: 'legacy provider task',
        }, topicSession)).toBe(true)

        expect(isScheduledTaskForTopicSession({
            id: 'task-3',
            topicKey: 'core-session-1',
            triggerAt: Date.now(),
            message: 'core session task',
        }, topicSession)).toBe(true)

        expect(isScheduledTaskForTopicSession({
            id: 'task-4',
            topicKey: 'other-session',
            triggerAt: Date.now(),
            message: 'other task',
        }, topicSession)).toBe(false)
    })

    it('throws a visible error when an API target cannot be resolved', () => {
        const manager = new SessionManager()

        expect(() => resolveTopicSessionForApiSession(manager, 'missing-session'))
            .toThrow('No topic session found for missing-')
    })
})
