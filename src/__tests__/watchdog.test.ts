import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mkdirSyncMock, rmSyncMock, spawnSyncMock, writeFileSyncMock } = vi.hoisted(() => ({
    mkdirSyncMock: vi.fn(),
    rmSyncMock: vi.fn(),
    spawnSyncMock: vi.fn(() => ({ status: 0 })),
    writeFileSyncMock: vi.fn(),
}))

vi.mock('node:child_process', () => ({
    spawnSync: spawnSyncMock,
}))

vi.mock('node:fs', () => ({
    mkdirSync: mkdirSyncMock,
    rmSync: rmSyncMock,
    writeFileSync: writeFileSyncMock,
}))

import {
    installWatchdogTask,
    installWindowsWatchdogTask,
    runWatchdogLoop,
    runWatchdogOnce,
    uninstallWatchdogTask,
    type WatchdogState,
} from '@/daemon/watchdog'

describe('daemon watchdog', () => {
    beforeEach(() => {
        mkdirSyncMock.mockClear()
        rmSyncMock.mockClear()
        spawnSyncMock.mockClear()
        writeFileSyncMock.mockClear()
        spawnSyncMock.mockReturnValue({ status: 0 })
    })

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

    it('installs the Windows scheduled task through a hidden runner', () => {
        installWindowsWatchdogTask(
            '"C:\\Program Files\\nodejs\\node.exe" "C:\\codever\\bin\\codever.js" watchdog --once',
            'CodeverWatchdogTest',
            { runnerPath: 'C:\\Users\\me\\.config\\codever\\watchdog.vbs' },
        )

        expect(mkdirSyncMock).toHaveBeenCalledWith('C:\\Users\\me\\.config\\codever', { recursive: true })
        expect(writeFileSyncMock).toHaveBeenCalledWith(
            'C:\\Users\\me\\.config\\codever\\watchdog.vbs',
            expect.stringContaining('shell.Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\codever\\bin\\codever.js"" watchdog --once", 0, False'),
            'utf8',
        )
        expect(spawnSyncMock).toHaveBeenCalledWith('schtasks', [
            '/Create',
            '/TN', 'CodeverWatchdogTest',
            '/SC', 'MINUTE',
            '/MO', '1',
            '/TR', 'wscript.exe "C:\\Users\\me\\.config\\codever\\watchdog.vbs"',
            '/F',
        ], {
            stdio: 'inherit',
            windowsHide: true,
        })
    })

    it('dispatches install and uninstall to the Windows task implementation', () => {
        installWatchdogTask('node codever watchdog --once', {
            platform: 'win32',
            windowsRunnerPath: 'C:\\Users\\me\\.config\\codever\\watchdog.vbs',
        })
        uninstallWatchdogTask({
            platform: 'win32',
            windowsRunnerPath: 'C:\\Users\\me\\.config\\codever\\watchdog.vbs',
        })

        expect(spawnSyncMock).toHaveBeenCalledWith('schtasks', expect.arrayContaining(['/Create']), expect.any(Object))
        expect(spawnSyncMock).toHaveBeenCalledWith('schtasks', expect.arrayContaining(['/Delete']), expect.any(Object))
        expect(rmSyncMock).toHaveBeenCalledWith('C:\\Users\\me\\.config\\codever\\watchdog.vbs', { force: true })
    })

    it('installs and uninstalls a macOS LaunchAgent', () => {
        installWatchdogTask('node /app/bin/codever.js watchdog --once', {
            platform: 'darwin',
            launchAgentPath: '/Users/me/Library/LaunchAgents/com.codever.watchdog.plist',
        })
        uninstallWatchdogTask({
            platform: 'darwin',
            launchAgentPath: '/Users/me/Library/LaunchAgents/com.codever.watchdog.plist',
        })

        expect(mkdirSyncMock).toHaveBeenCalledWith('/Users/me/Library/LaunchAgents', { recursive: true })
        expect(writeFileSyncMock).toHaveBeenCalledWith(
            '/Users/me/Library/LaunchAgents/com.codever.watchdog.plist',
            expect.stringContaining('<key>StartInterval</key>'),
            'utf8',
        )
        expect(writeFileSyncMock).toHaveBeenCalledWith(
            '/Users/me/Library/LaunchAgents/com.codever.watchdog.plist',
            expect.stringContaining('<string>node /app/bin/codever.js watchdog --once</string>'),
            'utf8',
        )
        expect(spawnSyncMock).toHaveBeenCalledWith('launchctl', ['load', '-w', '/Users/me/Library/LaunchAgents/com.codever.watchdog.plist'], expect.any(Object))
        expect(spawnSyncMock).toHaveBeenCalledWith('launchctl', ['unload', '-w', '/Users/me/Library/LaunchAgents/com.codever.watchdog.plist'], expect.any(Object))
        expect(rmSyncMock).toHaveBeenCalledWith('/Users/me/Library/LaunchAgents/com.codever.watchdog.plist', { force: true })
    })

    it('installs and uninstalls a Linux systemd user timer', () => {
        installWatchdogTask("node /app/bin/codever.js watchdog --once", {
            platform: 'linux',
            systemdUserDir: '/home/me/.config/systemd/user',
        })
        uninstallWatchdogTask({
            platform: 'linux',
            systemdUserDir: '/home/me/.config/systemd/user',
        })

        expect(mkdirSyncMock).toHaveBeenCalledWith('/home/me/.config/systemd/user', { recursive: true })
        expect(writeFileSyncMock).toHaveBeenCalledWith(
            '/home/me/.config/systemd/user/codever-watchdog.service',
            expect.stringContaining("ExecStart=/bin/sh -lc 'node /app/bin/codever.js watchdog --once'"),
            'utf8',
        )
        expect(writeFileSyncMock).toHaveBeenCalledWith(
            '/home/me/.config/systemd/user/codever-watchdog.timer',
            expect.stringContaining('OnUnitActiveSec=60s'),
            'utf8',
        )
        expect(spawnSyncMock).toHaveBeenCalledWith('systemctl', ['--user', 'daemon-reload'], expect.any(Object))
        expect(spawnSyncMock).toHaveBeenCalledWith('systemctl', ['--user', 'enable', '--now', 'codever-watchdog.timer'], expect.any(Object))
        expect(spawnSyncMock).toHaveBeenCalledWith('systemctl', ['--user', 'disable', '--now', 'codever-watchdog.timer'], expect.any(Object))
        expect(rmSyncMock).toHaveBeenCalledWith('/home/me/.config/systemd/user/codever-watchdog.service', { force: true })
        expect(rmSyncMock).toHaveBeenCalledWith('/home/me/.config/systemd/user/codever-watchdog.timer', { force: true })
    })
})
