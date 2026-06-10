import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
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

export interface WatchdogTaskOptions {
    platform?: NodeJS.Platform
    windowsTaskName?: string
    windowsRunnerPath?: string
    launchAgentPath?: string
    systemdUserDir?: string
}

export interface WindowsWatchdogTaskOptions {
    platform?: NodeJS.Platform
    runnerPath?: string
}

export type WatchdogResult = 'running' | 'restarted' | 'rate_limited'

export const DEFAULT_WATCHDOG_INTERVAL_MS = 5_000
export const DEFAULT_WATCHDOG_MAX_RESTARTS = 3
export const DEFAULT_WATCHDOG_RESTART_WINDOW_MS = 60_000
export const WINDOWS_WATCHDOG_TASK_NAME = 'CodeverWatchdog'
export const MACOS_WATCHDOG_LABEL = 'com.codever.watchdog'
export const LINUX_WATCHDOG_SERVICE_NAME = 'codever-watchdog.service'
export const LINUX_WATCHDOG_TIMER_NAME = 'codever-watchdog.timer'

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

export function installWatchdogTask(command: string, options: WatchdogTaskOptions = {}): void {
    const platform = options.platform ?? process.platform
    switch (platform) {
        case 'win32':
            installWindowsWatchdogTask(command, options.windowsTaskName, {
                platform,
                runnerPath: options.windowsRunnerPath,
            })
            return
        case 'darwin':
            installMacOSWatchdogLaunchAgent(command, options.launchAgentPath)
            return
        case 'linux':
            installLinuxWatchdogSystemdTimer(command, options.systemdUserDir)
            return
        default:
            throw new Error(`watchdog install is not supported on ${platform}`)
    }
}

export function uninstallWatchdogTask(options: WatchdogTaskOptions = {}): void {
    const platform = options.platform ?? process.platform
    switch (platform) {
        case 'win32':
            uninstallWindowsWatchdogTask(options.windowsTaskName, {
                platform,
                runnerPath: options.windowsRunnerPath,
            })
            return
        case 'darwin':
            uninstallMacOSWatchdogLaunchAgent(options.launchAgentPath)
            return
        case 'linux':
            uninstallLinuxWatchdogSystemdTimer(options.systemdUserDir)
            return
        default:
            throw new Error(`watchdog uninstall is not supported on ${platform}`)
    }
}

export function installWindowsWatchdogTask(
    command: string,
    taskName = WINDOWS_WATCHDOG_TASK_NAME,
    options: WindowsWatchdogTaskOptions = {},
): void {
    if ((options.platform ?? process.platform) !== 'win32') {
        throw new Error('watchdog install is only supported on Windows')
    }

    const runnerPath = options.runnerPath ?? getDefaultWindowsWatchdogRunnerPath()
    mkdirSync(dirname(runnerPath), { recursive: true })
    writeFileSync(runnerPath, buildHiddenWatchdogRunner(command), 'utf8')

    const result = spawnSync('schtasks', [
        '/Create',
        '/TN', taskName,
        '/SC', 'MINUTE',
        '/MO', '1',
        '/TR', `wscript.exe ${quoteWindowsArg(runnerPath)}`,
        '/F',
    ], {
        stdio: 'inherit',
        windowsHide: true,
    })

    assertSpawnSucceeded(result.status, 'schtasks /Create')
}

export function uninstallWindowsWatchdogTask(
    taskName = WINDOWS_WATCHDOG_TASK_NAME,
    options: WindowsWatchdogTaskOptions = {},
): void {
    if ((options.platform ?? process.platform) !== 'win32') {
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

    assertSpawnSucceeded(result.status, 'schtasks /Delete')

    const runnerPath = options.runnerPath ?? getDefaultWindowsWatchdogRunnerPath()
    rmSync(runnerPath, { force: true })
}

function pruneRestartWindow(state: WatchdogState, now: number, restartWindowMs: number): void {
    state.restartTimestamps = state.restartTimestamps.filter(timestamp => now - timestamp <= restartWindowMs)
}

function getDefaultWindowsWatchdogRunnerPath(): string {
    return join(homedir(), '.config', 'codever', 'watchdog.vbs')
}

function installMacOSWatchdogLaunchAgent(command: string, launchAgentPath = getDefaultMacOSLaunchAgentPath()): void {
    mkdirSync(dirname(launchAgentPath), { recursive: true })
    writeFileSync(launchAgentPath, buildMacOSLaunchAgentPlist(command), 'utf8')

    const result = spawnSync('launchctl', ['load', '-w', launchAgentPath], {
        stdio: 'inherit',
        windowsHide: true,
    })
    assertSpawnSucceeded(result.status, 'launchctl load')
}

function uninstallMacOSWatchdogLaunchAgent(launchAgentPath = getDefaultMacOSLaunchAgentPath()): void {
    const result = spawnSync('launchctl', ['unload', '-w', launchAgentPath], {
        stdio: 'inherit',
        windowsHide: true,
    })
    assertSpawnSucceeded(result.status, 'launchctl unload')

    rmSync(launchAgentPath, { force: true })
}

function installLinuxWatchdogSystemdTimer(command: string, systemdUserDir = getDefaultSystemdUserDir()): void {
    mkdirSync(systemdUserDir, { recursive: true })
    writeFileSync(joinLinuxPath(systemdUserDir, LINUX_WATCHDOG_SERVICE_NAME), buildLinuxSystemdService(command), 'utf8')
    writeFileSync(joinLinuxPath(systemdUserDir, LINUX_WATCHDOG_TIMER_NAME), buildLinuxSystemdTimer(), 'utf8')

    let result = spawnSync('systemctl', ['--user', 'daemon-reload'], {
        stdio: 'inherit',
        windowsHide: true,
    })
    assertSpawnSucceeded(result.status, 'systemctl --user daemon-reload')

    result = spawnSync('systemctl', ['--user', 'enable', '--now', LINUX_WATCHDOG_TIMER_NAME], {
        stdio: 'inherit',
        windowsHide: true,
    })
    assertSpawnSucceeded(result.status, 'systemctl --user enable --now')
}

function uninstallLinuxWatchdogSystemdTimer(systemdUserDir = getDefaultSystemdUserDir()): void {
    let result = spawnSync('systemctl', ['--user', 'disable', '--now', LINUX_WATCHDOG_TIMER_NAME], {
        stdio: 'inherit',
        windowsHide: true,
    })
    assertSpawnSucceeded(result.status, 'systemctl --user disable --now')

    rmSync(joinLinuxPath(systemdUserDir, LINUX_WATCHDOG_SERVICE_NAME), { force: true })
    rmSync(joinLinuxPath(systemdUserDir, LINUX_WATCHDOG_TIMER_NAME), { force: true })

    result = spawnSync('systemctl', ['--user', 'daemon-reload'], {
        stdio: 'inherit',
        windowsHide: true,
    })
    assertSpawnSucceeded(result.status, 'systemctl --user daemon-reload')
}

function getDefaultMacOSLaunchAgentPath(): string {
    return join(homedir(), 'Library', 'LaunchAgents', `${MACOS_WATCHDOG_LABEL}.plist`)
}

function getDefaultSystemdUserDir(): string {
    return join(homedir(), '.config', 'systemd', 'user')
}

function buildHiddenWatchdogRunner(command: string): string {
    return [
        'Set shell = CreateObject("WScript.Shell")',
        `shell.Run ${toVbsStringLiteral(command)}, 0, False`,
        '',
    ].join('\r\n')
}

function buildMacOSLaunchAgentPlist(command: string): string {
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '  <key>Label</key>',
        `  <string>${MACOS_WATCHDOG_LABEL}</string>`,
        '  <key>ProgramArguments</key>',
        '  <array>',
        '    <string>/bin/sh</string>',
        '    <string>-lc</string>',
        `    <string>${escapeXml(command)}</string>`,
        '  </array>',
        '  <key>RunAtLoad</key>',
        '  <true/>',
        '  <key>StartInterval</key>',
        '  <integer>60</integer>',
        '</dict>',
        '</plist>',
        '',
    ].join('\n')
}

function buildLinuxSystemdService(command: string): string {
    return [
        '[Unit]',
        'Description=Codever watchdog',
        '',
        '[Service]',
        'Type=oneshot',
        `ExecStart=/bin/sh -lc ${quoteShellArg(command)}`,
        '',
    ].join('\n')
}

function buildLinuxSystemdTimer(): string {
    return [
        '[Unit]',
        'Description=Run Codever watchdog every minute',
        '',
        '[Timer]',
        'OnBootSec=30s',
        'OnUnitActiveSec=60s',
        `Unit=${LINUX_WATCHDOG_SERVICE_NAME}`,
        '',
        '[Install]',
        'WantedBy=timers.target',
        '',
    ].join('\n')
}

function quoteWindowsArg(value: string): string {
    return `"${value.replace(/"/g, '\\"')}"`
}

function toVbsStringLiteral(value: string): string {
    return `"${value.replace(/"/g, '""')}"`
}

function quoteShellArg(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`
}

function joinLinuxPath(directory: string, fileName: string): string {
    return `${directory.replace(/[\\/]+$/, '')}/${fileName}`
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
}

function assertSpawnSucceeded(status: number | null, command: string): void {
    if (status !== 0) {
        throw new Error(`${command} failed with exit code ${status ?? 'unknown'}`)
    }
}

function defaultSleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
