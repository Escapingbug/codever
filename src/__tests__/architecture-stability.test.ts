/**
 * Architecture Stability Tests
 *
 * These tests verify that the stability issues identified in the P0-P3
 * architecture assessment have been resolved. Each describe block targets
 * a specific issue. When ALL tests pass, the architecture is stable enough
 * to build P4 (SupervisorNode) on top of.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { QueryLoop, type QueryLoopInput } from '@/core/queryLoop'
import { DefaultEventBus } from '@/core/eventBus'
import type { AgentProvider, AgentQueryHandle, AgentQueryConfig } from '@/providers/provider'
import type { AgentEvent, AgentResultEvent, AgentSessionInitEvent } from '@/providers/types'
import type { QueryLoopState, QueryLoopEvent } from '@/core/types'

import { createFormattingMiddleware } from '@/middleware/formatting'

import { createMiddlewarePipeline } from '@/middleware/pipeline'
import type { MiddlewareContext } from '@/middleware/types'

import { SessionManager, makeTopicKey } from '@/bridge/sessionManager'

function createContext(overrides?: Partial<MiddlewareContext>): MiddlewareContext {
    return {
        sessionId: 'test-session',
        queryId: 'test-query',
        verboseLevel: 1,
        providerSettings: {},
        timeoutSeconds: 60,
        bus: { emit: vi.fn(), on: vi.fn(), once: vi.fn(), removeAllListeners: vi.fn() },
        ...overrides,
    }
}

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

function createCancellableProvider(): { provider: AgentProvider } {
    const provider: AgentProvider = {
        name: 'mock-provider',
        startQuery: vi.fn().mockImplementation(() => {
            let cancelled = false
            const handle: AgentQueryHandle = {
                events: (async function* () {
                    yield { kind: 'text', text: 'working...' } as AgentEvent
                    while (!cancelled) {
                        await new Promise(r => setTimeout(r, 10))
                    }
                    yield { kind: 'result', status: 'error' } as AgentResultEvent
                })(),
                interrupt: vi.fn().mockImplementation(async () => {
                    cancelled = true
                }),
            }
            return handle
        }),
        isReady: vi.fn().mockReturnValue(true),
        getInitError: vi.fn().mockReturnValue(null),
        getAvailableModels: vi.fn().mockReturnValue([]),
        getAvailablePermissionModes: vi.fn().mockReturnValue([]),
    }
    return { provider }
}

function createQueryLoop(provider?: AgentProvider, opts?: Partial<{
    model: string
    providerName: string
    messageDuringQueryPolicy: string
    timeoutSeconds: number
}>): QueryLoop {
    const bus = new DefaultEventBus()
    return new QueryLoop({
        cwd: '/tmp/test',
        provider: provider ?? createMockProvider([{ kind: 'result', status: 'success' }]),
        bus,
        model: opts?.model,
        providerName: opts?.providerName ?? 'test',
        messageDuringQueryPolicy: opts?.messageDuringQueryPolicy as any,
        timeoutSeconds: opts?.timeoutSeconds,
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Pipeline flush must not lose data
// ═══════════════════════════════════════════════════════════════════════════

describe('Pipeline: flush must not lose data', () => {
    it('text is delivered via flushSync or non-text event', () => {
        const pipeline = createMiddlewarePipeline({
            formatting: createFormattingMiddleware(),
        })

        const longText = 'x'.repeat(600)
        pipeline.processEvent({ kind: 'text', text: longText }, createContext())

        // In the new pipeline, text is buffered until a non-text event or explicit flush
        const flushResult = pipeline.flushSync('final')
        expect(flushResult).not.toBeNull()
        expect(flushResult!.text).toContain('x'.repeat(600))
    })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. FormattingMiddleware double-apply
// ═══════════════════════════════════════════════════════════════════════════

describe('Pipeline: formatting.process() must be called exactly once per event', () => {
    it('tool_use event: formatting.process() called once, not twice', () => {
        const formatting = createFormattingMiddleware()
        const processSpy = vi.spyOn(formatting, 'process')

        const pipeline = createMiddlewarePipeline({
            formatting,
        })

        pipeline.processEvent(
            { kind: 'tool_use', toolName: 'Bash', input: { command: 'ls' } },
            createContext()
        )

        expect(processSpy).toHaveBeenCalledTimes(1)
    })

    it('text event: formatting.process() called once, not twice', () => {
        const formatting = createFormattingMiddleware()
        const processSpy = vi.spyOn(formatting, 'process')

        const pipeline = createMiddlewarePipeline({
            formatting,
        })

        pipeline.processEvent({ kind: 'text', text: 'hello' }, createContext())

        expect(processSpy).toHaveBeenCalledTimes(1)
    })

    it('result event: formatting.process() called once, not twice', () => {
        const formatting = createFormattingMiddleware()
        const processSpy = vi.spyOn(formatting, 'process')

        const pipeline = createMiddlewarePipeline({
            formatting,
        })

        pipeline.processEvent({ kind: 'result', status: 'success' }, createContext())

        expect(processSpy).toHaveBeenCalledTimes(1)
    })

    it('external process + pipeline should not corrupt ConversationModel', () => {
        const formatting = createFormattingMiddleware()

        const pipeline = createMiddlewarePipeline({
            formatting,
        })

        const agentEvent = { kind: 'tool_use' as const, toolName: 'Bash', input: { command: 'ls' } }
        formatting.process(agentEvent, createContext())

        const event = { kind: 'tool_use' as const, toolName: 'Bash', input: { command: 'ls' } }
        pipeline.processEvent(event, createContext())

        const toolNames = Array.from(formatting.toolNameMap.values())
        expect(toolNames.filter(n => n === 'Bash').length).toBeLessThanOrEqual(1)
    })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. SessionManager unified lookup
// ═══════════════════════════════════════════════════════════════════════════

describe('SessionManager: unified session visibility', () => {
    let sm: SessionManager

    beforeEach(() => {
        sm = new SessionManager()
        vi.spyOn(sm, 'loadPersistedState').mockImplementation(() => {})
    })

    it('QueryLoops are discoverable (listActiveSessionIds or equivalent)', () => {
        const bus = new DefaultEventBus()
        const queryLoop = new QueryLoop({
            cwd: '/tmp/test',
            provider: createMockProvider(),
            bus,
            providerName: 'test',
        })
        queryLoop.groupChatId = -100123
        queryLoop.messageThreadId = 42

        sm.registerSession(queryLoop, -100123, 42)

        const coreIds = sm.listActiveSessions().map(s => s.id)
        expect(coreIds).toContain(queryLoop.id)
    })

    it('getSessionByGroup finds QueryLoop for a group', () => {
        const bus = new DefaultEventBus()
        const queryLoop = new QueryLoop({
            cwd: '/tmp/test',
            provider: createMockProvider(),
            bus,
            providerName: 'test',
        })
        queryLoop.groupChatId = -100456
        sm.registerSession(queryLoop, -100456)

        const found = sm.getSessionByGroup(-100456)
        expect(found).toBeDefined()
        expect(found!.id).toBe(queryLoop.id)
    })

    it('removeSession cleans up both id and group maps', () => {
        const bus = new DefaultEventBus()
        const queryLoop = new QueryLoop({
            cwd: '/tmp/test',
            provider: createMockProvider(),
            bus,
            providerName: 'test',
        })
        queryLoop.groupChatId = -100789
        queryLoop.messageThreadId = 10
        sm.registerSession(queryLoop, -100789, 10)

        sm.removeSession(queryLoop.id)

        expect(sm.getSession(queryLoop.id)).toBeUndefined()
        expect(sm.getSessionByGroup(-100789, 10)).toBeUndefined()
    })

    it('registerPermission and getSessionForPermission work', () => {
        const bus = new DefaultEventBus()
        const queryLoop = new QueryLoop({
            cwd: '/tmp/test',
            provider: createMockProvider(),
            bus,
            providerName: 'test',
        })

        sm.registerPermission('perm-123', queryLoop)
        const found = sm.getSessionForPermission('perm-123')
        expect(found).toBeDefined()
        expect(found!.id).toBe(queryLoop.id)
    })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. QueryLoop retry logic
// ═══════════════════════════════════════════════════════════════════════════

describe('QueryLoop: retry logic', () => {
    it('retries on "No conversation found" error in result event', async () => {
        const firstHandle: AgentQueryHandle = {
            events: (async function* () {
                yield { kind: 'result', status: 'error', summary: 'No conversation found' } as AgentResultEvent
            })(),
            interrupt: vi.fn().mockResolvedValue(undefined),
        }
        const secondHandle: AgentQueryHandle = {
            events: (async function* () {
                yield { kind: 'result', status: 'success' } as AgentResultEvent
            })(),
            interrupt: vi.fn().mockResolvedValue(undefined),
        }
        const provider: AgentProvider = {
            name: 'mock-provider',
            startQuery: vi.fn().mockReturnValueOnce(firstHandle).mockReturnValueOnce(secondHandle),
            isReady: vi.fn().mockReturnValue(true),
            getInitError: vi.fn().mockReturnValue(null),
            getAvailableModels: vi.fn().mockReturnValue([]),
            getAvailablePermissionModes: vi.fn().mockReturnValue([]),
        }
        const session = createQueryLoop(provider)

        await session.processInput({ text: 'hello' })

        expect(provider.startQuery).toHaveBeenCalledTimes(2)
        expect(session.state).toBe('idle')
    })

    it('retries on ECONNRESET exception', async () => {
        let callCount = 0
        const provider: AgentProvider = {
            name: 'mock-provider',
            startQuery: vi.fn().mockImplementation(() => {
                callCount++
                if (callCount === 1) throw new Error('ECONNRESET')
                return {
                    events: (async function* () {
                        yield { kind: 'result', status: 'success' } as AgentResultEvent
                    })(),
                    interrupt: vi.fn().mockResolvedValue(undefined),
                }
            }),
            isReady: vi.fn().mockReturnValue(true),
            getInitError: vi.fn().mockReturnValue(null),
            getAvailableModels: vi.fn().mockReturnValue([]),
            getAvailablePermissionModes: vi.fn().mockReturnValue([]),
        }
        const session = createQueryLoop(provider)

        await session.processInput({ text: 'hello' })

        expect(provider.startQuery).toHaveBeenCalledTimes(2)
        expect(session.state).toBe('idle')
    })

    it('retries on "fetch failed" exception', async () => {
        let callCount = 0
        const provider: AgentProvider = {
            name: 'mock-provider',
            startQuery: vi.fn().mockImplementation(() => {
                callCount++
                if (callCount === 1) throw new Error('fetch failed')
                return {
                    events: (async function* () {
                        yield { kind: 'result', status: 'success' } as AgentResultEvent
                    })(),
                    interrupt: vi.fn().mockResolvedValue(undefined),
                }
            }),
            isReady: vi.fn().mockReturnValue(true),
            getInitError: vi.fn().mockReturnValue(null),
            getAvailableModels: vi.fn().mockReturnValue([]),
            getAvailablePermissionModes: vi.fn().mockReturnValue([]),
        }
        const session = createQueryLoop(provider)

        await session.processInput({ text: 'hello' })

        expect(provider.startQuery).toHaveBeenCalledTimes(2)
    })

    it('retries on "already in use" result event', async () => {
        const firstHandle: AgentQueryHandle = {
            events: (async function* () {
                yield { kind: 'result', status: 'error', summary: 'Session already in use' } as AgentResultEvent
            })(),
            interrupt: vi.fn().mockResolvedValue(undefined),
        }
        const secondHandle: AgentQueryHandle = {
            events: (async function* () {
                yield { kind: 'result', status: 'success' } as AgentResultEvent
            })(),
            interrupt: vi.fn().mockResolvedValue(undefined),
        }
        const provider: AgentProvider = {
            name: 'mock-provider',
            startQuery: vi.fn().mockReturnValueOnce(firstHandle).mockReturnValueOnce(secondHandle),
            isReady: vi.fn().mockReturnValue(true),
            getInitError: vi.fn().mockReturnValue(null),
            getAvailableModels: vi.fn().mockReturnValue([]),
            getAvailablePermissionModes: vi.fn().mockReturnValue([]),
        }
        const session = createQueryLoop(provider)

        await session.processInput({ text: 'hello' })

        expect(provider.startQuery).toHaveBeenCalledTimes(2)
    })

    it('clears conversationId on retry', async () => {
        const firstHandle: AgentQueryHandle = {
            events: (async function* () {
                yield { kind: 'result', status: 'error', summary: 'No conversation found' } as AgentResultEvent
            })(),
            interrupt: vi.fn().mockResolvedValue(undefined),
        }
        const secondHandle: AgentQueryHandle = {
            events: (async function* () {
                yield { kind: 'result', status: 'success' } as AgentResultEvent
            })(),
            interrupt: vi.fn().mockResolvedValue(undefined),
        }
        const provider: AgentProvider = {
            name: 'mock-provider',
            startQuery: vi.fn().mockReturnValueOnce(firstHandle).mockReturnValueOnce(secondHandle),
            isReady: vi.fn().mockReturnValue(true),
            getInitError: vi.fn().mockReturnValue(null),
            getAvailableModels: vi.fn().mockReturnValue([]),
            getAvailablePermissionModes: vi.fn().mockReturnValue([]),
        }
        const session = createQueryLoop(provider)
        session.setConversationId('stale-session')

        await session.processInput({ text: 'hello' })

        expect(provider.startQuery).toHaveBeenNthCalledWith(2, 'hello', expect.objectContaining({
            sessionId: undefined,
        }))
    })

    it('exhausts retries and emits query.error after MAX_RETRIES+1 attempts', async () => {
        const makeFailHandle = (): AgentQueryHandle => ({
            events: (async function* () {
                yield { kind: 'result', status: 'error', summary: 'No conversation found' } as AgentResultEvent
            })(),
            interrupt: vi.fn().mockResolvedValue(undefined),
        })

        const provider: AgentProvider = {
            name: 'mock-provider',
            startQuery: vi.fn()
                .mockReturnValueOnce(makeFailHandle())
                .mockReturnValueOnce(makeFailHandle())
                .mockReturnValueOnce(makeFailHandle())
                .mockReturnValueOnce(makeFailHandle()),
            isReady: vi.fn().mockReturnValue(true),
            getInitError: vi.fn().mockReturnValue(null),
            getAvailableModels: vi.fn().mockReturnValue([]),
            getAvailablePermissionModes: vi.fn().mockReturnValue([]),
        }
        const session = createQueryLoop(provider)
        const errorHandler = vi.fn()
        const completedHandler = vi.fn()
        session.bus.on('query.error', errorHandler)
        session.bus.on('query.completed', completedHandler)

        await session.processInput({ text: 'hello' })

        expect(provider.startQuery).toHaveBeenCalledTimes(4)
        expect(session.state).toBe('idle')
        expect(errorHandler).toHaveBeenCalled()
    })

    it('exhausts retries on exceptions and emits query.error', async () => {
        const provider: AgentProvider = {
            name: 'mock-provider',
            startQuery: vi.fn().mockImplementation(() => {
                throw new Error('ECONNREFUSED')
            }),
            isReady: vi.fn().mockReturnValue(true),
            getInitError: vi.fn().mockReturnValue(null),
            getAvailableModels: vi.fn().mockReturnValue([]),
            getAvailablePermissionModes: vi.fn().mockReturnValue([]),
        }
        const session = createQueryLoop(provider)
        const errorHandler = vi.fn()
        session.bus.on('query.error', errorHandler)

        await session.processInput({ text: 'hello' })

        expect(provider.startQuery).toHaveBeenCalledTimes(4)
        expect(session.state).toBe('idle')
        expect(errorHandler).toHaveBeenCalled()
    })

    it('does not retry on non-retryable error', async () => {
        const provider = createMockProvider([
            { kind: 'result', status: 'error', summary: 'Invalid API key' } as AgentResultEvent,
        ])
        const session = createQueryLoop(provider)

        await session.processInput({ text: 'hello' })

        expect(provider.startQuery).toHaveBeenCalledTimes(1)
    })

    it('does not retry on non-retryable exception', async () => {
        const provider: AgentProvider = {
            name: 'mock-provider',
            startQuery: vi.fn().mockImplementation(() => {
                throw new Error('Invalid API key')
            }),
            isReady: vi.fn().mockReturnValue(true),
            getInitError: vi.fn().mockReturnValue(null),
            getAvailableModels: vi.fn().mockReturnValue([]),
            getAvailablePermissionModes: vi.fn().mockReturnValue([]),
        }
        const session = createQueryLoop(provider)
        const errorHandler = vi.fn()
        session.bus.on('query.error', errorHandler)

        await session.processInput({ text: 'hello' })

        expect(provider.startQuery).toHaveBeenCalledTimes(1)
        expect(errorHandler).toHaveBeenCalled()
        expect(session.state).toBe('idle')
    })

    it('retries on NetworkError (case-insensitive match)', async () => {
        let callCount = 0
        const provider: AgentProvider = {
            name: 'mock-provider',
            startQuery: vi.fn().mockImplementation(() => {
                callCount++
                if (callCount === 1) throw new Error('NetworkError: Failed to fetch')
                return {
                    events: (async function* () {
                        yield { kind: 'result', status: 'success' } as AgentResultEvent
                    })(),
                    interrupt: vi.fn().mockResolvedValue(undefined),
                }
            }),
            isReady: vi.fn().mockReturnValue(true),
            getInitError: vi.fn().mockReturnValue(null),
            getAvailableModels: vi.fn().mockReturnValue([]),
            getAvailablePermissionModes: vi.fn().mockReturnValue([]),
        }
        const session = createQueryLoop(provider)

        await session.processInput({ text: 'hello' })

        expect(provider.startQuery).toHaveBeenCalledTimes(2)
    })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. QueryLoop pending config during query
// ═══════════════════════════════════════════════════════════════════════════

describe('QueryLoop: pending config during query', () => {
    it('queues model change during query and applies on next query', async () => {
        const { provider } = createCancellableProvider()
        const session = createQueryLoop(provider)

        const queryPromise = session.processInput({ text: 'first' })
        await new Promise(r => setTimeout(r, 30))
        expect(session.state).toBe('querying')

        session.setModel('gpt-4-turbo')
        expect(session.model).not.toBe('gpt-4-turbo')

        await session.interrupt('stop')
        await queryPromise

        const secondQueryPromise = session.processInput({ text: 'second' })
        await new Promise(r => setTimeout(r, 30))

        expect(session.model).toBe('gpt-4-turbo')

        await session.interrupt('stop')
        await secondQueryPromise
    }, 10000)

    it('queues verboseLevel change during query', async () => {
        const { provider } = createCancellableProvider()
        const session = createQueryLoop(provider)

        const queryPromise = session.processInput({ text: 'first' })
        await new Promise(r => setTimeout(r, 30))

        session.setVerboseLevel(0)
        expect(session.verboseLevel).not.toBe(0)

        await session.interrupt('stop')
        await queryPromise

        const secondQueryPromise = session.processInput({ text: 'second' })
        await new Promise(r => setTimeout(r, 30))

        expect(session.verboseLevel).toBe(0)

        await session.interrupt('stop')
        await secondQueryPromise
    }, 10000)

    it('queues timeoutSeconds change during query', async () => {
        const { provider } = createCancellableProvider()
        const session = createQueryLoop(provider)

        const queryPromise = session.processInput({ text: 'first' })
        await new Promise(r => setTimeout(r, 30))

        session.setTimeoutSeconds(300)
        expect(session.timeoutSeconds).not.toBe(300)

        await session.interrupt('stop')
        await queryPromise

        const secondQueryPromise = session.processInput({ text: 'second' })
        await new Promise(r => setTimeout(r, 30))

        expect(session.timeoutSeconds).toBe(300)

        await session.interrupt('stop')
        await secondQueryPromise
    }, 10000)
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. QueryLoop message queue policy
// ═══════════════════════════════════════════════════════════════════════════

describe('QueryLoop: message queue policy', () => {
    it('queue policy: messages are queued silently during query', async () => {
        let queryCount = 0
        const provider: AgentProvider = {
            name: 'mock-provider',
            startQuery: vi.fn().mockImplementation((_prompt: string) => {
                queryCount++
                return {
                    events: (async function* () {
                        yield { kind: 'text', text: `response-${queryCount}` } as AgentEvent
                        yield { kind: 'result', status: 'success' } as AgentResultEvent
                    })(),
                    interrupt: vi.fn().mockResolvedValue(undefined),
                }
            }),
            isReady: vi.fn().mockReturnValue(true),
            getInitError: vi.fn().mockReturnValue(null),
            getAvailableModels: vi.fn().mockReturnValue([]),
            getAvailablePermissionModes: vi.fn().mockReturnValue([]),
        }

        const session = createQueryLoop(provider, { messageDuringQueryPolicy: 'queue' })

        await session.processInput({ text: 'first' })

        expect(session.state).toBe('idle')
        expect(provider.startQuery).toHaveBeenCalledWith('first', expect.anything())
    })

    it('interrupt policy: new message during query triggers cancel and new query', async () => {
        let callCount = 0
        const provider: AgentProvider = {
            name: 'mock-provider',
            startQuery: vi.fn().mockImplementation((_prompt: string) => {
                callCount++
                if (callCount === 1) {
                    let cancelled = false
                    return {
                        events: (async function* () {
                            yield { kind: 'text', text: 'working...' } as AgentEvent
                            while (!cancelled) await new Promise(r => setTimeout(r, 5))
                            yield { kind: 'result', status: 'error' } as AgentResultEvent
                        })(),
                        interrupt: vi.fn().mockImplementation(async () => { cancelled = true }),
                    }
                }
                return {
                    events: (async function* () {
                        yield { kind: 'text', text: `done: ${_prompt}` } as AgentEvent
                        yield { kind: 'result', status: 'success' } as AgentResultEvent
                    })(),
                    interrupt: vi.fn().mockResolvedValue(undefined),
                }
            }),
            isReady: vi.fn().mockReturnValue(true),
            getInitError: vi.fn().mockReturnValue(null),
            getAvailableModels: vi.fn().mockReturnValue([]),
            getAvailablePermissionModes: vi.fn().mockReturnValue([]),
        }

        const session = createQueryLoop(provider, { messageDuringQueryPolicy: 'interrupt' })

        const queryPromise = session.processInput({ text: 'first' })
        await new Promise(r => setTimeout(r, 30))
        expect(session.state).toBe('querying')

        session.processInput({ text: 'second' })

        await queryPromise
        await new Promise(r => setTimeout(r, 50))

        expect(provider.startQuery).toHaveBeenCalledTimes(2)
        expect(provider.startQuery).toHaveBeenLastCalledWith('second', expect.anything())
        expect(session.state).toBe('idle')
    }, 10000)
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. QueryLoop destroy during active query
// ═══════════════════════════════════════════════════════════════════════════

describe('QueryLoop: destroy during active query', () => {
    it('destroy during querying transitions to dead', async () => {
        const { provider } = createCancellableProvider()
        const session = createQueryLoop(provider)

        const queryPromise = session.processInput({ text: 'hello' })
        await new Promise(r => setTimeout(r, 30))
        expect(session.state).toBe('querying')

        await session.destroy()

        expect(session.state).toBe('dead')

        await queryPromise
    }, 10000)

    it('destroy rejects pending permissions', async () => {
        const { provider } = createCancellableProvider()
        const session = createQueryLoop(provider)

        const permPromise = session.waitForPermission('req-1', 'WriteFile', {})

        const queryPromise = session.processInput({ text: 'hello' })
        await new Promise(r => setTimeout(r, 30))

        await session.destroy()
        await queryPromise

        await expect(permPromise).resolves.toBe('cancel')
    }, 10000)

    it('processInput is no-op after destroy', async () => {
        const provider = createMockProvider([{ kind: 'result', status: 'success' }])
        const session = createQueryLoop(provider)

        await session.destroy()
        await session.processInput({ text: 'hello' })

        expect(provider.startQuery).not.toHaveBeenCalled()
    })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. EventBus async handler safety
// ═══════════════════════════════════════════════════════════════════════════

describe('EventBus: async handler error safety', () => {
    it('async handler errors should not cause unhandled rejections', async () => {
        const bus = new DefaultEventBus()
        const errors: any[] = []

        const handler = (reason: any) => errors.push(reason)
        process.on('unhandledRejection', handler)

        bus.on('query.started', async () => {
            throw new Error('async handler error')
        })

        bus.emit({ type: 'query.started', sessionId: 'test', queryId: 'q1' } as QueryLoopEvent)

        await new Promise(r => setTimeout(r, 100))

        process.removeListener('unhandledRejection', handler)

        expect(errors.length).toBe(0)
    })
})
