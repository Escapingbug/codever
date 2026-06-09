import { spawnSync } from 'node:child_process'
import type { DaemonStatus } from './process'

export interface WatchdogState {
    restartTimestamps: number[]
}

export interface WatchdogOptions {
    intervalMs: number
    maxRestarts: number
    restartWindowMs: number
    signal?: AbortSignal
}

export interface WatchdogOnceOptions {
    maxRestarts: number
    restartWindowMs: number
}

export interface WatchdogDeps {
    isDaemonRunning(): DaemonStatus
    startDaemon(): Promise<void>
    now(): number
    log(message: string): void
    warn(message: string): void
    sleep?(ms: number): Promise<void>
}

export type WatchdogResult = 'running' | 'restarted' | 'rate_limited'

export const DEFAULT_WATCHDOG_INTERVAL_MS = 5_000
export const DEFAULT_WATCHDOG_MAX_RESTARTS = 3
export const DEFAULT_WATCHDOG_RESTART_WINDOW_MS = 60_000
export const WINDOWS_WATCHDOG_TASK_NAME = 'CodeverWatchdog'

export async function runWatchdogOnce(
    deps: WatchdogDeps,
    state: WatchdogState = { restartTimestamps: [] },
    options: WatchdogOnceOptions = {
        maxRestarts: DEFAULT_WATCHDOG_MAX_RESTARTS,
        restartWindowMs: DEFAULT_WATCHDOG_RESTART_WINDOW_MS,
    },
): Promise<WatchdogResult> {
    const status = deps.isDaemonRunning()
    if (status.running) {
        deps.log(`Daemon running (PID ${status.pid})`)
        return 'running'
    }

    const now = deps.now()
    pruneRestartWindow(state, now, options.restartWindowMs)
    if (state.restartTimestamps.length >= options.maxRestarts) {
        deps.warn(`Daemon stopped, but watchdog restart limit reached (${options.maxRestarts} per ${options.restartWindowMs}ms).`)
        return 'rate_limited'
    }

    state.restartTimestamps.push(now)
    deps.warn('Daemon is not running; starting it now.')
    await deps.startDaemon()
    return 'restarted'
}

export async function runWatchdogLoop(
    deps: WatchdogDeps,
    options: WatchdogOptions,
): Promise<void> {
    const state: WatchdogState = { restartTimestamps: [] }
    const sleep = deps.sleep ?? defaultSleep

    deps.log(`Watchdog started: interval=${options.intervalMs}ms, maxRestarts=${options.maxRestarts}, window=${options.restartWindowMs}ms`)
    while (!options.signal?.aborted) {
        await runWatchdogOnce(deps, state, options)
        if (options.signal?.aborted) break
        await sleep(options.intervalMs)
    }
    deps.log('Watchdog stopped.')
}

export function installWindowsWatchdogTask(command: string, taskName = WINDOWS_WATCHDOG_TASK_NAME): void {
    if (process.platform !== 'win32') {
        throw new Error('watchdog install is only supported on Windows')
    }

    const result = spawnSync('schtasks', [
        '/Create',
        '/TN', taskName,
        '/SC', 'MINUTE',
        '/MO', '1',
        '/TR', command,
        '/F',
    ], {
        stdio: 'inherit',
        windowsHide: true,
    })

    if (result.status !== 0) {
        throw new Error(`schtasks /Create failed with exit code ${result.status ?? 'unknown'}`)
    }
}

export function uninstallWindowsWatchdogTask(taskName = WINDOWS_WATCHDOG_TASK_NAME): void {
    if (process.platform !== 'win32') {
        throw new Error('watchdog uninstall is only supported on Windows')
    }

    const result = spawnSync('schtasks', [
        '/Delete',
        '/TN', taskName,
        '/F',
    ], {
        stdio: 'inherit',
        windowsHide: true,
    })

    if (result.status !== 0) {
        throw new Error(`schtasks /Delete failed with exit code ${result.status ?? 'unknown'}`)
    }
}

function pruneRestartWindow(state: WatchdogState, now: number, restartWindowMs: number): void {
    state.restartTimestamps = state.restartTimestamps.filter(timestamp => now - timestamp <= restartWindowMs)
}

function defaultSleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
