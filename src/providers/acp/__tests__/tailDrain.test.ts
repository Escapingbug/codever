import { describe, expect, it } from 'vitest'
import { AcpProvider, formatAgentQueryError } from '@/providers/acp'
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
    supportsListSessions = false
    agentCapabilities = { agentCapabilities: { loadSession: false } }
    promptCapabilities = {}
    promptText = 'final tail'
    loadSessionHistoryText: string | null = null
    newSessionResponse: Record<string, unknown> = { sessionId: 'session-1' }
    setSessionModelCalls: Array<Record<string, unknown>> = []
    setSessionConfigOptionCalls: Array<Record<string, unknown>> = []

    private queue: FakeSessionNotification[] = []
    private waiters: FakeWaiter[] = []
    private sessionUpdateProcessing: Promise<void> = Promise.resolve()

    setPermissionHandler(): void {}
    setExtensionHandler(): void {}
    clearStderrBuffer(): void {}
    getStderrError(): string | null { return null }

    async newSession(): Promise<any> {
        return this.newSessionResponse
    }

    async setSessionModel(params: Record<string, unknown>): Promise<Record<string, never>> {
        this.setSessionModelCalls.push(params)
        return {}
    }

    async setSessionConfigOption(params: Record<string, unknown>): Promise<Record<string, never>> {
        this.setSessionConfigOptionCalls.push(params)
        return {}
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

    it('closes an unresponsive ACP connection after cancel instead of retaining ghost updates', async () => {
        class HangingCancelClientManager extends FakeAcpClientManager {
            closeCalls = 0

            async prompt(): Promise<{ stopReason: string }> {
                return new Promise(() => {})
            }

            async cancelActivePrompt(): Promise<undefined> {
                return undefined
            }

            async close(): Promise<void> {
                this.closeCalls += 1
                this.connected = false
            }
        }

        const provider = new AcpProvider({ name: 'test-acp', command: 'fake', args: [] })
        const clientManager = new HangingCancelClientManager()
        ;(provider as any).clientManager = clientManager
        ;(provider as any).initialized = true

        const handle = provider.startQuery('hi', {
            cwd: '/repo',
            signal: new AbortController().signal,
        })
        const iterator = handle.events[Symbol.asyncIterator]()
        await expect(iterator.next()).resolves.toMatchObject({
            done: false,
            value: { kind: 'session_init', sessionId: 'session-1' },
        })

        await handle.interrupt()

        expect(clientManager.closeCalls).toBe(1)
        expect(provider.isReady()).toBe(false)
        expect(provider.wasReady()).toBe(true)
        await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    })

    it('uses advertised ACP model and reasoning controls instead of slash commands', async () => {
        const provider = new AcpProvider({ name: 'test-acp', command: 'fake', args: [] })
        const clientManager = new FakeAcpClientManager()
        clientManager.newSessionResponse = {
            sessionId: 'session-1',
            models: {
                currentModelId: 'model-a',
                availableModels: [
                    { modelId: 'model-a', name: 'Model A' },
                    { modelId: 'model-b', name: 'Model B' },
                ],
            },
            configOptions: [{
                type: 'select',
                id: 'reasoning_effort',
                name: 'Reasoning effort',
                category: 'thought_level',
                currentValue: 'medium',
                options: [
                    { value: 'medium', name: 'Medium' },
                    { value: 'high', name: 'High' },
                ],
            }],
        }
        ;(provider as any).clientManager = clientManager
        ;(provider as any).initialized = true

        const handle = provider.startQuery('hi', {
            cwd: '/repo',
            model: 'model-b',
            providerSettings: { reasoningEffort: 'high' },
            signal: new AbortController().signal,
        })
        for await (const _event of handle.events) {
            // Consume the query so configuration and the prompt both finish.
        }

        expect(clientManager.setSessionModelCalls).toEqual([
            { sessionId: 'session-1', modelId: 'model-b' },
        ])
        expect(clientManager.setSessionConfigOptionCalls).toEqual([
            { sessionId: 'session-1', configId: 'reasoning_effort', value: 'high' },
        ])
    })

    it('lists and inspects provider-owned ACP sessions without adopting them', async () => {
        const provider = new AcpProvider({ name: 'test-acp', command: 'fake', args: [] })
        const requests: Array<Record<string, unknown>> = []
        const clientManager = {
            connected: true,
            supportsListSessions: true,
            agentCapabilities: { agentCapabilities: { loadSession: true } },
            async listSessions(request: Record<string, unknown>) {
                requests.push(request)
                if (!request.cursor) {
                    return {
                        sessions: [{
                            sessionId: 'older',
                            cwd: '/repo',
                            title: 'Older',
                            updatedAt: '2026-01-01T00:00:00.000Z',
                        }],
                        nextCursor: 'next-page',
                    }
                }
                return {
                    sessions: [{
                        sessionId: 'newer',
                        cwd: '/repo',
                        title: 'Newer',
                        updatedAt: '2026-02-01T00:00:00.000Z',
                    }],
                }
            },
            async loadSession() {
                return {}
            },
            async collectSessionUpdatesUntilIdle() {
                return [
                    {
                        sessionId: 'newer',
                        update: {
                            sessionUpdate: 'user_message_chunk',
                            messageId: 'user-1',
                            content: { type: 'text', text: 'Continue ' },
                        },
                    },
                    {
                        sessionId: 'newer',
                        update: {
                            sessionUpdate: 'user_message_chunk',
                            messageId: 'user-1',
                            content: { type: 'text', text: 'this' },
                        },
                    },
                    {
                        sessionId: 'newer',
                        update: {
                            sessionUpdate: 'agent_message_chunk',
                            messageId: 'agent-1',
                            content: { type: 'text', text: 'Ready' },
                        },
                    },
                ]
            },
        }
        ;(provider as any).clientManager = clientManager
        ;(provider as any).initialized = true

        await expect(provider.listSessions('/repo')).resolves.toMatchObject([
            { sessionId: 'newer', title: 'Newer', cwd: '/repo' },
            { sessionId: 'older', title: 'Older', cwd: '/repo' },
        ])
        await expect(provider.getSessionHistory('newer', '/repo')).resolves.toEqual({
            sessionId: 'newer',
            title: 'Newer',
            messages: [
                { id: 'user-1', role: 'user', text: 'Continue this' },
                { id: 'agent-1', role: 'assistant', text: 'Ready' },
            ],
        })
        expect(requests).toEqual([
            { cwd: '/repo' },
            { cwd: '/repo', cursor: 'next-page' },
            { cwd: '/repo' },
            { cwd: '/repo', cursor: 'next-page' },
        ])
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
