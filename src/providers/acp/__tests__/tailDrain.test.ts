import { describe, expect, it } from 'vitest'
import { AcpProvider } from '@/providers/acp'
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
    agentCapabilities = { agentCapabilities: {} }
    promptCapabilities = {}

    private queue: FakeSessionNotification[] = []
    private waiters: FakeWaiter[] = []

    setPermissionHandler(): void {}
    setExtensionHandler(): void {}
    clearStderrBuffer(): void {}
    getStderrError(): string | null { return null }

    async newSession(): Promise<{ sessionId: string }> {
        return { sessionId: 'session-1' }
    }

    async prompt(): Promise<{ stopReason: string }> {
        setTimeout(() => {
            this.emit({
                sessionId: 'session-1',
                update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: 'final tail' },
                },
            })
        }, 0)
        return { stopReason: 'end_turn' }
    }

    dequeueSessionUpdate(): FakeSessionNotification | undefined {
        return this.queue.shift()
    }

    drainSessionUpdates(): number {
        const count = this.queue.length
        this.queue.length = 0
        return count
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
    it('delivers final session updates that arrive just after prompt resolves', async () => {
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
})
