import { describe, it, expect, vi } from 'vitest'
import { QueryLoop, type QueryLoopInput } from '@/core/queryLoop'
import { DefaultEventBus } from '@/core/eventBus'
import type { AgentProvider, AgentQueryHandle, AgentQueryConfig } from '@/providers/provider'
import type { AgentEvent, AgentResultEvent, AgentSessionInitEvent } from '@/providers/types'
import type { QueryLoopState, QueryLoopEvent } from '@/core/types'

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

function createQueryLoop(provider?: AgentProvider, opts?: Partial<{ model: string; providerName: string; messageDuringQueryPolicy: string }>): QueryLoop {
    const bus = new DefaultEventBus()
    return new QueryLoop({
        cwd: '/tmp/test',
        provider: provider ?? createMockProvider([{ kind: 'result', status: 'success' }]),
        bus,
        model: opts?.model,
        providerName: opts?.providerName ?? 'test',
        messageDuringQueryPolicy: opts?.messageDuringQueryPolicy as any,
    })
}

describe('QueryLoop', () => {
    describe('state machine', () => {
        it('starts in idle state', () => {
            const session = createQueryLoop()
            expect(session.state).toBe('idle')
        })

        it('transitions idle → querying → idle on processInput', async () => {
            const events: QueryLoopEvent[] = []
            const provider = createMockProvider([{ kind: 'result', status: 'success' }])
            const session = createQueryLoop(provider)
            session.bus.on('session.state_changed', (e: QueryLoopEvent) => {
                if (e.type === 'session.state_changed') events.push(e)
            })

            await session.processInput({ text: 'hello' })

            expect(events).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ type: 'session.state_changed', from: 'idle', to: 'querying' }),
                    expect.objectContaining({ type: 'session.state_changed', from: 'querying', to: 'idle' }),
                ])
            )
            expect(session.state).toBe('idle')
        })

        it('emits session.created on construction', () => {
            const bus = new DefaultEventBus()
            const handler = vi.fn()
            bus.on('session.created', handler)

            const session = new QueryLoop({
                cwd: '/tmp/test',
                provider: createMockProvider(),
                bus,
                providerName: 'test',
            })

            expect(handler).toHaveBeenCalledWith({ type: 'session.created', sessionId: session.id })
        })

        it('transitions to dead on destroy', async () => {
            const session = createQueryLoop()
            await session.destroy()
            expect(session.state).toBe('dead')
        })

        it('destroy is no-op if already dead', async () => {
            const session = createQueryLoop()
            await session.destroy()
            await session.destroy()
            expect(session.state).toBe('dead')
        })

        it('ignores input when dead', async () => {
            const provider = createMockProvider()
            const session = createQueryLoop(provider)
            await session.destroy()
            await session.processInput({ text: 'hello' })
            expect(provider.startQuery).not.toHaveBeenCalled()
        })

        it('returns to idle after error query', async () => {
            const provider: AgentProvider = {
                name: 'mock-provider',
                startQuery: vi.fn().mockImplementation(() => ({
                    events: (async function* () {
                        throw new Error('query failed')
                    })(),
                    interrupt: vi.fn().mockResolvedValue(undefined),
                })),
                isReady: vi.fn().mockReturnValue(true),
                getInitError: vi.fn().mockReturnValue(null),
                getAvailableModels: vi.fn().mockReturnValue([]),
                getAvailablePermissionModes: vi.fn().mockReturnValue([]),
            }
            const session = createQueryLoop(provider)
            await session.processInput({ text: 'hello' })
            expect(session.state).toBe('idle')
        })
    })

    describe('interrupt', () => {
        it('interrupt is no-op when idle', async () => {
            const session = createQueryLoop()
            await session.interrupt('stop')
            expect(session.state).toBe('idle')
        })

        it('interrupt calls provider interrupt and returns to idle', async () => {
            const { provider } = createCancellableProvider()
            const session = createQueryLoop(provider)
            const states: QueryLoopState[] = []
            session.bus.on('session.state_changed', (e: QueryLoopEvent) => {
                if (e.type === 'session.state_changed') states.push(e.to)
            })

            const queryPromise = session.processInput({ text: 'hello' })
            await new Promise(r => setTimeout(r, 30))

            expect(session.state).toBe('querying')

            await session.interrupt('stop')
            await queryPromise

            expect(states).toContain('canceling')
            expect(states).toContain('idle')
            expect(session.state).toBe('idle')
        }, 10000)

        it('interrupt with reason=new sets resetRequested', async () => {
            const { provider } = createCancellableProvider()
            const session = createQueryLoop(provider)

            let completedStatus: string | null = null
            session.bus.on('query.completed', (e: QueryLoopEvent) => {
                if (e.type === 'query.completed') {
                    completedStatus = e.result.status
                }
            })

            const queryPromise = session.processInput({ text: 'hello' })
            await new Promise(r => setTimeout(r, 30))

            await session.interrupt('new')
            await queryPromise

            expect(completedStatus).toBe('cancelled')
        }, 10000)

        it('second interrupt during canceling is no-op', async () => {
            const { provider } = createCancellableProvider()
            const session = createQueryLoop(provider)

            const queryPromise = session.processInput({ text: 'hello' })
            await new Promise(r => setTimeout(r, 30))

            const p1 = session.interrupt('stop')
            expect(session.state).toBe('canceling')

            await session.interrupt('new')

            await p1
            await queryPromise
            expect(session.state).toBe('idle')
        }, 10000)
    })

    describe('permissions', () => {
        it('resolvePermission resolves a pending permission', async () => {
            const session = createQueryLoop()
            const promise = session.waitForPermission('req-1', 'ReadFile', { path: '/tmp/test' })
            expect(session.hasPendingPermissions()).toBe(true)

            const handled = session.resolvePermission('req-1', 'allow')
            expect(handled).toBe(true)

            await expect(promise).resolves.toBe('allow')
        })

        it('resolvePermission returns false for unknown requestId', () => {
            const session = createQueryLoop()
            expect(session.resolvePermission('unknown', 'allow')).toBe(false)
        })

        it('rejectAllPendingPermissions on interrupt', async () => {
            const { provider } = createCancellableProvider()
            const session = createQueryLoop(provider)
            const permPromise = session.waitForPermission('req-1', 'WriteFile', {})

            const queryPromise = session.processInput({ text: 'hello' })
            await new Promise(r => setTimeout(r, 30))

            await session.interrupt('stop')
            await queryPromise

            await expect(permPromise).resolves.toBe('cancel')
            expect(session.hasPendingPermissions()).toBe(false)
        }, 10000)
    })

    describe('Provider integration', () => {
        it('calls provider.startQuery with correct options', async () => {
            const provider = createMockProvider([{ kind: 'result', status: 'success' }])
            const session = createQueryLoop(provider)
            session.setModel('gpt-4')
            session.setConversationId('prev-session')

            await session.processInput({ text: 'hello' })

            expect(provider.startQuery).toHaveBeenCalledWith('hello', expect.objectContaining({
                cwd: '/tmp/test',
                sessionId: 'prev-session',
                model: 'gpt-4',
            }))
        })

        it('passes permissionHandler and providerSettings to provider', async () => {
            const provider = createMockProvider([{ kind: 'result', status: 'success' }])
            const session = createQueryLoop(provider)
            const mockHandler = {
                handleToolCall: vi.fn(),
                reset: vi.fn(),
            }
            session.setPermissionHandler(mockHandler)
            session.providerSettings = { permissionMode: 'approve-all' }

            await session.processInput({ text: 'hello' })

            expect(provider.startQuery).toHaveBeenCalledWith('hello', expect.objectContaining({
                permissionHandler: mockHandler,
                providerSettings: { permissionMode: 'approve-all' },
            }))
        })

        it('captures conversationId from session_init events', async () => {
            const provider = createMockProvider([
                { kind: 'session_init', sessionId: 'new-provider-session-123' } as AgentSessionInitEvent,
                { kind: 'text', text: 'hello' },
                { kind: 'result', status: 'success' },
            ])
            const session = createQueryLoop(provider)
            expect(session.conversationId).toBeNull()

            await session.processInput({ text: 'hello' })

            expect(session.conversationId).toBe('new-provider-session-123')
        })

        it('uses captured conversationId in subsequent queries', async () => {
            const firstHandle: AgentQueryHandle = {
                events: (async function* () {
                    yield { kind: 'session_init', sessionId: 'captured-session' } as AgentSessionInitEvent
                    yield { kind: 'result', status: 'success' } as AgentResultEvent
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
                startQuery: vi.fn()
                    .mockReturnValueOnce(firstHandle)
                    .mockReturnValueOnce(secondHandle),
                isReady: vi.fn().mockReturnValue(true),
                getInitError: vi.fn().mockReturnValue(null),
                getAvailableModels: vi.fn().mockReturnValue([]),
                getAvailablePermissionModes: vi.fn().mockReturnValue([]),
            }
            const session = createQueryLoop(provider)

            await session.processInput({ text: 'first' })
            expect(session.conversationId).toBe('captured-session')

            await session.processInput({ text: 'second' })
            expect(provider.startQuery).toHaveBeenCalledTimes(2)
            expect(provider.startQuery).toHaveBeenLastCalledWith('second', expect.objectContaining({
                sessionId: 'captured-session',
            }))
        })

        it('retries on retryable error in result event', async () => {
            const firstHandle: AgentQueryHandle = {
                events: (async function* () {
                    yield { kind: 'session_init', sessionId: 'stale-session' } as AgentSessionInitEvent
                    yield { kind: 'result', status: 'error', summary: 'No conversation found' } as AgentResultEvent
                })(),
                interrupt: vi.fn().mockResolvedValue(undefined),
            }
            const secondHandle: AgentQueryHandle = {
                events: (async function* () {
                    yield { kind: 'session_init', sessionId: 'fresh-session' } as AgentSessionInitEvent
                    yield { kind: 'result', status: 'success' } as AgentResultEvent
                })(),
                interrupt: vi.fn().mockResolvedValue(undefined),
            }
            const provider: AgentProvider = {
                name: 'mock-provider',
                startQuery: vi.fn()
                    .mockReturnValueOnce(firstHandle)
                    .mockReturnValueOnce(secondHandle),
                isReady: vi.fn().mockReturnValue(true),
                getInitError: vi.fn().mockReturnValue(null),
                getAvailableModels: vi.fn().mockReturnValue([]),
                getAvailablePermissionModes: vi.fn().mockReturnValue([]),
            }
            const session = createQueryLoop(provider)
            session.setConversationId('stale-session')

            await session.processInput({ text: 'hello' })

            expect(provider.startQuery).toHaveBeenCalledTimes(2)
            expect(provider.startQuery).toHaveBeenNthCalledWith(1, 'hello', expect.objectContaining({
                sessionId: 'stale-session',
            }))
            expect(provider.startQuery).toHaveBeenNthCalledWith(2, 'hello', expect.objectContaining({
                sessionId: undefined,
            }))
            expect(session.conversationId).toBe('fresh-session')
        })

        it('does not retry on non-retryable errors', async () => {
            const provider = createMockProvider([
                { kind: 'result', status: 'error', summary: 'Invalid API key' } as AgentResultEvent,
            ])
            const session = createQueryLoop(provider)

            await session.processInput({ text: 'hello' })

            expect(provider.startQuery).toHaveBeenCalledTimes(1)
        })
    })
})
