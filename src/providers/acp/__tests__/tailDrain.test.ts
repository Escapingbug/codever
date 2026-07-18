import { describe, expect, it } from 'vitest'
import { AcpProvider, formatAgentQueryError } from '@/providers/acp'
import { AcpClientManager } from '@/providers/acp/AcpClientManager'
import type { AgentEvent } from '@/providers/types'

interface FakeSessionNotification {
    sessionId: string
    update: any
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
    promptCompletesOnlyFromIdle = false
    completeActivePromptCalls = 0
    private completePrompt?: (value: { stopReason: string }) => void

    private queue: FakeSessionNotification[] = []
    private waiters: FakeWaiter[] = []
    private sessionUpdateProcessing: Promise<void> = Promise.resolve()

    setPermissionHandler(): void {}
    setExtensionHandler(): void {}
    clearStderrBuffer(): void {}
    getStderrError(): string | null { return null }

    async newSession(): Promise<{ sessionId: string }> {
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
        if (this.promptCompletesOnlyFromIdle) {
            setTimeout(() => {
                this.emit({ sessionId: 'session-1', update: {
                    sessionUpdate: 'session_info_update',
                    _meta: { codex: { threadStatus: { type: 'active' } } },
                } })
                this.emit({ sessionId: 'session-1', update: {
                    sessionUpdate: 'session_info_update',
                    _meta: { codex: { threadStatus: { type: 'idle' } } },
                } })
            }, 10)
            return new Promise(resolve => { this.completePrompt = resolve })
        }
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

    completeActivePrompt(_sessionId: string, response: { stopReason: string }): boolean {
        this.completeActivePromptCalls += 1
        this.completePrompt?.(response)
        return Boolean(this.completePrompt)
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

    it('finishes a Codex turn when threadStatus becomes idle even if prompt never returns', async () => {
        const provider = new AcpProvider({ name: 'codex', command: 'fake', args: [] })
        const clientManager = new FakeAcpClientManager()
        clientManager.promptCompletesOnlyFromIdle = true
        ;(provider as any).clientManager = clientManager
        ;(provider as any).initialized = true

        const handle = provider.startQuery('adjust requirement', {
            cwd: '/repo',
            signal: new AbortController().signal,
        })
        const events: AgentEvent[] = []
        for await (const event of handle.events) events.push(event)

        expect(clientManager.completeActivePromptCalls).toBe(1)
        expect(events.at(-1)).toMatchObject({ kind: 'result', status: 'success' })
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

describe('AcpClientManager prompt completion', () => {
    it('allows an authoritative idle notification to settle a stuck prompt RPC', async () => {
        const manager = new AcpClientManager({ command: 'fake', args: [] })
        ;(manager as any)._connected = true
        ;(manager as any).connection = { prompt: () => new Promise(() => undefined) }

        const prompt = manager.prompt({ sessionId: 'session-1', prompt: [] })
        await Promise.resolve()
        expect(manager.completeActivePrompt('session-1', { stopReason: 'end_turn' })).toBe(true)

        await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' })
    })
})
