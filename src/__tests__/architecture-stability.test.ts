import { describe, expect, it, vi } from 'vitest'
import { createTopicSession, createTopicSessionRecord } from '@/bridge/topicSession'
import { SessionManager } from '@/bridge/sessionManager'
import { ChannelProjector } from '@/runtime/channelProjector'
import type { ChannelMessage, ChannelPort, DecisionRequest, DecisionResponse, SessionStatus } from '@/bridge/channelPort'
import type { AgentEvent } from '@/providers/types'
import type { AgentProvider, AgentQueryConfig, AgentQueryHandle } from '@/providers/provider'

const configMocks = vi.hoisted(() => ({
    saveTopicState: vi.fn(),
}))

vi.mock('@/config', () => ({
    config: {
        saveTopicState: configMocks.saveTopicState,
    },
}))

function createProvider(events: AgentEvent[]): AgentProvider {
    return {
        name: 'mock-provider',
        startQuery: vi.fn((_prompt: string, _config: AgentQueryConfig): AgentQueryHandle => ({
            events: (async function* () {
                for (const event of events) yield event
            })(),
            interrupt: vi.fn(),
        })),
        isReady: vi.fn(() => true),
        getInitError: vi.fn(() => null),
        getAvailableModels: vi.fn(() => []),
        getAvailablePermissionModes: vi.fn(() => []),
    }
}

function createChannel(): ChannelPort & {
    sent: ChannelMessage[]
    statuses: SessionStatus[]
    decisions: DecisionRequest[]
} {
    const sent: ChannelMessage[] = []
    const statuses: SessionStatus[] = []
    const decisions: DecisionRequest[] = []
    return {
        sent,
        statuses,
        decisions,
        send: vi.fn(async (message) => {
            sent.push(message)
            return { messageId: sent.length }
        }),
        edit: vi.fn(async (_messageId, message) => {
            sent.push(message)
        }),
        requestDecision: vi.fn(async (request): Promise<DecisionResponse> => {
            decisions.push(request)
            return { value: request.options[0]?.value ?? '' }
        }),
        notifyStatus: vi.fn((status) => {
            statuses.push(status)
        }),
    }
}

describe('Architecture stability invariants', () => {
    it('SessionManager stores lightweight session records for lookup and cleanup', () => {
        const manager = new SessionManager()
        const record = createTopicSessionRecord({
            cwd: '/repo',
            providerName: 'mock-provider',
            groupChatId: -100,
            messageThreadId: 10,
            conversationId: 'provider-session',
        })

        manager.registerSession(record, -100, 10)

        expect(manager.getSession(record.id)).toBe(record)
        expect(manager.getSessionByGroup(-100, 10)).toBe(record)
        expect(manager.getSessionByConversationId('provider-session')).toBe(record)
        expect(manager.listActiveSessions()).toEqual([record])

        manager.removeSession(record.id)
        expect(manager.getSession(record.id)).toBeUndefined()
        expect(manager.getSessionByGroup(-100, 10)).toBeUndefined()
    })

    it('TopicSession uses the semantic runtime as the execution core', async () => {
        const provider = createProvider([
            { kind: 'text', text: 'hello from runtime' },
            { kind: 'result', status: 'success' },
        ])
        const channel = createChannel()
        const record = createTopicSessionRecord({
            cwd: '/repo',
            providerName: provider.name,
            groupChatId: -100,
            messageThreadId: 10,
        })
        const topicSession = createTopicSession({ sessionRecord: record, provider, channelPort: channel })

        await topicSession.dispatch({ kind: 'user_message', text: 'inspect', source: 'channel' })

        expect('processInput' in record).toBe(false)
        expect(provider.startQuery).toHaveBeenCalledWith('inspect', expect.objectContaining({
            cwd: '/repo',
            sessionId: undefined,
        }))
        expect(channel.sent.map(message => message.text)).toEqual(['hello from runtime'])
        expect(topicSession.state).toBe('idle')
    })

    it('provider session metadata is persisted from runtime callbacks', async () => {
        const provider = createProvider([
            { kind: 'session_init', sessionId: 'provider-session-1' },
            { kind: 'result', status: 'success' },
        ])
        const channel = createChannel()
        const record = createTopicSessionRecord({
            cwd: '/repo',
            providerName: provider.name,
            groupChatId: -100,
            messageThreadId: 10,
        })
        const topicSession = createTopicSession({ sessionRecord: record, provider, channelPort: channel })

        await topicSession.dispatch({ kind: 'user_message', text: 'hello', source: 'channel' })

        expect(record.conversationId).toBe('provider-session-1')
        expect(configMocks.saveTopicState).toHaveBeenCalledWith('-100:10', {
            conversationId: 'provider-session-1',
            providerName: 'mock-provider',
        })
    })

    it('ChannelProjector remains the projection boundary for semantic events', () => {
        const projector = new ChannelProjector()
        projector.project({
            kind: 'assistant_text_delta',
            meta: { id: 'e1', sessionId: 's1', turnId: 't1', seq: 1, timestamp: Date.now(), provider: 'mock', sourcePhase: 'live' },
            text: 'projected text',
            messageId: 'assistant-1',
        }, { verboseLevel: 1 })
        const messages = projector.flush()

        expect(messages.map(message => message.message.text)).toEqual(['projected text'])
    })
})
