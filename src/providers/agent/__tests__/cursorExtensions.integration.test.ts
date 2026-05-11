import { describe, expect, it, vi } from 'vitest'
import { SemanticSessionRuntime } from '@/runtime/semanticSessionRuntime'
import { createCursorAcpExtensionHandler } from '../cursorExtensions'
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable'
import type { ChannelMessage, ChannelPort, DecisionRequest, DecisionResponse, SessionStatus } from '@/bridge/channelPort'
import type { AgentEvent } from '@/providers/types'
import type { AgentProvider, AgentQueryConfig, AgentQueryHandle } from '@/providers/provider'

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function createChannel(decisionValue?: string): ChannelPort & {
    sent: ChannelMessage[]
    decisions: DecisionRequest[]
    statuses: SessionStatus[]
} {
    const sent: ChannelMessage[] = []
    const decisions: DecisionRequest[] = []
    const statuses: SessionStatus[] = []
    return {
        sent,
        decisions,
        statuses,
        send: vi.fn(async (message) => {
            sent.push(message)
            return { messageId: sent.length }
        }),
        edit: vi.fn(async (_messageId, message) => {
            sent.push({ ...message, text: `EDIT:${message.text}` })
        }),
        requestDecision: vi.fn(async (request): Promise<DecisionResponse> => {
            decisions.push(request)
            return { value: decisionValue ?? request.options[0]?.value ?? '' }
        }),
        notifyStatus: vi.fn((status) => {
            statuses.push(status)
        }),
    }
}

function createCursorExtensionProvider(
    runExtension: (handler: ReturnType<typeof createCursorAcpExtensionHandler>) => Promise<void>,
): AgentProvider {
    return {
        name: 'agent',
        startQuery: vi.fn((_prompt: string, config: AgentQueryConfig): AgentQueryHandle => {
            const events = new PushableAsyncIterable<AgentEvent>()
            const handler = createCursorAcpExtensionHandler(events, config)

            void (async () => {
                await runExtension(handler)
                events.push({ kind: 'result', status: 'success' })
                events.end()
            })()

            return { events, interrupt: vi.fn() }
        }),
        isReady: vi.fn(() => true),
        getInitError: vi.fn(() => null),
        getAvailableModels: vi.fn(() => []),
        getAvailablePermissionModes: vi.fn(() => []),
    }
}

async function runRuntime(provider: AgentProvider, channel: ChannelPort): Promise<void> {
    const runtime = new SemanticSessionRuntime({
        sessionId: 'session-1',
        cwd: '/repo',
        provider,
        providerName: 'agent',
        channelPort: channel,
    })

    await runtime.dispatch({ kind: 'user_message', text: 'trigger cursor extension', source: 'channel' })
    await delay(10)
}

describe('Cursor ACP extensions through semantic runtime', () => {
    it('renders cursor/create_plan todos and requests plan approval', async () => {
        const channel = createChannel('accepted')
        const provider = createCursorExtensionProvider(async (handler) => {
            await handler.extMethod!('cursor/create_plan', {
                name: 'Cursor extension plan',
                overview: 'Render Cursor ACP extensions in Telegram',
                markdown: 'Use provider-local mapping.',
                todos: [
                    { content: 'Add generic ACP hooks', status: 'completed' },
                    { content: 'Render Cursor todos', status: 'in_progress' },
                ],
            })
        })

        await runRuntime(provider, channel)

        expect(channel.decisions).toEqual([
            expect.objectContaining({
                type: 'question',
                title: 'Cursor extension plan',
                details: expect.stringContaining('Render Cursor ACP extensions'),
            }),
        ])
        expect(channel.sent.map(message => message.text).join('\n')).toContain('Tasks')
        expect(channel.sent.map(message => message.text).join('\n')).toContain('Add generic ACP hooks')
        expect(channel.sent.map(message => message.text).join('\n')).toContain('Render Cursor todos')
    })

    it('requests cursor/ask_question choices through the channel decision UI', async () => {
        const channel = createChannel('q1:provider-local')
        let response: Record<string, unknown> | undefined
        const provider = createCursorExtensionProvider(async (handler) => {
            response = await handler.extMethod!('cursor/ask_question', {
                title: 'Where should Cursor-specific code live?',
                questions: [{
                    id: 'q1',
                    text: 'Choose the boundary',
                    options: [
                        { id: 'generic-runtime', label: 'Generic runtime' },
                        { id: 'provider-local', label: 'Cursor provider' },
                    ],
                }],
            })
        })

        await runRuntime(provider, channel)

        expect(channel.decisions).toEqual([
            expect.objectContaining({
                type: 'question',
                title: 'Where should Cursor-specific code live?',
                options: [
                    { label: 'Generic runtime', value: 'q1:generic-runtime' },
                    { label: 'Cursor provider', value: 'q1:provider-local' },
                ],
            }),
        ])
        expect(response).toEqual({
            outcome: {
                outcome: 'answered',
                answers: [{ questionId: 'q1', selectedOptionIds: ['provider-local'] }],
            },
        })
    })

    it('renders cursor/update_todos notifications as task list updates', async () => {
        const channel = createChannel()
        const provider = createCursorExtensionProvider(async (handler) => {
            await handler.extNotification!('cursor/update_todos', {
                todos: [
                    { title: 'Keep Cursor extensions provider-local', state: 'done' },
                    { title: 'Document the design', state: 'active' },
                ],
            })
        })

        await runRuntime(provider, channel)

        const text = channel.sent.map(message => message.text).join('\n')
        expect(text).toContain('Tasks')
        expect(text).toContain('Keep Cursor extensions provider-local')
        expect(text).toContain('Document the design')
    })

    it('renders cursor/task and cursor/generate_image notifications', async () => {
        const channel = createChannel()
        const provider = createCursorExtensionProvider(async (handler) => {
            await handler.extNotification!('cursor/task', {
                id: 'task-1',
                description: 'Review provider-local Cursor extension support',
                result: 'No cross-provider leakage found',
                subagentType: 'reviewer',
            })
            await handler.extNotification!('cursor/generate_image', {
                url: 'file:///tmp/cursor-plan.png',
                description: 'Generated plan diagram',
            })
        })

        await runRuntime(provider, channel)

        const text = channel.sent.map(message => message.text).join('\n')
        expect(text).toContain('Task')
        expect(text).toContain('Review provider-local Cursor extension support')
        expect(text).toContain('Generated image: file:///tmp/cursor-plan.png')
        expect(text).toContain('Generated plan diagram')
    })
})
