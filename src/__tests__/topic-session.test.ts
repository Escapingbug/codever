import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTopicSession, type TopicSessionConfig } from '@/bridge/topicSession'
import { QueryLoop } from '@/core/queryLoop'
import { DefaultEventBus } from '@/core/eventBus'
import type { AgentProvider, AgentQueryConfig, AgentQueryHandle } from '@/providers/provider'
import type { AgentEvent, AgentResultEvent, AgentSessionInitEvent } from '@/providers/types'
import type { ChannelPort, ChannelMessage, DecisionRequest, DecisionResponse, SessionStatus } from '@/bridge/channelPort'
import type { MiddlewarePipeline, OutputMessage } from '@/middleware/pipeline'
import { createMiddlewarePipeline } from '@/middleware/pipeline'
import { createFormattingMiddleware } from '@/middleware/formatting'

import { QueryLoopState } from '@/core/types'

function createMockProvider(events: AgentEvent[] = []): AgentProvider {
    return {
        name: 'mock-provider',
        startQuery: vi.fn().mockImplementation((_prompt: string, _config: AgentQueryConfig) => {
            const handle: AgentQueryHandle = {
                events: (async function* () {
                    for (const event of events) yield event
                })(),
                interrupt: vi.fn().mockResolvedValue(undefined),
            }
            return handle
        }),
        isReady: vi.fn().mockReturnValue(true),
        getInitError: vi.fn().mockReturnValue(null),
        getAvailableModels: vi.fn().mockReturnValue([]),
        getAvailablePermissionModes: vi.fn().mockReturnValue([]),
    }
}

function createMockChannelPort(): ChannelPort & {
    sentMessages: ChannelMessage[]
    statusNotifications: SessionStatus[]
    decisionRequests: DecisionRequest[]
    resolveDecision: (response: DecisionResponse) => void
} {
    const sentMessages: ChannelMessage[] = []
    const statusNotifications: SessionStatus[] = []
    const decisionRequests: DecisionRequest[] = []
    let decisionResolve: ((response: DecisionResponse) => void) | null = null

    return {
        sentMessages,
        statusNotifications,
        decisionRequests,
        resolveDecision(response: DecisionResponse) {
            if (decisionResolve) decisionResolve(response)
        },

        send: vi.fn().mockImplementation(async (msg: ChannelMessage) => {
            sentMessages.push(msg)
        }),
        requestDecision: vi.fn().mockImplementation((request: DecisionRequest) => {
            decisionRequests.push(request)
            return new Promise<DecisionResponse>((resolve) => {
                decisionResolve = resolve
            })
        }),
        notifyStatus: vi.fn().mockImplementation((status: SessionStatus) => {
            statusNotifications.push(status)
        }),
    }
}

function createPipeline(): MiddlewarePipeline {
    return createMiddlewarePipeline({
        formatting: createFormattingMiddleware(),
    })
}

function createTestTopicConfig(overrides?: Partial<TopicSessionConfig>): TopicSessionConfig {
    const provider = createMockProvider([{ kind: 'result', status: 'success' }])
    const bus = new DefaultEventBus()
    const queryLoop = new QueryLoop({
        cwd: '/tmp/test',
        provider,
        bus,
        providerName: 'mock-provider',
    })
    queryLoop.groupChatId = -100123
    queryLoop.messageThreadId = 42

    return {
        queryLoop,
        provider,
        channelPort: createMockChannelPort(),
        pipeline: createPipeline(),
        ...overrides,
    }
}

describe('TopicSession', () => {
    describe('createTopicSession', () => {
        it('returns a TopicSession with correct initial state', () => {
            const config = createTestTopicConfig()
            const topicSession = createTopicSession(config)

            expect(topicSession.state).toBe('idle')
            expect(topicSession.queryLoop).toBe(config.queryLoop)
        })

        it('receiveInput processes a user message through the session', async () => {
            const provider = createMockProvider([{ kind: 'text', text: 'Hello!' }, { kind: 'result', status: 'success' }])
            const config = createTestTopicConfig({ provider })
            const channelPort = config.channelPort as ReturnType<typeof createMockChannelPort>
            const topicSession = createTopicSession(config)

            topicSession.receiveInput({ text: 'Hi there', username: 'testuser' })

            // Wait for the query to complete
            await new Promise(r => setTimeout(r, 50))

            expect(provider.startQuery).toHaveBeenCalledWith('Hi there', expect.objectContaining({
                cwd: '/tmp/test',
            }))
        })

        it('query.started event sends session-started message to channel', async () => {
            const provider = createMockProvider([
                { kind: 'text', text: 'response' },
                { kind: 'result', status: 'success' },
            ])
            const config = createTestTopicConfig({ provider })
            const channelPort = config.channelPort as ReturnType<typeof createMockChannelPort>
            const topicSession = createTopicSession(config)

            topicSession.receiveInput({ text: 'hello' })
            await new Promise(r => setTimeout(r, 100))

            // Should have sent session-started message
            expect(channelPort.sentMessages.length).toBeGreaterThan(0)
        })

        it('query.completed event notifies channel of idle status', async () => {
            const provider = createMockProvider([{ kind: 'result', status: 'success' }])
            const config = createTestTopicConfig({ provider })
            const channelPort = config.channelPort as ReturnType<typeof createMockChannelPort>
            const topicSession = createTopicSession(config)

            topicSession.receiveInput({ text: 'hello' })
            await new Promise(r => setTimeout(r, 100))

            // Should have notified idle status
            const idleStatuses = channelPort.statusNotifications.filter(s => s.state === 'idle')
            expect(idleStatuses.length).toBeGreaterThan(0)
        })

        it('query.error event sends error message to channel', async () => {
            const provider: AgentProvider = {
                name: 'mock-provider',
                startQuery: vi.fn().mockImplementation(() => ({
                    events: (async function* () {
                        throw new Error('Query failed')
                    })(),
                    interrupt: vi.fn().mockResolvedValue(undefined),
                })),
                isReady: vi.fn().mockReturnValue(true),
                getInitError: vi.fn().mockReturnValue(null),
                getAvailableModels: vi.fn().mockReturnValue([]),
                getAvailablePermissionModes: vi.fn().mockReturnValue([]),
            }
            const config = createTestTopicConfig({ provider })
            const channelPort = config.channelPort as ReturnType<typeof createMockChannelPort>
            const topicSession = createTopicSession(config)

            topicSession.receiveInput({ text: 'hello' })
            await new Promise(r => setTimeout(r, 100))

            // Should have sent error message
            const errorMsgs = channelPort.sentMessages.filter(m => m.text.includes('Error'))
            expect(errorMsgs.length).toBeGreaterThan(0)
        })

        it('text events are sent through pipeline to channel', async () => {
            const provider = createMockProvider([
                { kind: 'text', text: 'Hello from agent!' },
                { kind: 'result', status: 'success' },
            ])
            const config = createTestTopicConfig({ provider })
            const channelPort = config.channelPort as ReturnType<typeof createMockChannelPort>
            const topicSession = createTopicSession(config)

            topicSession.receiveInput({ text: 'hello' })
            await new Promise(r => setTimeout(r, 200))

            // The agent text should be sent to the channel
            const textMsgs = channelPort.sentMessages.filter(m => m.format === 'markdown')
            expect(textMsgs.length).toBeGreaterThan(0)
        })

        it('session.state_changed to dead stops the topicSession', async () => {
            const config = createTestTopicConfig()
            const topicSession = createTopicSession(config)

            await topicSession.destroy()
            expect(topicSession.state).toBe('dead')
        })

        it('receiveInput is no-op after destroy', async () => {
            const provider = createMockProvider([{ kind: 'result', status: 'success' }])
            const config = createTestTopicConfig({ provider })
            const topicSession = createTopicSession(config)

            await topicSession.destroy()
            topicSession.receiveInput({ text: 'should be ignored' })

            expect(provider.startQuery).not.toHaveBeenCalled()
        })

        it('session_init events update conversationId', async () => {
            const provider = createMockProvider([
                { kind: 'session_init', sessionId: 'new-session-123' } as AgentSessionInitEvent,
                { kind: 'result', status: 'success' },
            ])
            const config = createTestTopicConfig({ provider })
            const topicSession = createTopicSession(config)

            topicSession.receiveInput({ text: 'hello' })
            await new Promise(r => setTimeout(r, 100))

            expect(config.queryLoop.conversationId).toBe('new-session-123')
        })
    })
})
