import { describe, expect, it, vi } from 'vitest'
import { SemanticSessionRuntime } from '@/runtime/semanticSessionRuntime'
import { DeliveryOutbox } from '@/runtime/deliveryOutbox'
import type { AgentProvider, AgentQueryConfig, AgentQueryHandle, AgentQueryInput } from '@/providers/provider'
import type { AgentEvent } from '@/providers/types'
import type { SessionExtensionInstance } from '@/runtime/sessionExtensions'
import type { PrivilegeExecutor } from '@/privilege'
import type {
    ChannelMessage,
    ChannelPort,
    ChannelSendResult,
    SessionStatus,
} from '@/bridge/channelPort'

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
    it('requires a fresh TOTP-backed privilege decision for every execution', async () => {
        let release!: () => void
        const hold = new Promise<void>(resolve => {
            release = resolve
        })
        const provider: AgentProvider = {
            ...createProvider([]),
            startQuery: vi.fn((_prompt: AgentQueryInput, _config: AgentQueryConfig): AgentQueryHandle => ({
                events: (async function* () {
                    await hold
                    yield { kind: 'result', status: 'success' } as AgentEvent
                })(),
                interrupt: vi.fn(),
            })),
        }
        const requestDecision = vi.fn(async () => ({ value: 'allow_once', totp: '123456' }))
        const channel = {
            ...createChannel([], []),
            requestDecision,
        }
        const execute = vi.fn<PrivilegeExecutor['execute']>(async request => ({
            requestId: request.requestId,
            status: 'succeeded',
            exitCode: 0,
            signal: null,
            stdout: 'ok\n',
            stderr: '',
            truncated: false,
            startedAt: request.requestedAt,
            completedAt: request.requestedAt + 1,
        }))
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-privileged',
            cwd: '/repo',
            provider,
            providerName: 'test-acp',
            channelPort: channel,
            privilegeExecutor: { execute },
        })

        const running = runtime.dispatch({
            kind: 'user_message',
            text: 'perform maintenance',
            source: 'channel',
        })
        await waitUntil(() => runtime.getState() === 'querying')

        await runtime.requestPrivilegedExecution({
            executable: '/usr/bin/id',
            args: ['-u'],
            reason: 'Confirm effective user',
            timeoutMs: 5_000,
        })
        await runtime.requestPrivilegedExecution({
            executable: '/usr/bin/whoami',
            args: [],
            reason: 'Confirm account name',
            timeoutMs: 5_000,
        })

        expect(requestDecision).toHaveBeenCalledTimes(2)
        expect(requestDecision).toHaveBeenCalledWith(expect.objectContaining({
            type: 'privilege',
            details: expect.stringContaining('/usr/bin/id -u'),
            options: expect.arrayContaining([
                { label: 'Unlock and allow once', value: 'allow_once' },
                { label: 'Deny', value: 'deny' },
            ]),
        }))
        expect(execute).toHaveBeenCalledTimes(2)
        expect(execute.mock.calls[0]?.[0]).toMatchObject({
            version: 2,
            sessionId: 'session-privileged',
            cwd: '/repo',
            executable: '/usr/bin/id',
            args: ['-u'],
            totp: '123456',
        })
        expect(provider.startQuery).toHaveBeenCalledWith(
            'perform maintenance',
            expect.objectContaining({ codeverSessionId: 'session-privileged' }),
        )

        release()
        await running
    })

    it('does not execute a privileged request denied by the approval device', async () => {
        let release!: () => void
        const hold = new Promise<void>(resolve => {
            release = resolve
        })
        const provider: AgentProvider = {
            ...createProvider([]),
            startQuery: vi.fn((): AgentQueryHandle => ({
                events: (async function* () {
                    await hold
                    yield { kind: 'result', status: 'success' } as AgentEvent
                })(),
                interrupt: vi.fn(),
            })),
        }
        const execute = vi.fn<PrivilegeExecutor['execute']>()
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-denied',
            cwd: '/repo',
            provider,
            providerName: 'test-acp',
            channelPort: {
                ...createChannel([], []),
                requestDecision: vi.fn(async () => ({ value: 'deny' })),
            },
            privilegeExecutor: { execute },
        })
        const running = runtime.dispatch({
            kind: 'user_message',
            text: 'perform maintenance',
            source: 'channel',
        })
        await waitUntil(() => runtime.getState() === 'querying')

        await expect(runtime.requestPrivilegedExecution({
            executable: '/usr/bin/id',
            args: [],
            reason: 'Denied test',
            timeoutMs: 5_000,
        })).rejects.toMatchObject({ name: 'PrivilegeExecutionDeniedError' })
        expect(execute).not.toHaveBeenCalled()

        release()
        await running
    })

    it('applies model settings without waiting for an active turn', async () => {
        let release!: () => void
        const hold = new Promise<void>(resolve => {
            release = resolve
        })
        const onModelChanged = vi.fn()
        const onReasoningEffortChanged = vi.fn()
        const provider: AgentProvider = {
            ...createProvider([]),
            startQuery: vi.fn((_prompt: AgentQueryInput, _config: AgentQueryConfig): AgentQueryHandle => ({
                events: (async function* () {
                    await hold
                    yield { kind: 'result', status: 'success' } as AgentEvent
                })(),
                interrupt: vi.fn(),
            })),
        }
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'test-acp',
            channelPort: createChannel([], []),
            onModelChanged,
            onReasoningEffortChanged,
        })

        const running = runtime.dispatch({ kind: 'user_message', text: 'long task', source: 'channel' })
        await delay(10)

        await expect(runtime.dispatch({ kind: 'command', name: 'model', args: 'next-model', source: 'channel' })).resolves.toBeUndefined()
        await expect(runtime.dispatch({ kind: 'command', name: 'reasoningEffort', args: 'high', source: 'channel' })).resolves.toBeUndefined()
        expect(onModelChanged).toHaveBeenCalledWith('next-model')
        expect(onReasoningEffortChanged).toHaveBeenCalledWith('high')

        release()
        await running
    })

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

    it('sends only prepared input to the provider and journals canonical sanitized events', async () => {
        const sent: ChannelMessage[] = []
        const provider = createProvider([
            { kind: 'text', text: 'Hello Alias' },
            { kind: 'result', status: 'success' },
        ])
        const extension: SessionExtensionInstance = {
            id: 'privacy',
            summary: { id: 'privacy', name: 'Privacy', version: '1' },
            prepareTurn: async () => ({
                kind: 'ready',
                input: 'Ask about Alias',
                stateRef: 'mapping-v1',
            }),
            presentEvent: async value => value.kind === 'assistant_text_delta'
                ? [{ ...value, text: value.text.replace('Alias', 'Original Name') }]
                : [value],
            lifecycle: async () => undefined,
        }
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'test-acp',
            channelPort: createChannel(sent, []),
            extensions: [extension],
        })

        await runtime.dispatch({
            kind: 'user_message',
            text: 'Ask about Original Name',
            source: 'channel',
        })

        expect(provider.startQuery).toHaveBeenCalledWith(
            'Ask about Alias',
            expect.objectContaining({ cwd: '/repo' }),
        )
        expect(runtime.journal.list()).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'assistant_text_delta', text: 'Hello Alias' }),
        ]))
        expect(sent.map(message => message.text)).toEqual(['Hello Original Name'])
    })

    it('does not start the provider when an extension preview is denied', async () => {
        const sent: ChannelMessage[] = []
        const channel = createChannel(sent, [])
        vi.mocked(channel.requestDecision).mockResolvedValue({ value: 'deny' })
        const approve = vi.fn(async () => ({ kind: 'ready' as const, input: 'sanitized' }))
        const reject = vi.fn(async () => undefined)
        const extension: SessionExtensionInstance = {
            id: 'privacy',
            summary: { id: 'privacy', name: 'Privacy', version: '1' },
            prepareTurn: async () => ({
                kind: 'approval_required',
                approval: { title: 'Review outbound prompt' },
                approve,
                reject,
            }),
            presentEvent: async value => [value],
            lifecycle: async () => undefined,
        }
        const provider = createProvider([])
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'test-acp',
            channelPort: channel,
            extensions: [extension],
        })

        await runtime.dispatch({ kind: 'user_message', text: 'private', source: 'channel' })

        expect(provider.startQuery).not.toHaveBeenCalled()
        expect(approve).not.toHaveBeenCalled()
        expect(reject).toHaveBeenCalledOnce()
        expect(sent.at(-1)?.text).toContain('cancelled before it reached the Agent')
        expect(runtime.journal.list().at(-1)).toMatchObject({
            kind: 'turn_finished',
            status: 'cancelled',
        })
    })

    it('lets an extension flush retained display text when the provider stream fails', async () => {
        let pending = ''
        const extension: SessionExtensionInstance = {
            id: 'privacy',
            summary: { id: 'privacy', name: 'Privacy', version: '1' },
            prepareTurn: async input => ({ kind: 'ready', input, stateRef: 'mapping-v1' }),
            presentEvent: async value => {
                if (value.kind === 'assistant_text_delta') {
                    pending += value.text
                    return []
                }
                if (value.kind === 'turn_finished' && pending) {
                    const text = pending.replace('Alias', 'Original')
                    pending = ''
                    return [{ ...value, kind: 'assistant_text_delta', text }, value]
                }
                return [value]
            },
            lifecycle: async () => undefined,
        }
        const provider: AgentProvider = {
            ...createProvider([]),
            startQuery: vi.fn(() => ({
                events: (async function* () {
                    yield { kind: 'text', text: 'Alias tail' } as AgentEvent
                    throw new Error('provider stream failed')
                })(),
                interrupt: vi.fn(),
            })),
        }
        const sent: ChannelMessage[] = []
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'test-acp',
            channelPort: createChannel(sent, []),
            extensions: [extension],
        })

        await runtime.dispatch({ kind: 'user_message', text: 'prompt', source: 'channel' })

        expect(sent.map(message => message.text).join('\n')).toContain('Original tail')
        expect(sent.map(message => message.text).join('\n')).toContain('Agent error')
        expect(runtime.journal.list().at(-1)).toMatchObject({
            kind: 'turn_finished',
            status: 'error',
            summary: 'provider stream failed',
        })
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
        expect(rendered).toContain('messaging channel permanently rejected')
        expect(rendered).not.toContain('Telegram delivery')
        expect(rendered).toContain('/delivery delivery-1')
        expect(runtime.getDeliveryStatus('delivery-1').deliveries[0].message.text).toBe('final answer')

        await runtime.dispatch({ kind: 'command', name: 'progress', source: 'channel' })
        expect(sent.at(-1)?.text).toContain('Last delivery failure')
    })

    it('does not emit a failure warning or duplicate retry while confirmation is delayed', async () => {
        vi.useFakeTimers()
        try {
            const sent: ChannelMessage[] = []
            const statuses: SessionStatus[] = []
            const channel = createChannel(sent, statuses)
            channel.send = vi.fn(async () => await new Promise<ChannelSendResult>(() => {}))
            const provider = createProvider([
                { kind: 'text', text: 'durably queued answer' },
                { kind: 'result', status: 'success' },
            ])
            const outbox = new DeliveryOutbox({
                channelPort: channel,
                deliveryTimeoutMs: 100,
            })
            const runtime = new SemanticSessionRuntime({
                sessionId: 'session-1',
                cwd: '/repo',
                provider,
                providerName: 'test-acp',
                channelPort: channel,
                outbox,
            })

            const running = runtime.dispatch({ kind: 'user_message', text: 'hi', source: 'channel' })
            await vi.advanceTimersByTimeAsync(100)
            await running

            const delayed = runtime.getDeliveryStatus('delivery-1').deliveries[0]
            expect(delayed).toMatchObject({
                status: 'queued',
                message: { text: 'durably queued answer' },
            })
            expect(sent.map(message => message.text).join('\n')).not.toContain('Delivery warning')

            await expect(runtime.retryDelivery('delivery-1')).resolves.toMatchObject({
                status: 'queued',
                deliveryId: 'delivery-1',
            })
            expect(channel.send).toHaveBeenCalledTimes(1)
        } finally {
            vi.useRealTimers()
        }
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

    it('updates one assistant message when quiet periods split a sentence into tiny deltas', async () => {
        vi.useFakeTimers()
        try {
            const sent: ChannelMessage[] = []
            const statuses: SessionStatus[] = []
            const operations: DeliveryOperation[] = []
            let releaseFirst!: () => void
            let releaseSecond!: () => void
            const firstPause = new Promise<void>(resolve => {
                releaseFirst = resolve
            })
            const secondPause = new Promise<void>(resolve => {
                releaseSecond = resolve
            })
            const provider: AgentProvider = {
                ...createProvider([]),
                startQuery: vi.fn((_prompt: AgentQueryInput, _config: AgentQueryConfig): AgentQueryHandle => ({
                    events: (async function* () {
                        yield { kind: 'text', text: '这' } as AgentEvent
                        await firstPause
                        yield { kind: 'text', text: '是一' } as AgentEvent
                        await secondPause
                        yield { kind: 'text', text: '句话' } as AgentEvent
                        yield { kind: 'result', status: 'success' } as AgentEvent
                    })(),
                    interrupt: vi.fn(),
                })),
            }
            const channel = {
                ...createChannel(sent, statuses, operations),
                coalesceAssistantText: true,
            }
            const runtime = new SemanticSessionRuntime({
                sessionId: 'session-1',
                cwd: '/repo',
                provider,
                providerName: 'test-acp',
                channelPort: channel,
            })

            const running = runtime.dispatch({ kind: 'user_message', text: 'hi', source: 'channel' })
            await vi.advanceTimersByTimeAsync(0)
            expect(operations).toMatchObject([
                { kind: 'send', message: { text: '这' }, messageId: 1 },
            ])

            releaseFirst()
            await vi.advanceTimersByTimeAsync(600)
            expect(operations).toMatchObject([
                { kind: 'send', message: { text: '这' }, messageId: 1 },
                { kind: 'edit', message: { text: '这是一' }, messageId: 1 },
            ])

            releaseSecond()
            await running
            expect(operations).toMatchObject([
                { kind: 'send', message: { text: '这' }, messageId: 1 },
                { kind: 'edit', message: { text: '这是一' }, messageId: 1 },
                { kind: 'edit', message: { text: '这是一句话' }, messageId: 1 },
            ])
        } finally {
            vi.useRealTimers()
        }
    })

    it('streams a continuously arriving sentence without waiting for a quiet period', async () => {
        vi.useFakeTimers()
        try {
            const operations: DeliveryOperation[] = []
            let finish!: () => void
            const hold = new Promise<void>(resolve => {
                finish = resolve
            })
            const provider: AgentProvider = {
                ...createProvider([]),
                startQuery: vi.fn((_prompt: AgentQueryInput, _config: AgentQueryConfig): AgentQueryHandle => ({
                    events: (async function* () {
                        yield { kind: 'text', text: '这' } as AgentEvent
                        for (const text of ['是', '一', '句', '话']) {
                            await delay(100)
                            yield { kind: 'text', text } as AgentEvent
                        }
                        await hold
                        yield { kind: 'result', status: 'success' } as AgentEvent
                    })(),
                    interrupt: vi.fn(),
                })),
            }
            const channel = {
                ...createChannel([], [], operations),
                coalesceAssistantText: true,
            }
            const runtime = new SemanticSessionRuntime({
                sessionId: 'session-1',
                cwd: '/repo',
                provider,
                providerName: 'test-acp',
                channelPort: channel,
            })

            const running = runtime.dispatch({ kind: 'user_message', text: 'hi', source: 'channel' })
            await vi.advanceTimersByTimeAsync(0)
            expect(operations).toMatchObject([
                { kind: 'send', message: { text: '这' }, messageId: 1 },
            ])

            await vi.advanceTimersByTimeAsync(650)
            expect(operations).toMatchObject([
                { kind: 'send', message: { text: '这' }, messageId: 1 },
                { kind: 'edit', message: { text: '这是一句话' }, messageId: 1 },
            ])

            finish()
            await running
        } finally {
            vi.useRealTimers()
        }
    })

    it('keeps interleaved tools separate and preserves assistant paragraph boundaries in one bubble', async () => {
        const sent: ChannelMessage[] = []
        const statuses: SessionStatus[] = []
        const operations: DeliveryOperation[] = []
        const channel = {
            ...createChannel(sent, statuses, operations),
            coalesceAssistantText: true,
        }
        const provider = createProvider([
            { kind: 'text', text: '我先' },
            { kind: 'tool_use', toolUseId: 'tool-1', toolName: 'Bash', input: { command: 'pwd' }, status: 'running' },
            { kind: 'text', text: '检查' },
            { kind: 'tool_result', toolUseId: 'tool-1', toolName: 'Bash', output: '/repo', isError: false },
            { kind: 'text', text: '完成。' },
            { kind: 'result', status: 'success' },
        ])
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'test-acp',
            channelPort: channel,
            providerSettings: { verboseLevel: 2 },
        })

        await runtime.dispatch({ kind: 'user_message', text: 'inspect', source: 'channel' })

        const assistantOperations = operations.filter(operation => !operation.message.presentation)
        expect(assistantOperations).toMatchObject([
            { kind: 'send', message: { text: '我先' }, messageId: 1 },
            { kind: 'edit', message: { text: '我先\n\n检查' }, messageId: 1 },
            { kind: 'edit', message: { text: '我先\n\n检查\n\n完成。' }, messageId: 1 },
        ])
        expect(operations.filter(operation => operation.message.presentation)).toHaveLength(2)
    })

    it('does not duplicate an assistant paragraph break already supplied after a tool', async () => {
        const operations: DeliveryOperation[] = []
        const channel = {
            ...createChannel([], [], operations),
            coalesceAssistantText: true,
        }
        const provider = createProvider([
            { kind: 'text', text: '第一段。' },
            { kind: 'tool_use', toolUseId: 'tool-1', toolName: 'Read', input: { path: 'README.md' }, status: 'running' },
            { kind: 'text', text: '\n\n第二段。' },
            { kind: 'result', status: 'success' },
        ])
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'test-acp',
            channelPort: channel,
        })

        await runtime.dispatch({ kind: 'user_message', text: 'inspect', source: 'channel' })

        const assistantOperations = operations.filter(operation => !operation.message.presentation)
        expect(assistantOperations.at(-1)).toMatchObject({
            kind: 'edit',
            message: { text: '第一段。\n\n第二段。' },
            messageId: 1,
        })
    })

    it('waits for the first assistant send id before turning a concurrent flush into an edit', async () => {
        vi.useFakeTimers()
        try {
            const operations: DeliveryOperation[] = []
            let releaseProvider!: () => void
            let releaseFirstSend!: () => void
            let markFirstSendStarted!: () => void
            const providerPause = new Promise<void>(resolve => {
                releaseProvider = resolve
            })
            const firstSendPause = new Promise<void>(resolve => {
                releaseFirstSend = resolve
            })
            const firstSendStarted = new Promise<void>(resolve => {
                markFirstSendStarted = resolve
            })
            let nextMessageId = 0
            const channel: ChannelPort = {
                coalesceAssistantText: true,
                send: vi.fn(async (message) => {
                    const messageId = ++nextMessageId
                    operations.push({ kind: 'send', message, messageId })
                    if (messageId === 1) {
                        markFirstSendStarted()
                        await firstSendPause
                    }
                    return { messageId }
                }),
                edit: vi.fn(async (messageId, message) => {
                    operations.push({ kind: 'edit', message, messageId })
                }),
                requestDecision: vi.fn(async () => ({ value: 'allow' })),
                notifyStatus: vi.fn(),
            }
            const provider: AgentProvider = {
                ...createProvider([]),
                startQuery: vi.fn((_prompt: AgentQueryInput, _config: AgentQueryConfig): AgentQueryHandle => ({
                    events: (async function* () {
                        yield { kind: 'text', text: '这' } as AgentEvent
                        await providerPause
                        yield { kind: 'text', text: '是' } as AgentEvent
                        yield {
                            kind: 'tool_use',
                            toolUseId: 'tool-1',
                            toolName: 'Bash',
                            input: { command: 'pwd' },
                            status: 'running',
                        } as AgentEvent
                        yield { kind: 'result', status: 'success' } as AgentEvent
                    })(),
                    interrupt: vi.fn(),
                })),
            }
            const runtime = new SemanticSessionRuntime({
                sessionId: 'session-1',
                cwd: '/repo',
                provider,
                providerName: 'test-acp',
                channelPort: channel,
                providerSettings: { verboseLevel: 2 },
            })

            const running = runtime.dispatch({ kind: 'user_message', text: 'inspect', source: 'channel' })
            await vi.advanceTimersByTimeAsync(2_000)
            await firstSendStarted
            releaseProvider()
            await vi.advanceTimersByTimeAsync(0)
            releaseFirstSend()
            await running

            expect(operations.filter(operation => !operation.message.presentation)).toMatchObject([
                { kind: 'send', message: { text: '这' }, messageId: 1 },
                { kind: 'edit', message: { text: '这是' }, messageId: 1 },
            ])
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

    it('updates one normal tool group while retaining every structured tool item', async () => {
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
        expect(operations[3].message.presentation).toMatchObject({
            kind: 'tool_group',
            tools: [
                {
                    id: 'tool-1',
                    name: 'Bash',
                    detail: 'npm test',
                    phase: 'completed',
                },
                {
                    id: 'tool-2',
                    name: 'Read',
                    detail: '/repo/src/app.ts',
                    phase: 'completed',
                },
            ],
        })
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

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (predicate()) return
        await delay(5)
    }
    throw new Error(`Condition was not met within ${timeoutMs}ms`)
}
