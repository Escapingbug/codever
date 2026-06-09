import { describe, expect, it, vi } from 'vitest'
import { runWatchdogOnce, runWatchdogLoop, type WatchdogState } from '@/daemon/watchdog'

describe('daemon watchdog', () => {
    it('starts daemon when pid check reports stopped', async () => {
        const startDaemon = vi.fn(async () => {})
        const state: WatchdogState = { restartTimestamps: [] }

        const result = await runWatchdogOnce({
            isDaemonRunning: () => ({ running: false }),
            startDaemon,
            now: () => 1_000,
            log: vi.fn(),
            warn: vi.fn(),
        }, state, { maxRestarts: 3, restartWindowMs: 60_000 })

        expect(result).toBe('restarted')
        expect(startDaemon).toHaveBeenCalledTimes(1)
        expect(state.restartTimestamps).toEqual([1_000])
    })

    it('does not start daemon when pid check reports running', async () => {
        const startDaemon = vi.fn(async () => {})
        const state: WatchdogState = { restartTimestamps: [] }

        const result = await runWatchdogOnce({
            isDaemonRunning: () => ({ running: true, pid: 123 }),
            startDaemon,
            now: () => 2_000,
            log: vi.fn(),
            warn: vi.fn(),
        }, state, { maxRestarts: 3, restartWindowMs: 60_000 })

        expect(result).toBe('running')
        expect(startDaemon).not.toHaveBeenCalled()
        expect(state.restartTimestamps).toEqual([])
    })

    it('rate limits restart loops', async () => {
        const startDaemon = vi.fn(async () => {})
        const state: WatchdogState = {
            restartTimestamps: [1_000, 2_000, 3_000],
        }

        const result = await runWatchdogOnce({
            isDaemonRunning: () => ({ running: false }),
            startDaemon,
            now: () => 4_000,
            log: vi.fn(),
            warn: vi.fn(),
        }, state, { maxRestarts: 3, restartWindowMs: 60_000 })

        expect(result).toBe('rate_limited')
        expect(startDaemon).not.toHaveBeenCalled()
        expect(state.restartTimestamps).toEqual([1_000, 2_000, 3_000])
    })

    it('stops loop when abort signal is set', async () => {
        const controller = new AbortController()
        const sleep = vi.fn(async () => {
            controller.abort()
        })

        await runWatchdogLoop({
            isDaemonRunning: () => ({ running: true, pid: 123 }),
            startDaemon: vi.fn(async () => {}),
            sleep,
            now: () => 1_000,
            log: vi.fn(),
            warn: vi.fn(),
        }, { intervalMs: 10, maxRestarts: 3, restartWindowMs: 60_000, signal: controller.signal })

        expect(sleep).toHaveBeenCalledTimes(1)
    })
})
