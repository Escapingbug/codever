import { describe, expect, it, vi } from 'vitest'
import { SemanticSessionRuntime } from '@/runtime/semanticSessionRuntime'
import { DeliveryOutbox } from '@/runtime/deliveryOutbox'
import type { AgentProvider, AgentQueryConfig, AgentQueryHandle, AgentQueryInput } from '@/providers/provider'
import type { AgentEvent } from '@/providers/types'
import type { ChannelMessage, ChannelPort, SessionStatus } from '@/bridge/channelPort'

interface DeliveryOperation {
    kind: 'send' | 'edit'
    message: ChannelMessage
    messageId?: string | number
}

function createProvider(events: AgentEvent[]): AgentProvider {
    return {
        name: 'test-acp',
        startQuery: vi.fn((_prompt: AgentQueryInput, _config: AgentQueryConfig): AgentQueryHandle => ({
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

function createChannel(sent: ChannelMessage[], statuses: SessionStatus[], operations: DeliveryOperation[] = []): ChannelPort {
    return {
        send: vi.fn(async (message) => {
            sent.push(message)
            operations.push({ kind: 'send', message, messageId: sent.length })
            return { messageId: sent.length }
        }),
        edit: vi.fn(async (messageId, message) => {
            sent.push({ ...message, text: `EDIT:${message.text}` })
            operations.push({ kind: 'edit', message, messageId })
        }),
        requestDecision: vi.fn(async () => ({ value: 'allow' })),
        notifyStatus: vi.fn((status) => {
            statuses.push(status)
        }),
    }
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

describe('SemanticSessionRuntime', () => {
    it('interrupts an active turn before waiting for mailbox during destroy', async () => {
        let release!: () => void
        const hold = new Promise<void>(resolve => {
            release = resolve
        })
        const interrupt = vi.fn(async () => {})
        const provider: AgentProvider = {
            name: 'test-acp',
            startQuery: vi.fn((_prompt: AgentQueryInput, _config: AgentQueryConfig): AgentQueryHandle => ({
                events: (async function* () {
                    yield { kind: 'session_init', sessionId: 'provider-session-1' } as AgentEvent
                    await hold
                    yield { kind: 'result', status: 'success' } as AgentEvent
                })(),
                interrupt,
            })),
            isReady: vi.fn(() => true),
            getInitError: vi.fn(() => null),
            getAvailableModels: vi.fn(() => []),
            getAvailablePermissionModes: vi.fn(() => []),
        }
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'test-acp',
            channelPort: createChannel([], []),
            destroyTimeoutMs: 20,
        })

        const running = runtime.dispatch({ kind: 'user_message', text: 'long task', source: 'channel' })
        await delay(10)

        const started = Date.now()
        await runtime.destroy()

        expect(Date.now() - started).toBeLessThan(200)
        expect(interrupt).toHaveBeenCalled()
        expect(runtime.getState()).toBe('dead')

        release()
        await running
    })

    it('runs a user message through provider semantics, journal, projector, and outbox', async () => {
        const sent: ChannelMessage[] = []
        const statuses: SessionStatus[] = []
        const provider = createProvider([
            { kind: 'session_init', sessionId: 'provider-session-1' },
            { kind: 'text', text: 'Hello ' },
            { kind: 'text', text: 'world' },
            { kind: 'result', status: 'success' },
        ])
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'test-acp',
            channelPort: createChannel(sent, statuses),
            providerSettings: { verboseLevel: 2 },
        })

        await runtime.dispatch({ kind: 'user_message', text: 'hi', source: 'channel' })

        expect(provider.startQuery).toHaveBeenCalledWith('hi', expect.objectContaining({ cwd: '/repo' }))
        expect(runtime.journal.list().map(e => e.kind)).toEqual([
            'turn_started',
            'provider_raw',
            'assistant_text_delta',
            'assistant_text_delta',
            'turn_finished',
        ])
        expect(sent.map(m => m.text)).toEqual(['Hello world'])
        expect(statuses.map(s => s.state)).toEqual(['querying', 'idle'])
    })

    it('does not pass a stale model when the active provider has no model catalog', async () => {
        const sent: ChannelMessage[] = []
        const statuses: SessionStatus[] = []
        const provider = createProvider([
            { kind: 'result', status: 'success' },
        ])
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'codex',
            channelPort: createChannel(sent, statuses),
            model: 'lmstudio/hy3-preview-ioa',
        })

        await runtime.dispatch({ kind: 'user_message', text: 'hi', source: 'channel' })

        expect(provider.startQuery).toHaveBeenCalledWith('hi', expect.not.objectContaining({ model: 'lmstudio/hy3-preview-ioa' }))
        expect(statuses.find(status => status.state === 'querying')).not.toHaveProperty('model')
    })

    it('notifies visibly when an assistant reply cannot be delivered', async () => {
        const sent: ChannelMessage[] = []
        const statuses: SessionStatus[] = []
        const channel = createChannel(sent, statuses)
        let attempts = 0
        channel.send = vi.fn(async (message) => {
            attempts += 1
            if (attempts === 1) {
                throw new Error('telegram rejected markdown entities')
            }
            sent.push(message)
            return { messageId: attempts }
        })
        const provider = createProvider([
            { kind: 'text', text: 'final answer' },
            { kind: 'result', status: 'success' },
        ])
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'test-acp',
            channelPort: channel,
        })

        await runtime.dispatch({ kind: 'user_message', text: 'hi', source: 'channel' })

        const rendered = sent.map(message => message.text).join('\n')
        expect(rendered).toContain('Delivery warning')
        expect(rendered).toContain('telegram rejected markdown entities')
        expect(rendered).toContain('/delivery delivery-1')
        expect(runtime.getDeliveryStatus('delivery-1').deliveries[0].message.text).toBe('final answer')

        await runtime.dispatch({ kind: 'command', name: 'progress', source: 'channel' })
        expect(sent.at(-1)?.text).toContain('Last delivery failure')
    })

    it('can retrieve and retry a failed assistant delivery', async () => {
        const sent: ChannelMessage[] = []
        const statuses: SessionStatus[] = []
        const channel = createChannel(sent, statuses)
        let attempts = 0
        channel.send = vi.fn(async (message) => {
            attempts += 1
            if (attempts === 1) {
                throw new Error('telegram network failed')
            }
            sent.push(message)
            return { messageId: attempts }
        })
        const provider = createProvider([
            { kind: 'text', text: 'recoverable final answer' },
            { kind: 'result', status: 'success' },
        ])
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'test-acp',
            channelPort: channel,
        })

        await runtime.dispatch({ kind: 'user_message', text: 'hi', source: 'channel' })

        expect(runtime.getDeliveryStatus('delivery-1').deliveries[0]).toMatchObject({
            status: 'failed',
            message: { text: 'recoverable final answer' },
        })

        await runtime.dispatch({ kind: 'command', name: 'delivery', args: 'delivery-1', source: 'channel' })
        expect(sent.at(-2)?.text).toContain('Delivery details')
        expect(sent.at(-1)?.text).toBe('recoverable final answer')

        const retryResult = await runtime.dispatch({ kind: 'command', name: 'retry_delivery', args: 'delivery-1', source: 'channel' })
        expect(retryResult).toMatchObject({ status: 'sent', retryOf: 'delivery-1' })
        expect(runtime.getDeliveryStatus('delivery-1').deliveries[0].resolvedBy).toBeDefined()

        await runtime.dispatch({ kind: 'command', name: 'progress', source: 'channel' })
        expect(sent.at(-1)?.text).not.toContain('Last delivery failure')
    })

    it('flushes assistant text after a quiet period before the turn finishes', async () => {
        vi.useFakeTimers()
        try {
            const sent: ChannelMessage[] = []
            const statuses: SessionStatus[] = []
            let release!: () => void
            const hold = new Promise<void>(resolve => {
                release = resolve
            })
            const provider: AgentProvider = {
                name: 'test-acp',
                startQuery: vi.fn((_prompt: AgentQueryInput, _config: AgentQueryConfig): AgentQueryHandle => ({
                    events: (async function* () {
                        yield { kind: 'text', text: 'partial answer' } as AgentEvent
                        await hold
                        yield { kind: 'result', status: 'success' } as AgentEvent
                    })(),
                    interrupt: vi.fn(),
                })),
                isReady: vi.fn(() => true),
                getInitError: vi.fn(() => null),
                getAvailableModels: vi.fn(() => []),
                getAvailablePermissionModes: vi.fn(() => []),
            }
            const runtime = new SemanticSessionRuntime({
                sessionId: 'session-1',
                cwd: '/repo',
                provider,
                providerName: 'test-acp',
                channelPort: createChannel(sent, statuses),
            })

            const running = runtime.dispatch({ kind: 'user_message', text: 'hi', source: 'channel' })
            await vi.advanceTimersByTimeAsync(2_000)

            expect(sent.map(m => m.text)).toContain('partial answer')

            release()
            await running
        } finally {
            vi.useRealTimers()
        }
    })

    it('flushes stale assistant text before starting the next provider turn', async () => {
        const sent: ChannelMessage[] = []
        const statuses: SessionStatus[] = []
        const provider = createProvider([
            { kind: 'text', text: 'new response' },
            { kind: 'result', status: 'success' },
        ])
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'test-acp',
            channelPort: createChannel(sent, statuses),
        })
        ;(runtime as any).projector.project({
            kind: 'assistant_text_delta',
            text: 'stale tail',
            meta: {
                id: 'late-1',
                sessionId: 'session-1',
                turnId: 'previous-turn',
                provider: 'test-acp',
                seq: 1,
                timestamp: Date.now(),
                sourcePhase: 'tailDrain',
            },
        })

        await runtime.dispatch({ kind: 'user_message', text: 'next', source: 'channel' })

        expect(sent.map(m => m.text)).toEqual(['stale tail', 'new response'])
    })

    it('projects verbose tool updates as one message per tool without raw output', async () => {
        const sent: ChannelMessage[] = []
        const statuses: SessionStatus[] = []
        const operations: DeliveryOperation[] = []
        const provider = createProvider([
            { kind: 'tool_use', toolUseId: 'tool-1', toolName: 'Bash', input: { command: 'npm test' }, status: 'running' },
            { kind: 'tool_result', toolUseId: 'tool-1', toolName: 'Bash', output: 'passed', isError: false },
            { kind: 'result', status: 'success' },
        ])
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'test-acp',
            channelPort: createChannel(sent, statuses, operations),
            providerSettings: { verboseLevel: 2 },
        })

        await runtime.dispatch({ kind: 'user_message', text: 'run tests', source: 'channel' })

        expect(sent).toHaveLength(2)
        expect(sent[0].text).toContain('npm test')
        expect(sent[1].text).toContain('EDIT:')
        expect(sent[1].text).toContain('npm test')
        expect(sent[1].text).not.toContain('passed')
        expect(operations.map(op => op.kind)).toEqual(['send', 'edit'])
    })

    it('continues consuming provider events when a progressive edit is rate-limited', async () => {
        const sent: ChannelMessage[] = []
        const statuses: SessionStatus[] = []
        const operations: DeliveryOperation[] = []
        const channel = createChannel(sent, statuses, operations)
        vi.mocked(channel.edit!).mockRejectedValueOnce(new Error("Call to 'editMessageText' failed! (429: Too Many Requests: retry after 40)"))
        const provider = createProvider([
            { kind: 'tool_use', toolUseId: 'tool-1', toolName: 'Bash', input: { command: 'npm test' }, status: 'running' },
            { kind: 'tool_use', toolUseId: 'tool-1', toolName: 'Bash', input: { command: 'npm test -- --watch' }, status: 'running' },
            { kind: 'text', text: 'still consumed' },
            { kind: 'result', status: 'success' },
        ])
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'test-acp',
            channelPort: channel,
            providerSettings: { verboseLevel: 2 },
            outbox: new DeliveryOutbox({
                channelPort: channel,
                progressiveEditDebounceMs: 0,
            }),
        })

        await runtime.dispatch({ kind: 'user_message', text: 'run tests', source: 'channel' })

        expect(sent.map(message => message.text).join('\n')).toContain('still consumed')
        expect(runtime.getState()).toBe('idle')
        expect(runtime.getProgress().outbox.lastRateLimitError).toContain('Too Many Requests')
    })

    it('continues consuming provider text when a terminal progressive edit is rate-limited', async () => {
        vi.useFakeTimers()
        try {
            const sent: ChannelMessage[] = []
            const statuses: SessionStatus[] = []
            const operations: DeliveryOperation[] = []
            const channel = createChannel(sent, statuses, operations)
            vi.mocked(channel.edit!).mockRejectedValueOnce(new Error("Call to 'editMessageText' failed! (429: Too Many Requests: retry after 40)"))
            const provider = createProvider([
                { kind: 'tool_use', toolUseId: 'tool-1', toolName: 'Bash', input: { command: 'npm test' }, status: 'running' },
                { kind: 'tool_result', toolUseId: 'tool-1', toolName: 'Bash', output: 'passed', isError: false },
                { kind: 'text', text: 'after terminal edit' },
                { kind: 'result', status: 'success' },
            ])
            const runtime = new SemanticSessionRuntime({
                sessionId: 'session-1',
                cwd: '/repo',
                provider,
                providerName: 'test-acp',
                channelPort: channel,
                providerSettings: { verboseLevel: 2 },
                outbox: new DeliveryOutbox({
                    channelPort: channel,
                    progressiveEditDebounceMs: 0,
                }),
            })

            const running = runtime.dispatch({ kind: 'user_message', text: 'run tests', source: 'channel' })

            await vi.advanceTimersByTimeAsync(2_000)
            await vi.waitFor(() => {
                expect(sent.map(message => message.text).join('\n')).toContain('after terminal edit')
            })
            expect(runtime.getProgress().outbox.lastRateLimitError).toContain('Too Many Requests')

            await vi.advanceTimersByTimeAsync(5_000)
            await running
            expect(runtime.getState()).toBe('idle')

            await vi.advanceTimersByTimeAsync(40_000)
            await vi.runOnlyPendingTimersAsync()
        } finally {
            vi.useRealTimers()
        }
    })

    it('replaces the normal tool message between assistant text messages instead of appending history', async () => {
        const sent: ChannelMessage[] = []
        const statuses: SessionStatus[] = []
        const operations: DeliveryOperation[] = []
        const provider = createProvider([
            { kind: 'text', text: 'First answer\n' },
            { kind: 'tool_use', toolUseId: 'tool-1', toolName: 'Bash', input: { command: 'npm test' }, status: 'running' },
            { kind: 'tool_result', toolUseId: 'tool-1', toolName: 'Bash', output: 'passed', isError: false },
            { kind: 'tool_use', toolUseId: 'tool-2', toolName: 'Read', input: { file_path: '/repo/src/app.ts' }, status: 'running' },
            { kind: 'tool_result', toolUseId: 'tool-2', toolName: 'Read', output: 'const secret = "file body"', isError: false },
            { kind: 'text', text: 'Done' },
            { kind: 'result', status: 'success' },
        ])
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'test-acp',
            channelPort: createChannel(sent, statuses, operations),
            providerSettings: { verboseLevel: 1 },
        })

        await runtime.dispatch({ kind: 'user_message', text: 'run tests', source: 'channel' })

        expect(operations.map(op => op.kind)).toEqual(['send', 'send', 'edit', 'edit', 'send'])
        expect(operations[0].message.text).toBe('First answer\n')
        expect(operations[1].message.text).toContain('npm test')
        expect(operations[2].messageId).toBe(operations[1].messageId)
        expect(operations[3].messageId).toBe(operations[1].messageId)
        expect(operations[4].message.text).toBe('Done')

        const finalToolMessage = operations[3].message.text
        expect(finalToolMessage).toContain('Read')
        expect(finalToolMessage).toContain('/repo/src/app.ts')
        expect(finalToolMessage).not.toContain('npm test')
        expect(finalToolMessage).not.toContain('passed')
        expect(finalToolMessage).not.toContain('const secret')
    })

    it('suppresses all tool output in quiet mode while preserving assistant text', async () => {
        const sent: ChannelMessage[] = []
        const statuses: SessionStatus[] = []
        const operations: DeliveryOperation[] = []
        const provider = createProvider([
            { kind: 'tool_use', toolUseId: 'tool-1', toolName: 'Bash', input: { command: 'npm test' }, status: 'running' },
            { kind: 'tool_result', toolUseId: 'tool-1', toolName: 'Bash', output: 'passed', isError: false },
            { kind: 'text', text: 'Only assistant text' },
            { kind: 'result', status: 'success' },
        ])
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'test-acp',
            channelPort: createChannel(sent, statuses, operations),
            providerSettings: { verboseLevel: 0 },
        })

        await runtime.dispatch({ kind: 'user_message', text: 'run quietly', source: 'channel' })

        expect(operations).toHaveLength(1)
        expect(operations[0]).toMatchObject({
            kind: 'send',
            message: { text: 'Only assistant text', format: 'markdown' },
        })
        expect(sent.map(message => message.text).join('\n')).not.toContain('npm test')
        expect(sent.map(message => message.text).join('\n')).not.toContain('passed')
    })

    it('renders ExitPlanMode plan content even in quiet mode', async () => {
        const sent: ChannelMessage[] = []
        const statuses: SessionStatus[] = []
        const operations: DeliveryOperation[] = []
        const provider = createProvider([
            { kind: 'tool_result', toolUseId: 'plan-1', toolName: 'ExitPlanMode', output: '1. Inspect\n2. Implement', isError: false },
            { kind: 'result', status: 'success' },
        ])
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'test-acp',
            channelPort: createChannel(sent, statuses, operations),
            providerSettings: { verboseLevel: 0 },
        })

        await runtime.dispatch({ kind: 'user_message', text: 'make a plan', source: 'channel' })

        expect(operations).toHaveLength(1)
        expect(operations[0].message.text).toContain('Plan')
        expect(operations[0].message.text).toContain('Inspect')
        expect(operations[0].message.text).toContain('Implement')
    })

    it('does not render concrete tool content in any verbosity mode', async () => {
        for (const verboseLevel of [0, 1, 2] as const) {
            const sent: ChannelMessage[] = []
            const statuses: SessionStatus[] = []
            const provider = createProvider([
                { kind: 'tool_use', toolUseId: 'read-1', toolName: 'Read', input: { file_path: '/repo/private.ts' }, status: 'running' },
                { kind: 'tool_result', toolUseId: 'read-1', toolName: 'Read', output: 'const password = "super-secret"', isError: false },
                { kind: 'tool_use', toolUseId: 'edit-1', toolName: 'Edit', input: { file_path: '/repo/private.ts' }, status: 'running' },
                { kind: 'tool_result', toolUseId: 'edit-1', toolName: 'Edit', output: 'diff --git a/private.ts b/private.ts\n+token = "secret"', isError: false },
                { kind: 'text', text: `mode ${verboseLevel} done` },
                { kind: 'result', status: 'success' },
            ])
            const runtime = new SemanticSessionRuntime({
                sessionId: `session-${verboseLevel}`,
                cwd: '/repo',
                provider,
                providerName: 'test-acp',
                channelPort: createChannel(sent, statuses),
                providerSettings: { verboseLevel },
            })

            await runtime.dispatch({ kind: 'user_message', text: `mode ${verboseLevel}`, source: 'channel' })

            const rendered = sent.map(message => message.text).join('\n')
            expect(rendered).not.toContain('super-secret')
            expect(rendered).not.toContain('diff --git')
            expect(rendered).not.toContain('token = "secret"')
        }
    })

    it('injects cached file upload paths before the user prompt', async () => {
        const sent: ChannelMessage[] = []
        const statuses: SessionStatus[] = []
        const provider = createProvider([
            { kind: 'result', status: 'success' },
        ])
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-uploads',
            cwd: '/repo',
            provider,
            providerName: 'test-acp',
            channelPort: createChannel(sent, statuses),
        })

        await runtime.dispatch({
            kind: 'user_message',
            text: 'please inspect it',
            source: 'channel',
            richInput: {
                parts: [
                    {
                        type: 'file',
                        path: 'C:/Users/me/.config/codever/uploads/report.pdf',
                        filename: 'report.pdf',
                        mimeType: 'application/pdf',
                        sizeBytes: 1234,
                    },
                    { type: 'text', text: 'please inspect it' },
                ],
            },
        })

        expect(provider.startQuery).toHaveBeenCalledWith({
            parts: [
                {
                    type: 'text',
                    text: expect.stringContaining('report.pdf: C:/Users/me/.config/codever/uploads/report.pdf (application/pdf, 1234 bytes)'),
                },
                { type: 'text', text: 'please inspect it' },
            ],
        }, expect.objectContaining({ cwd: '/repo' }))
    })
})
