import { describe, expect, it, vi } from 'vitest'
import { AcpProvider, formatAgentQueryError, type AcpSessionConfiguration } from '@/providers/acp'
import type { AgentEvent } from '@/providers/types'

interface FakeSessionNotification {
    sessionId: string
    update: {
        sessionUpdate: 'agent_message_chunk'
        content: { type: 'text'; text: string }
    }
}

interface FakeWaiter {
    resolve: (notification: FakeSessionNotification) => void
    reject: (error: unknown) => void
    signal?: AbortSignal
}

class FakeAcpClientManager {
    connected = true
    supportsResumeSession = false
    agentCapabilities = { agentCapabilities: { loadSession: false } }
    promptCapabilities = {}
    promptText = 'final tail'
    loadSessionHistoryText: string | null = null
    setModelCalls: Array<{ sessionId: string; modelId: string }> = []
    setConfigOptionCalls: Array<{ sessionId: string; configId: string; value: string }> = []
    setModelError: Error | null = null
    setConfigOptionError: Error | null = null
    reportedConfigValue: string | null = null
    omitConfigOption = false
    promptCalls = 0

    private queue: FakeSessionNotification[] = []
    private waiters: FakeWaiter[] = []
    private sessionUpdateProcessing: Promise<void> = Promise.resolve()

    setPermissionHandler(): void {}
    setExtensionHandler(): void {}
    clearStderrBuffer(): void {}
    getStderrError(): string | null { return null }

    async newSession(): Promise<{
        sessionId: string
        models?: { currentModelId: string; availableModels: Array<{ modelId: string; name: string }> }
        configOptions?: Array<{ id: string; name: string; category?: string }>
    }> {
        return { sessionId: 'session-1' }
    }

    async setSessionModel(params: { sessionId: string; modelId: string }): Promise<Record<string, never>> {
        this.setModelCalls.push(params)
        if (this.setModelError) throw this.setModelError
        return {}
    }

    async setSessionConfigOption(params: { sessionId: string; configId: string; value: string }): Promise<{ configOptions: Array<{ id: string; currentValue: string }> }> {
        this.setConfigOptionCalls.push(params)
        if (this.setConfigOptionError) throw this.setConfigOptionError
        return { configOptions: this.omitConfigOption ? [] : [{ id: params.configId, currentValue: this.reportedConfigValue ?? params.value }] }
    }

    async resumeSession(): Promise<{ sessionId: string }> {
        return { sessionId: 'session-1' }
    }

    async loadSession(): Promise<unknown> {
        if (this.loadSessionHistoryText) {
            setTimeout(() => {
                this.emit({
                    sessionId: 'session-1',
                    update: {
                        sessionUpdate: 'agent_message_chunk',
                        content: { type: 'text', text: this.loadSessionHistoryText! },
                    },
                })
            }, 20)
        }
        return {}
    }

    async prompt(): Promise<{ stopReason: string }> {
        this.promptCalls += 1
        this.sessionUpdateProcessing = new Promise(resolve => {
            setTimeout(() => {
                this.emit({
                    sessionId: 'session-1',
                    update: {
                        sessionUpdate: 'agent_message_chunk',
                        content: { type: 'text', text: this.promptText },
                    },
                })
                resolve()
            }, 150)
        })
        return { stopReason: 'end_turn' }
    }

    async waitForSessionUpdateProcessing(): Promise<void> {
        await this.sessionUpdateProcessing
    }

    dequeueSessionUpdate(): FakeSessionNotification | undefined {
        return this.queue.shift()
    }

    drainSessionUpdates(): number {
        const count = this.queue.length
        this.queue.length = 0
        return count
    }

    async drainSessionUpdatesUntilIdle(_sessionId: string, options: { idleMs: number; maxMs: number }): Promise<number> {
        const startedAt = Date.now()
        let drained = 0

        while (Date.now() - startedAt < options.maxMs) {
            let queued = this.queue.shift()
            while (queued) {
                drained += 1
                queued = this.queue.shift()
            }

            const remainingMs = options.maxMs - (Date.now() - startedAt)
            const waitMs = Math.min(options.idleMs, remainingMs)
            if (waitMs <= 0) break

            const waitAbort = new AbortController()
            const timer = setTimeout(() => waitAbort.abort(), waitMs)
            try {
                await this.waitForSessionUpdate('session-1', { signal: waitAbort.signal })
                drained += 1
            } catch {
                break
            } finally {
                clearTimeout(timer)
            }
        }

        return drained
    }

    waitForSessionUpdate(_sessionId: string, options: { signal?: AbortSignal } = {}): Promise<FakeSessionNotification> {
        const queued = this.queue.shift()
        if (queued) return Promise.resolve(queued)
        if (options.signal?.aborted) return Promise.reject(new Error('Session update wait aborted'))

        return new Promise((resolve, reject) => {
            const cleanup = () => {
                options.signal?.removeEventListener('abort', onAbort)
            }
            const waiter: FakeWaiter = {
                resolve: (notification) => {
                    cleanup()
                    resolve(notification)
                },
                reject: (error) => {
                    cleanup()
                    reject(error)
                },
                signal: options.signal,
            }
            const onAbort = () => {
                const index = this.waiters.indexOf(waiter)
                if (index >= 0) this.waiters.splice(index, 1)
                waiter.reject(new Error('Session update wait aborted'))
            }
            options.signal?.addEventListener('abort', onAbort, { once: true })
            this.waiters.push(waiter)
        })
    }

    get pendingWaiterCount(): number {
        return this.waiters.length
    }

    private emit(notification: FakeSessionNotification): void {
        const waiter = this.waiters.shift()
        if (waiter) {
            waiter.resolve(notification)
            return
        }
        this.queue.push(notification)
    }
}

describe('AcpProvider tail drain', () => {
    it('delivers final session updates whose handler settles after prompt resolves', async () => {
        const provider = new AcpProvider({ name: 'test-acp', command: 'fake', args: [] })
        const clientManager = new FakeAcpClientManager()
        ;(provider as any).clientManager = clientManager
        ;(provider as any).initialized = true

        const handle = provider.startQuery('hi', {
            cwd: '/repo',
            signal: new AbortController().signal,
        })
        const events: AgentEvent[] = []

        for await (const event of handle.events) {
            events.push(event)
        }

        expect(events.map(event => event.kind)).toEqual([
            'session_init',
            'text',
            'result',
        ])
        expect(events[1]).toMatchObject({ kind: 'text', text: 'final tail' })
        expect(clientManager.pendingWaiterCount).toBe(0)
    })

    it('drains delayed loadSession history before consuming live prompt updates', async () => {
        const provider = new AcpProvider({ name: 'cursor-test-acp', command: 'fake', args: [] })
        const clientManager = new FakeAcpClientManager()
        clientManager.agentCapabilities = { agentCapabilities: { loadSession: true } }
        clientManager.loadSessionHistoryText = 'old history from loadSession'
        clientManager.promptText = 'live response'
        ;(provider as any).clientManager = clientManager
        ;(provider as any).initialized = true

        const handle = provider.startQuery('hi', {
            cwd: '/repo',
            sessionId: 'session-1',
            signal: new AbortController().signal,
        })
        const events: AgentEvent[] = []

        for await (const event of handle.events) {
            events.push(event)
        }

        expect(events.map(event => event.kind)).toEqual([
            'session_init',
            'text',
            'result',
        ])
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'text', text: 'live response' }),
        ]))
        expect(events).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'text', text: 'old history from loadSession' }),
        ]))
        expect(clientManager.pendingWaiterCount).toBe(0)
    })

    it('resolves the selected alias against session models before calling ACP setters', async () => {
        class ModelResolvingProvider extends AcpProvider {
            protected override resolveSessionModel(_model: string, configuration: AcpSessionConfiguration | undefined): string | undefined {
                return configuration?.models?.availableModels[0]?.modelId
            }
        }

        const provider = new ModelResolvingProvider({ name: 'cursor-test-acp', command: 'fake', args: [] })
        const clientManager = new FakeAcpClientManager()
        clientManager.newSession = async () => ({
            sessionId: 'session-1',
            models: {
                currentModelId: 'auto-smart[optimize_for=balanced]',
                availableModels: [{ modelId: 'kimi-k3[reasoning=max]', name: 'kimi-k3' }],
            },
            configOptions: [{ id: 'model', name: 'Model', category: 'model' }],
        })
        ;(provider as any).clientManager = clientManager
        ;(provider as any).initialized = true

        const handle = provider.startQuery('hi', {
            cwd: '/repo',
            model: 'kimi-k3',
            signal: new AbortController().signal,
        })
        for await (const _event of handle.events) {}

        expect(clientManager.setModelCalls).toEqual([
            { sessionId: 'session-1', modelId: 'kimi-k3[reasoning=max]' },
        ])
        expect(clientManager.setConfigOptionCalls).toEqual([
            { sessionId: 'session-1', configId: 'model', value: 'kimi-k3[reasoning=max]' },
        ])
    })

    it.each([false, true])('stops before the prompt when both model setters reject (resumed=%s)', async (resumed) => {
        const provider = new AcpProvider({ name: 'codex-test-acp', command: 'fake', args: [] })
        const clientManager = new FakeAcpClientManager()
        clientManager.supportsResumeSession = resumed
        clientManager.setModelError = new Error('Internal error')
        clientManager.setConfigOptionError = new Error('Invalid params')
        ;(provider as any).clientManager = clientManager
        ;(provider as any).initialized = true

        const handle = provider.startQuery('hi', {
            cwd: '/repo',
            ...(resumed ? { sessionId: 'session-1' } : {}),
            model: 'gpt-6-sol',
            signal: new AbortController().signal,
        })
        const events: AgentEvent[] = []
        for await (const event of handle.events) events.push(event)

        expect(clientManager.promptCalls).toBe(0)
        expect(clientManager.setModelCalls).toEqual([{ sessionId: 'session-1', modelId: 'gpt-6-sol' }])
        expect(clientManager.setConfigOptionCalls).toEqual([{ sessionId: 'session-1', configId: 'model', value: 'gpt-6-sol' }])
        expect(events).toEqual([expect.objectContaining({
            kind: 'result',
            status: 'error',
            summary: expect.stringContaining('Could not apply selected model gpt-6-sol'),
        })])
        expect((events[0] as Extract<AgentEvent, { kind: 'result' }>).summary).toContain('Prompt was not sent')
    })

    it('uses the config option when the ACP model method is unsupported', async () => {
        const provider = new AcpProvider({ name: 'codex-test-acp', command: 'fake', args: [] })
        const clientManager = new FakeAcpClientManager()
        clientManager.setModelError = new Error('Method not found')
        ;(provider as any).clientManager = clientManager
        ;(provider as any).initialized = true

        const handle = provider.startQuery('hi', {
            cwd: '/repo',
            model: 'gpt-6-sol',
            signal: new AbortController().signal,
        })
        const events: AgentEvent[] = []
        for await (const event of handle.events) events.push(event)

        expect(clientManager.promptCalls).toBe(1)
        expect(events.at(-1)).toMatchObject({ kind: 'result', status: 'success' })
    })

    it('rejects a Codex model when the setter fails even if config echoes the requested value', async () => {
        const provider = new AcpProvider({ name: 'codex', command: 'fake', args: [], requireModelSetter: true })
        const clientManager = new FakeAcpClientManager()
        clientManager.setModelError = new Error('Internal error')
        ;(provider as any).clientManager = clientManager
        ;(provider as any).initialized = true

        const handle = provider.startQuery('hi', {
            cwd: '/repo', model: 'gpt-6-sol', signal: new AbortController().signal,
        })
        const events: AgentEvent[] = []
        for await (const event of handle.events) events.push(event)

        expect(clientManager.promptCalls).toBe(0)
        expect(clientManager.setConfigOptionCalls).toEqual([])
        expect(events.at(-1)).toMatchObject({
            kind: 'result', status: 'error', errorCode: 'model_selection_failed',
            summary: expect.stringContaining('Prompt was not sent'),
        })
    })

    it('does not resume or load a new Codex session before its first prompt', async () => {
        const provider = new AcpProvider({ name: 'codex', command: 'fake', args: [], deferInitialSessionReconnect: true })
        const clientManager = new FakeAcpClientManager()
        clientManager.supportsResumeSession = true
        const resume = vi.spyOn(clientManager, 'resumeSession')
        const load = vi.spyOn(clientManager, 'loadSession')
        ;(provider as any).clientManager = clientManager
        ;(provider as any).initialized = true

        const handle = provider.startQuery('hi', { cwd: '/repo', signal: new AbortController().signal })
        for await (const _event of handle.events) {}

        expect(resume).not.toHaveBeenCalled()
        expect(load).not.toHaveBeenCalled()
        expect(clientManager.promptCalls).toBe(1)
    })

    it.each(['different', 'missing'])('rejects an unconfirmed config model after the ACP model method fails (%s)', async (responseKind) => {
        const provider = new AcpProvider({ name: 'codex-test-acp', command: 'fake', args: [] })
        const clientManager = new FakeAcpClientManager()
        clientManager.setModelError = new Error('Internal error')
        clientManager.reportedConfigValue = responseKind === 'different' ? 'gpt-6-astra' : null
        clientManager.omitConfigOption = responseKind === 'missing'
        ;(provider as any).clientManager = clientManager
        ;(provider as any).initialized = true

        const handle = provider.startQuery('hi', {
            cwd: '/repo',
            model: 'gpt-6-sol',
            signal: new AbortController().signal,
        })
        const events: AgentEvent[] = []
        for await (const event of handle.events) events.push(event)

        expect(clientManager.promptCalls).toBe(0)
        expect(events.at(-1)).toMatchObject({ kind: 'result', status: 'error', summary: expect.stringContaining('gpt-6-sol') })
    })

    it('stops when the config response reports a different model even if set_model was accepted', async () => {
        const provider = new AcpProvider({ name: 'codex-test-acp', command: 'fake', args: [] })
        const clientManager = new FakeAcpClientManager()
        clientManager.reportedConfigValue = 'gpt-6-astra'
        ;(provider as any).clientManager = clientManager
        ;(provider as any).initialized = true

        const handle = provider.startQuery('hi', {
            cwd: '/repo',
            model: 'gpt-6-sol',
            signal: new AbortController().signal,
        })
        const events: AgentEvent[] = []
        for await (const event of handle.events) events.push(event)

        expect(clientManager.promptCalls).toBe(0)
        expect(events.at(-1)).toMatchObject({
            kind: 'result',
            status: 'error',
            summary: expect.stringContaining('ACP reported gpt-6-astra instead of gpt-6-sol'),
        })
    })
})

describe('formatAgentQueryError', () => {
    it('adds provider and request context when the upstream message is generic', () => {
        const error = Object.assign(new Error('Internal error'), {
            name: 'RequestError',
            code: 'internal_error',
            requestId: 'req_123',
        })

        const summary = formatAgentQueryError(error, {
            provider: 'codex',
            phase: 'query',
            sessionId: '019eb5bc-df44-73a3-8c5c-1c89efcb3d62',
        })

        expect(summary).toContain('Provider: codex')
        expect(summary).toContain('Phase: query')
        expect(summary).toContain('Session: 019eb5bc-df')
        expect(summary).toContain('Error: RequestError: Internal error')
        expect(summary).toContain('code: internal_error')
        expect(summary).toContain('requestId: req_123')
    })
})
