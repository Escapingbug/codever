import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TimeoutMiddleware, createTimeoutMiddleware } from '@/middleware/timeout'
import type { MiddlewareContext } from '@/middleware/types'

function createMiddleware(opts: {
    timeoutSeconds?: number
    heartbeatIntervalMs?: number
    toolRunningNotifyMs?: number
    onTimeout?: (elapsed: number) => void
    onToolRunning?: (toolName: string, elapsedSec: number) => void
    onTyping?: () => void
}) {
    return createTimeoutMiddleware({
        timeoutSeconds: opts.timeoutSeconds ?? 180,
        heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 100,
        toolRunningNotifyMs: opts.toolRunningNotifyMs,
        onTimeout: opts.onTimeout ?? vi.fn(),
        onToolRunning: opts.onToolRunning ?? vi.fn(),
        onTyping: opts.onTyping ?? vi.fn(),
    })
}

const defaultContext: MiddlewareContext = {
    sessionId: 'test',
    queryId: 'q1',
    verboseLevel: 1,
    providerSettings: {},
    timeoutSeconds: 180,
    bus: { emit: vi.fn() },
}

function toolUseEvent(toolName: string) {
    return { kind: 'tool_use' as const, toolName, input: {} }
}

function toolResultEvent(toolName: string) {
    return { kind: 'tool_result' as const, toolName, output: 'ok', isError: false }
}

function textEvent(text: string) {
    return { kind: 'text' as const, text }
}

describe('TimeoutMiddleware', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    describe('single timeout notification', () => {
        it('fires onTimeout once at configured timeoutSeconds (default 180)', () => {
            const onTimeout = vi.fn()
            const middleware = createMiddleware({ timeoutSeconds: 180, onTimeout })

            middleware.start()

            // Advance 180s to trigger timeout
            vi.advanceTimersByTime(180_000)
            expect(onTimeout).toHaveBeenCalledTimes(1)
        })

        it('does not fire onTimeout again after the first notification', () => {
            const onTimeout = vi.fn()
            const middleware = createMiddleware({ timeoutSeconds: 180, onTimeout })

            middleware.start()

            vi.advanceTimersByTime(180_000)
            expect(onTimeout).toHaveBeenCalledTimes(1)

            // Advance way past — should still be only 1 notification
            vi.advanceTimersByTime(600_000)
            vi.advanceTimersByTime(600_000)
            expect(onTimeout).toHaveBeenCalledTimes(1)
        })

        it('fires onTimeout again after agent activity resets the silence period', () => {
            const onTimeout = vi.fn()
            const middleware = createMiddleware({ timeoutSeconds: 180, onTimeout })

            middleware.start()

            // First timeout
            vi.advanceTimersByTime(180_000)
            expect(onTimeout).toHaveBeenCalledTimes(1)

            // Agent sends a tool_use event — resets timeoutNotified
            middleware.process(toolUseEvent('bash'), defaultContext)

            // Agent goes silent again for 180s
            vi.advanceTimersByTime(180_000)
            expect(onTimeout).toHaveBeenCalledTimes(2)
        })

        it('onTimeout reports silence duration (ms since last event)', () => {
            const onTimeout = vi.fn()
            const middleware = createMiddleware({ timeoutSeconds: 180, onTimeout })

            middleware.start()

            // Agent is active for 30s
            vi.advanceTimersByTime(30_000)
            middleware.process(textEvent('thinking...'), defaultContext)

            // Agent goes silent for 180s
            vi.advanceTimersByTime(180_000)

            expect(onTimeout).toHaveBeenCalledTimes(1)
            const reportedElapsed = onTimeout.mock.calls[0][0]
            // Should report ~180s of silence, not ~210s total query time
            expect(reportedElapsed).toBeGreaterThanOrEqual(179_000)
            expect(reportedElapsed).toBeLessThanOrEqual(181_000)
        })

        it('custom timeoutSeconds works', () => {
            const onTimeout = vi.fn()
            const middleware = createMiddleware({ timeoutSeconds: 60, onTimeout })

            middleware.start()

            vi.advanceTimersByTime(60_000)
            expect(onTimeout).toHaveBeenCalledTimes(1)
        })
    })

    describe('getProgress()', () => {
        it('returns null before start()', () => {
            const middleware = createMiddleware({})
            expect(middleware.getProgress()).toBeNull()
        })

        it('returns elapsed time after start()', () => {
            const middleware = createMiddleware({})
            middleware.start()

            vi.advanceTimersByTime(30_000)
            const progress = middleware.getProgress()
            expect(progress).not.toBeNull()
            expect(progress!.elapsedSeconds).toBeGreaterThanOrEqual(29)
            expect(progress!.elapsedSeconds).toBeLessThanOrEqual(31)
        })

        it('returns lastToolName when tool is running', () => {
            const middleware = createMiddleware({})
            middleware.start()

            middleware.process(toolUseEvent('bash'), defaultContext)
            const progress = middleware.getProgress()
            expect(progress).not.toBeNull()
            expect(progress!.lastToolName).toBe('bash')
        })

        it('returns null lastToolName after tool_result', () => {
            const middleware = createMiddleware({})
            middleware.start()

            middleware.process(toolUseEvent('bash'), defaultContext)
            middleware.process(toolResultEvent('bash'), defaultContext)
            const progress = middleware.getProgress()
            expect(progress).not.toBeNull()
            expect(progress!.lastToolName).toBeNull()
        })

        it('returns null after stop()', () => {
            const middleware = createMiddleware({})
            middleware.start()
            vi.advanceTimersByTime(10_000)
            expect(middleware.getProgress()).not.toBeNull()

            middleware.stop()
            expect(middleware.getProgress()).toBeNull()
        })
    })

    describe('setTimeoutExtended()', () => {
        it('resets timeoutNotified so a new timeout can fire', () => {
            const onTimeout = vi.fn()
            const middleware = createMiddleware({ timeoutSeconds: 60, onTimeout })

            middleware.start()

            // Trigger timeout
            vi.advanceTimersByTime(60_000)
            expect(onTimeout).toHaveBeenCalledTimes(1)

            // Without setTimeoutExtended, advancing more time does NOT fire again
            vi.advanceTimersByTime(60_000)
            expect(onTimeout).toHaveBeenCalledTimes(1)

            // Reset via setTimeoutExtended
            middleware.setTimeoutExtended(true)

            // Now a new timeout can fire after another silence period
            vi.advanceTimersByTime(60_000)
            expect(onTimeout).toHaveBeenCalledTimes(2)
        })
    })

    describe('process() side effects', () => {
        it('tool_use resets timeoutNotified', () => {
            const onTimeout = vi.fn()
            const middleware = createMiddleware({ timeoutSeconds: 60, onTimeout })

            middleware.start()

            vi.advanceTimersByTime(60_000)
            expect(onTimeout).toHaveBeenCalledTimes(1)

            middleware.process(toolUseEvent('bash'), defaultContext)

            vi.advanceTimersByTime(60_000)
            expect(onTimeout).toHaveBeenCalledTimes(2)
        })

        it('tool_result clears lastToolName', () => {
            const middleware = createMiddleware({})
            middleware.start()

            middleware.process(toolUseEvent('bash'), defaultContext)
            expect(middleware.lastToolName).toBe('bash')

            middleware.process(toolResultEvent('bash'), defaultContext)
            expect(middleware.lastToolName).toBeNull()
        })

        it('text event resets timeoutNotified', () => {
            const onTimeout = vi.fn()
            const middleware = createMiddleware({ timeoutSeconds: 60, onTimeout })

            middleware.start()

            vi.advanceTimersByTime(60_000)
            expect(onTimeout).toHaveBeenCalledTimes(1)

            middleware.process(textEvent('hello'), defaultContext)

            vi.advanceTimersByTime(60_000)
            expect(onTimeout).toHaveBeenCalledTimes(2)
        })
    })

    describe('lastToolName getter', () => {
        it('returns null when no tool is running', () => {
            const middleware = createMiddleware({})
            middleware.start()
            expect(middleware.lastToolName).toBeNull()
        })

        it('returns current tool name during tool execution', () => {
            const middleware = createMiddleware({})
            middleware.start()
            middleware.process(toolUseEvent('read_file'), defaultContext)
            expect(middleware.lastToolName).toBe('read_file')
        })
    })

    describe('onToolRunning callback', () => {
        it('fires after toolRunningNotifyMs when a tool is running', () => {
            const onToolRunning = vi.fn()
            const middleware = createMiddleware({
                timeoutSeconds: 300,
                heartbeatIntervalMs: 100,
                toolRunningNotifyMs: 30_000,
                onToolRunning,
            })

            middleware.start()
            middleware.process(toolUseEvent('bash'), defaultContext)

            vi.advanceTimersByTime(29_999)
            expect(onToolRunning).not.toHaveBeenCalled()

            vi.advanceTimersByTime(1)
            expect(onToolRunning).toHaveBeenCalledTimes(1)
            expect(onToolRunning).toHaveBeenCalledWith('bash', expect.any(Number))
        })

        it('does not fire twice for the same tool', () => {
            const onToolRunning = vi.fn()
            const middleware = createMiddleware({
                timeoutSeconds: 300,
                heartbeatIntervalMs: 100,
                toolRunningNotifyMs: 30_000,
                onToolRunning,
            })

            middleware.start()
            middleware.process(toolUseEvent('bash'), defaultContext)

            vi.advanceTimersByTime(30_000)
            expect(onToolRunning).toHaveBeenCalledTimes(1)

            vi.advanceTimersByTime(60_000)
            expect(onToolRunning).toHaveBeenCalledTimes(1)
        })
    })

    describe('onTyping callback', () => {
        it('fires on every heartbeat tick', () => {
            const onTyping = vi.fn()
            const middleware = createMiddleware({
                timeoutSeconds: 300,
                heartbeatIntervalMs: 100,
                onTyping,
            })

            middleware.start()

            vi.advanceTimersByTime(100)
            expect(onTyping).toHaveBeenCalledTimes(1)

            vi.advanceTimersByTime(100)
            expect(onTyping).toHaveBeenCalledTimes(2)

            vi.advanceTimersByTime(200)
            expect(onTyping).toHaveBeenCalledTimes(4)
        })
    })
})
