import { describe, expect, it, vi } from 'vitest'
import { QueryLoop } from '@/core/queryLoop'
import { DefaultEventBus } from '@/core/eventBus'
import { createTopicSession } from '@/bridge/topicSession'
import { SemanticSessionRuntime } from '@/runtime/semanticSessionRuntime'
import type { AgentEvent } from '@/providers/types'
import type { AgentProvider, AgentQueryConfig, AgentQueryHandle } from '@/providers/provider'
import type { ChannelMessage, ChannelPort, DecisionRequest, DecisionResponse, SessionStatus } from '@/bridge/channelPort'
import type { MiddlewarePipeline } from '@/middleware/pipeline'

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function createProvider(events: AgentEvent[], overrides: Partial<AgentProvider> = {}): AgentProvider {
    return {
        name: 'mock-acp',
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
        ...overrides,
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
            sent.push({ ...message, text: `EDIT:${message.text}` })
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

function createNoopPipeline(): MiddlewarePipeline {
    return {
        processEvent: vi.fn(),
        flush: vi.fn(async () => null),
        flushSync: vi.fn(() => null),
        splitMessage: vi.fn((text: string) => [text]),
        reset: vi.fn(),
        getFormatting: vi.fn(),
        getTimeout: vi.fn(() => undefined),
    } as unknown as MiddlewarePipeline
}

function createTopicHarness(events: AgentEvent[]) {
    const provider = createProvider(events)
    const channel = createChannel()
    const pipeline = createNoopPipeline()
    const queryLoop = new QueryLoop({
        cwd: '/repo',
        provider,
        bus: new DefaultEventBus(),
        providerName: provider.name,
    })
    queryLoop.groupChatId = -100
    queryLoop.messageThreadId = 10

    const topicSession = createTopicSession({
        queryLoop,
        provider,
        channelPort: channel,
        pipeline,
    })

    return { topicSession, provider, channel, pipeline, queryLoop }
}

describe('Semantic runtime integration chain', () => {
    it('routes TopicSession input through runtime without using the legacy pipeline path', async () => {
        const { topicSession, provider, channel, pipeline, queryLoop } = createTopicHarness([
            { kind: 'session_init', sessionId: 'provider-session' },
            { kind: 'text', text: 'integrated response' },
            { kind: 'result', status: 'success' },
        ])

        topicSession.receiveInput({ text: 'hello', username: 'alice' })
        await delay(30)

        expect(provider.startQuery).toHaveBeenCalledWith('hello', expect.objectContaining({
            cwd: '/repo',
        }))
        expect(pipeline.processEvent).not.toHaveBeenCalled()
        expect(queryLoop.conversationId).toBe('provider-session')
        expect(channel.sent.map(m => m.text)).toEqual(['integrated response'])
        expect(channel.statuses.map(s => s.state)).toEqual(['querying', 'idle'])
    })

    it('shows provider error results even when the agent emits no text', async () => {
        const { topicSession, channel } = createTopicHarness([
            { kind: 'result', status: 'error', summary: 'ProviderModelNotFoundError: missing <model>' },
        ])

        topicSession.receiveInput({ text: 'hello', username: 'alice' })
        await delay(30)

        expect(channel.sent).toHaveLength(1)
        expect(channel.sent[0]).toMatchObject({
            format: 'html',
        })
        expect(channel.sent[0].text).toContain('Agent error')
        expect(channel.sent[0].text).toContain('ProviderModelNotFoundError: missing &lt;model&gt;')
    })

    it('projects ACP plan updates into channel decision UI without Telegram/ACP e2e', async () => {
        const channel = createChannel()
        const provider = createProvider([
            {
                kind: 'raw',
                providerName: 'acp',
                rawMessage: {
                    sessionUpdate: 'plan',
                    id: 'plan-1',
                    title: 'Apply plan?',
                    content: 'Create runtime boundary',
                    options: [
                        { id: 'accept', label: 'Accept', value: 'accept', style: 'primary' },
                        { id: 'reject', label: 'Reject', value: 'reject', style: 'danger' },
                    ],
                },
            },
            { kind: 'result', status: 'success' },
        ])
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: channel,
        })

        await runtime.dispatch({ kind: 'user_message', text: 'plan please', source: 'channel' })

        expect(runtime.journal.list().some(e => e.kind === 'decision_request')).toBe(true)
        expect(channel.sent).toHaveLength(1)
        expect(channel.sent[0].text).toContain('Apply plan?')
        expect(channel.sent[0].replyMarkup).toEqual(expect.objectContaining({
            inline_keyboard: expect.any(Array),
        }))
    })

    it('recovers a crashed provider through mocked reinit before accepting another input', async () => {
        let ready = false
        const provider = createProvider([], {
            isReady: vi.fn(() => ready),
            wasReady: vi.fn(() => true),
            reinit: vi.fn(async () => {
                ready = true
            }),
        })
        const channel = createChannel()
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: channel,
        })

        await runtime.dispatch({ kind: 'user_message', text: 'hello', source: 'channel' })

        expect(provider.reinit).toHaveBeenCalled()
        expect(channel.sent.map(m => m.text)).toEqual([
            '⚠️ Agent process crashed, reconnecting...',
            '✅ Agent reconnected',
        ])
        expect(provider.startQuery).not.toHaveBeenCalled()
    })

    it('interrupts an active provider turn when cancel is dispatched through the semantic runtime', async () => {
        let release!: () => void
        const hold = new Promise<void>(resolve => {
            release = resolve
        })
        const interrupt = vi.fn(async () => {
            release()
        })
        const provider = createProvider([], {
            startQuery: vi.fn((): AgentQueryHandle => ({
                events: (async function* () {
                    yield { kind: 'text', text: 'working' } as AgentEvent
                    await hold
                    yield { kind: 'result', status: 'success' } as AgentEvent
                })(),
                interrupt,
            })),
        })
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: createChannel(),
        })

        const running = runtime.dispatch({ kind: 'user_message', text: 'long task', source: 'channel' })
        await delay(10)

        try {
            void runtime.dispatch({ kind: 'cancel', reason: 'user', source: 'channel' })
            await delay(20)
            expect(interrupt).toHaveBeenCalled()
        } finally {
            release()
            await running
        }
    })

    it('notifies the channel immediately when user input arrives during an active turn', async () => {
        let release!: () => void
        const hold = new Promise<void>(resolve => {
            release = resolve
        })
        const provider = createProvider([], {
            startQuery: vi.fn((prompt: string): AgentQueryHandle => ({
                events: (async function* () {
                    yield { kind: 'text', text: `response:${prompt}` } as AgentEvent
                    if (prompt === 'first') await hold
                    yield { kind: 'result', status: 'success' } as AgentEvent
                })(),
                interrupt: vi.fn(),
            })),
        })
        const channel = createChannel()
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: channel,
        })

        const first = runtime.dispatch({ kind: 'user_message', text: 'first', source: 'channel' })
        await delay(10)
        void runtime.dispatch({ kind: 'user_message', text: 'second', source: 'channel' })
        await delay(10)

        try {
            expect(channel.sent.some(m => m.text.includes('queued'))).toBe(true)
            expect(provider.startQuery).toHaveBeenCalledTimes(1)
        } finally {
            release()
            await first
        }
    })

    it('passes decision responses back through the runtime instead of emitting placeholder channel text', async () => {
        const provider = createProvider([
            {
                kind: 'raw',
                providerName: 'acp',
                rawMessage: {
                    sessionUpdate: 'plan',
                    id: 'plan-1',
                    title: 'Approve?',
                    options: [{ id: 'accept', label: 'Accept', value: 'accept' }],
                },
            },
            { kind: 'result', status: 'success' },
        ])
        const channel = createChannel()
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: channel,
        })

        await runtime.dispatch({ kind: 'user_message', text: 'make a plan', source: 'channel' })
        await runtime.dispatch({ kind: 'decision_response', decisionId: 'plan-1', value: 'accept', source: 'channel' })

        expect(channel.sent.map(m => m.text)).not.toContain('Decision received: accept')
        expect(runtime.journal.list()).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'command_result',
                command: 'decision_response',
                output: expect.objectContaining({ decisionId: 'plan-1', value: 'accept' }),
            }),
        ]))
    })

    it('preserves queued user inputs and runs them as separate provider turns in order', async () => {
        let release!: () => void
        const hold = new Promise<void>(resolve => {
            release = resolve
        })
        const provider = createProvider([], {
            startQuery: vi.fn((prompt: string): AgentQueryHandle => ({
                events: (async function* () {
                    if (prompt === 'first') await hold
                    yield { kind: 'text', text: `done:${prompt}` } as AgentEvent
                    yield { kind: 'result', status: 'success' } as AgentEvent
                })(),
                interrupt: vi.fn(),
            })),
        })
        const channel = createChannel()
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: channel,
        })

        const first = runtime.dispatch({ kind: 'user_message', text: 'first', source: 'channel' })
        const second = runtime.dispatch({ kind: 'user_message', text: 'second', source: 'channel' })
        await delay(10)
        release()
        await Promise.all([first, second])

        expect(provider.startQuery).toHaveBeenNthCalledWith(1, 'first', expect.any(Object))
        expect(provider.startQuery).toHaveBeenNthCalledWith(2, 'second', expect.any(Object))
        expect(channel.sent.map(m => m.text)).toEqual(expect.arrayContaining(['done:first', 'done:second']))
    })

    it('marks prompt tail updates that arrive after the provider result as late instead of dropping them silently', async () => {
        const provider = createProvider([
            { kind: 'result', status: 'success' },
            { kind: 'text', text: 'late tail text' },
        ])
        const channel = createChannel()
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: channel,
        })

        await runtime.dispatch({ kind: 'user_message', text: 'tail', source: 'channel' })

        expect(runtime.journal.list()).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'assistant_text_delta',
                text: 'late tail text',
                meta: expect.objectContaining({ sourcePhase: 'tailDrain' }),
            }),
        ]))
        expect(channel.sent.map(m => m.text)).toContain('late tail text')
    })

    it('keeps provider switch as a runtime command instead of mutating QueryLoop directly', async () => {
        const provider = createProvider([])
        const channel = createChannel()
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: channel,
        })

        await runtime.dispatch({ kind: 'command', name: 'provider', args: 'opencode', source: 'channel' })

        expect(runtime.journal.list()).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'command_result',
                command: 'provider',
                output: expect.objectContaining({ providerName: 'opencode' }),
            }),
        ]))
        expect(channel.sent.map(m => m.text)).not.toContain('Command handling is not implemented: provider')
    })

    it('uses resumed provider session id on the next turn and updates it from session_init', async () => {
        const provider = createProvider([
            { kind: 'session_init', sessionId: 'new-session-id' },
            { kind: 'result', status: 'success' },
        ])
        const channel = createChannel()
        const onProviderSessionId = vi.fn()
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            providerSessionId: 'resumed-session-id',
            channelPort: channel,
            onProviderSessionId,
        })

        await runtime.dispatch({ kind: 'user_message', text: 'resume turn', source: 'channel' })

        expect(provider.startQuery).toHaveBeenCalledWith('resume turn', expect.objectContaining({
            sessionId: 'resumed-session-id',
        }))
        expect(onProviderSessionId).toHaveBeenCalledWith('new-session-id')
    })

    it('bridges provider permission requests to channel decisions through runtime config', async () => {
        const provider = createProvider([], {
            startQuery: vi.fn((_prompt: string, config: AgentQueryConfig): AgentQueryHandle => ({
                events: (async function* () {
                    const result = await config.permissionHandler!.handleToolCall(
                        'Bash',
                        { command: 'rm -rf tmp' },
                        { signal: config.signal },
                    )
                    yield { kind: 'text', text: `permission:${result.behavior}` } as AgentEvent
                    yield { kind: 'result', status: 'success' } as AgentEvent
                })(),
                interrupt: vi.fn(),
            })),
        })
        const channel = createChannel()
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: channel,
        })

        await runtime.dispatch({ kind: 'user_message', text: 'needs permission', source: 'channel' })

        expect(channel.decisions).toEqual([
            expect.objectContaining({
                type: 'permission',
                title: expect.stringContaining('Bash'),
            }),
        ])
        expect(channel.sent.map(m => m.text)).toContain('permission:allow')
    })

    it('applies model, timeout, and permission mode as runtime config commands', async () => {
        const provider = createProvider([])
        const channel = createChannel()
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: channel,
        })

        await runtime.dispatch({ kind: 'command', name: 'model', args: 'sonnet', source: 'channel' })
        await runtime.dispatch({ kind: 'command', name: 'timeout', args: '240', source: 'channel' })
        await runtime.dispatch({ kind: 'command', name: 'permissionMode', args: 'acceptEdits', source: 'channel' })
        await runtime.dispatch({ kind: 'user_message', text: 'configured turn', source: 'channel' })

        expect(runtime.journal.list()).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'command_result', command: 'model', output: expect.objectContaining({ model: 'sonnet' }) }),
            expect.objectContaining({ kind: 'command_result', command: 'timeout', output: expect.objectContaining({ timeoutSeconds: 240 }) }),
            expect.objectContaining({ kind: 'command_result', command: 'permissionMode', output: expect.objectContaining({ permissionMode: 'acceptEdits' }) }),
        ]))
        expect(provider.startQuery).toHaveBeenCalledWith('configured turn', expect.objectContaining({
            model: 'sonnet',
            providerSettings: expect.objectContaining({ permissionMode: 'acceptEdits' }),
        }))
    })

    it('keeps independent topic sessions isolated with mocked providers and channels', async () => {
        const first = createTopicHarness([
            { kind: 'text', text: 'topic-a' },
            { kind: 'result', status: 'success' },
        ])
        const second = createTopicHarness([
            { kind: 'text', text: 'topic-b' },
            { kind: 'result', status: 'success' },
        ])

        first.topicSession.receiveInput({ text: 'hello a', username: 'alice' })
        second.topicSession.receiveInput({ text: 'hello b', username: 'bob' })
        await delay(30)

        expect(first.channel.sent.map(m => m.text)).toEqual(['topic-a'])
        expect(second.channel.sent.map(m => m.text)).toEqual(['topic-b'])
        expect(first.provider.startQuery).toHaveBeenCalledWith('hello a', expect.any(Object))
        expect(second.provider.startQuery).toHaveBeenCalledWith('hello b', expect.any(Object))
    })

    it('records delivery failures in the journal and exposes them to the channel layer', async () => {
        const provider = createProvider([
            { kind: 'text', text: 'will fail delivery' },
            { kind: 'result', status: 'success' },
        ])
        const channel = createChannel()
        channel.send = vi.fn(async () => {
            throw new Error('telegram unavailable')
        })
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: channel,
        })

        await runtime.dispatch({ kind: 'user_message', text: 'delivery failure', source: 'channel' })

        expect(runtime.journal.list()).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'command_result',
                command: 'delivery_failed',
                output: expect.objectContaining({ message: expect.stringContaining('telegram unavailable') }),
            }),
        ]))
    })

    it('drops replayed provider history while still delivering live updates', async () => {
        const provider = createProvider([
            {
                kind: 'raw',
                providerName: 'acp',
                rawMessage: { sessionUpdate: 'agent_message_chunk', replay: true, content: { type: 'text', text: 'old history' } },
            },
            { kind: 'text', text: 'new response' },
            { kind: 'result', status: 'success' },
        ])
        const channel = createChannel()
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: channel,
        })

        await runtime.dispatch({ kind: 'user_message', text: 'resume safely', source: 'channel' })

        expect(runtime.journal.list()).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'assistant_text_delta', text: 'old history' }),
        ]))
        expect(channel.sent.map(m => m.text)).toEqual(['new response'])
    })

    it('runs scheduler proactive messages through the same provider and channel path', async () => {
        const provider = createProvider([
            { kind: 'text', text: 'scheduled response' },
            { kind: 'result', status: 'success' },
        ])
        const channel = createChannel()
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: channel,
        })

        await runtime.dispatch({ kind: 'scheduled_message', text: 'check tests', context: 'timer', source: 'scheduler' })

        expect(provider.startQuery).toHaveBeenCalledWith('check tests', expect.any(Object))
        expect(channel.sent.map(m => m.text)).toEqual(['scheduled response'])
    })

    it('supports MCP send_message as an immediate channel notification with journal visibility', async () => {
        const provider = createProvider([])
        const channel = createChannel()
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: channel,
        })

        await runtime.dispatch({ kind: 'command', name: 'send_message', args: 'build finished', source: 'mcp' })

        expect(channel.sent.map(m => m.text)).toContain('build finished')
        expect(runtime.journal.list()).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'command_result', command: 'send_message' }),
        ]))
        expect(provider.startQuery).not.toHaveBeenCalled()
    })

    it('handles provider available command updates as semantic command results', async () => {
        const provider = createProvider([
            {
                kind: 'commands_update',
                commands: [{ name: 'compact', description: 'Compact context', inputHint: null }],
            },
            { kind: 'result', status: 'success' },
        ])
        const channel = createChannel()
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: channel,
        })

        await runtime.dispatch({ kind: 'user_message', text: 'list commands', source: 'channel' })

        expect(runtime.journal.list()).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'command_result',
                command: 'available_commands_update',
                output: expect.arrayContaining([expect.objectContaining({ name: 'compact' })]),
            }),
        ]))
    })

    it('projects provider mode and usage updates without a real ACP process', async () => {
        const provider = createProvider([
            { kind: 'raw', providerName: 'acp', rawMessage: { sessionUpdate: 'current_mode_update', mode: 'plan' } },
            { kind: 'raw', providerName: 'acp', rawMessage: { sessionUpdate: 'usage_update', tokens: 1234, costUsd: 0.01 } },
            { kind: 'result', status: 'success' },
        ])
        const channel = createChannel()
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: channel,
        })

        await runtime.dispatch({ kind: 'user_message', text: 'mode update', source: 'channel' })

        expect(runtime.journal.list()).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'mode_change', mode: 'plan' }),
            expect.objectContaining({ kind: 'command_result', command: 'usage_update' }),
        ]))
        expect(channel.sent.map(m => m.text).join('\n')).toContain('Mode:')
    })

    it('applies resume as a runtime command before the next provider turn', async () => {
        const provider = createProvider([{ kind: 'result', status: 'success' }])
        const channel = createChannel()
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: channel,
        })

        await runtime.dispatch({ kind: 'command', name: 'resume', args: 'session-xyz', source: 'channel' })
        await runtime.dispatch({ kind: 'user_message', text: 'resume now', source: 'channel' })

        expect(provider.startQuery).toHaveBeenCalledWith('resume now', expect.objectContaining({
            sessionId: 'session-xyz',
        }))
        expect(runtime.journal.list()).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'command_result', command: 'resume' }),
        ]))
    })

    it('applies cwd as a runtime command before the next provider turn', async () => {
        const provider = createProvider([{ kind: 'result', status: 'success' }])
        const channel = createChannel()
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: channel,
        })

        await runtime.dispatch({ kind: 'command', name: 'cwd', args: '/new/repo', source: 'channel' })
        await runtime.dispatch({ kind: 'user_message', text: 'use new cwd', source: 'channel' })

        expect(provider.startQuery).toHaveBeenCalledWith('use new cwd', expect.objectContaining({
            cwd: '/new/repo',
        }))
        expect(runtime.journal.list()).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'command_result', command: 'cwd' }),
        ]))
    })

    it('archives/destroys a runtime session and ignores later channel input', async () => {
        const provider = createProvider([{ kind: 'result', status: 'success' }])
        const channel = createChannel()
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: channel,
        })

        await runtime.dispatch({ kind: 'command', name: 'archive', source: 'channel' })
        await runtime.dispatch({ kind: 'user_message', text: 'should not run', source: 'channel' })

        expect(provider.startQuery).not.toHaveBeenCalled()
        expect(runtime.getState()).toBe('dead')
    })

    it('reports runtime progress from an active turn without consulting QueryLoop timeout middleware', async () => {
        let release!: () => void
        const hold = new Promise<void>(resolve => {
            release = resolve
        })
        const provider = createProvider([], {
            startQuery: vi.fn((): AgentQueryHandle => ({
                events: (async function* () {
                    yield { kind: 'tool_use', toolUseId: 'tool-1', toolName: 'Bash', input: { command: 'npm test' }, status: 'running' } as AgentEvent
                    await hold
                    yield { kind: 'result', status: 'success' } as AgentEvent
                })(),
                interrupt: vi.fn(),
            })),
        })
        const channel = createChannel()
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: channel,
        })

        const running = runtime.dispatch({ kind: 'user_message', text: 'long', source: 'channel' })
        await delay(10)
        void runtime.dispatch({ kind: 'command', name: 'progress', source: 'channel' })
        await delay(20)

        try {
            expect(channel.sent.map(m => m.text).join('\n')).toContain('npm test')
        } finally {
            release()
            await running
        }
    })

    it('replies to /progress while the current turn is still running', async () => {
        let release!: () => void
        const hold = new Promise<void>(resolve => {
            release = resolve
        })
        const provider = createProvider([], {
            startQuery: vi.fn((): AgentQueryHandle => ({
                events: (async function* () {
                    await hold
                    yield { kind: 'result', status: 'success' } as AgentEvent
                })(),
                interrupt: vi.fn(),
            })),
        })
        const channel = createChannel()
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: channel,
        })

        const running = runtime.dispatch({ kind: 'user_message', text: 'long', source: 'channel' })
        await delay(10)
        const progress = runtime.dispatch({ kind: 'command', name: 'progress', source: 'channel' })
        await delay(20)

        try {
            expect(channel.sent.map(m => m.text).join('\n')).toContain('Task in progress')
        } finally {
            release()
            await running
            await progress
        }
    })

    it('tracks rendered tables so /tables can return raw markdown after a mock channel turn', async () => {
        const provider = createProvider([
            { kind: 'text', text: '| A | B |\n|---|---|\n| 1 | 2 |\n' },
            { kind: 'result', status: 'success' },
        ])
        const channel = createChannel()
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: channel,
        })

        await runtime.dispatch({ kind: 'user_message', text: 'table please', source: 'channel' })
        await runtime.dispatch({ kind: 'command', name: 'tables', source: 'channel' })

        expect(runtime.journal.list()).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'command_result',
                command: 'tables',
                output: expect.objectContaining({ tables: expect.arrayContaining([expect.stringContaining('| A | B |')]) }),
            }),
        ]))
    })

    it('falls back visibly when editing a tool bubble fails', async () => {
        const provider = createProvider([
            { kind: 'tool_use', toolUseId: 'tool-1', toolName: 'Bash', input: { command: 'npm test' }, status: 'running' },
            { kind: 'tool_result', toolUseId: 'tool-1', toolName: 'Bash', output: 'done', isError: false },
            { kind: 'result', status: 'success' },
        ])
        const channel = createChannel()
        channel.edit = vi.fn(async () => {
            throw new Error('edit unavailable')
        })
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: channel,
        })

        await runtime.dispatch({ kind: 'user_message', text: 'tool', source: 'channel' })

        expect(channel.sent.length).toBeGreaterThanOrEqual(2)
        expect(runtime.journal.list()).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'command_result', command: 'delivery_edit_failed' }),
        ]))
    })

    it('handles /new as a runtime reset before the next provider turn', async () => {
        const provider = createProvider([{ kind: 'result', status: 'success' }])
        const channel = createChannel()
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: channel,
            providerSessionId: 'old-provider-session',
        })

        await runtime.dispatch({ kind: 'command', name: 'new', source: 'channel' })
        await runtime.dispatch({ kind: 'user_message', text: 'fresh turn', source: 'channel' })

        expect(provider.startQuery).toHaveBeenCalledWith('fresh turn', expect.objectContaining({
            sessionId: undefined,
        }))
        expect(channel.sent.map(m => m.text).join('\n')).not.toContain('Command handling is not implemented')
        expect(runtime.journal.list()).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'command_result', command: 'new' }),
        ]))
    })

    it('handles timeout_continue as a runtime command without using timeout middleware bus events', async () => {
        const provider = createProvider([])
        const channel = createChannel()
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: channel,
        })

        await runtime.dispatch({ kind: 'command', name: 'timeout_continue', source: 'channel' })

        expect(channel.sent.map(m => m.text).join('\n')).not.toContain('Command handling is not implemented')
        expect(runtime.journal.list()).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'command_result', command: 'timeout_continue' }),
        ]))
        expect(provider.startQuery).not.toHaveBeenCalled()
    })

    it('applies verbose level as runtime configuration for subsequent provider turns', async () => {
        const provider = createProvider([{ kind: 'result', status: 'success' }])
        const channel = createChannel()
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'mock-acp',
            channelPort: channel,
        })

        await runtime.dispatch({ kind: 'command', name: 'verbose', args: '2', source: 'channel' })
        await runtime.dispatch({ kind: 'user_message', text: 'verbose turn', source: 'channel' })

        expect(provider.startQuery).toHaveBeenCalledWith('verbose turn', expect.objectContaining({
            providerSettings: expect.objectContaining({ verboseLevel: 2 }),
        }))
        expect(runtime.journal.list()).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'command_result', command: 'verbose' }),
        ]))
    })
})
