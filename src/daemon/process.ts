import { spawn, execSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, getDaemonLogPath, getDaemonPidPath } from '@/config'
import { resolveNodePath } from '@/utils/nodePath'

export interface DaemonStatus {
    running: boolean
    pid?: number
}

export function isDaemonRunning(): DaemonStatus {
    const pidPath = getDaemonPidPath()
    if (!existsSync(pidPath)) return { running: false }

    const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10)
    if (isNaN(pid)) return { running: false }

    try {
        process.kill(pid, 0)
        return { running: true, pid }
    } catch {
        try { unlinkSync(pidPath) } catch {}
        return { running: false }
    }
}

export async function stopDaemon(): Promise<void> {
    const status = isDaemonRunning()
    if (!status.running || !status.pid) {
        console.log('Daemon is not running.')
        return
    }

    console.log(`Stopping daemon (PID ${status.pid})...`)
    process.kill(status.pid, 'SIGTERM')

    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500))
        if (!isDaemonRunning().running) {
            console.log('Daemon stopped.')
            return
        }
    }

    console.log('Daemon did not stop in time, sending SIGKILL...')
    try { process.kill(status.pid, 'SIGKILL') } catch {}
    try { unlinkSync(getDaemonPidPath()) } catch {}
    console.log('Daemon killed.')
}

export async function startDaemon(): Promise<void> {
    const status = isDaemonRunning()
    if (status.running) {
        console.log(`Daemon already running (PID ${status.pid})`)
        return
    }

    const nodePath = resolveNodePath()
    const envExtra: Record<string, string> = {
        CODEVER_NODE_PATH: nodePath,
        CODEVER_DISABLE_STDIO_MIRROR: '1',
    }

    try {
        const claudePath = execSync(
            process.platform === 'win32' ? 'where claude' : 'which claude',
            { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
        ).trim().split('\n')[0].trim()
        if (claudePath) envExtra.CODEVER_CLAUDE_PATH = claudePath
    } catch {
        // Claude CLI is optional; other providers may still be available.
    }

    const botToken = config.getBotToken()
    if (!botToken) {
        console.error('Bot token not configured. Run: codever config set-bot-token <token>')
        process.exit(1)
    }

    const daemonScript = fileURLToPath(new URL('./daemon.js', import.meta.url))
    const logPath = getDaemonLogPath()
    mkdirSync(dirname(logPath), { recursive: true })
    const stdoutFd = openSync(logPath, 'a')
    const stderrFd = openSync(logPath, 'a')
    const child = spawn(nodePath, [daemonScript], {
        detached: true,
        stdio: ['ignore', stdoutFd, stderrFd],
        env: {
            ...process.env,
            ...envExtra,
        },
    })
    closeSync(stdoutFd)
    closeSync(stderrFd)

    child.unref()
    console.log(`Daemon started (PID ${child.pid})`)
    if (envExtra.CODEVER_CLAUDE_PATH) console.log(`  Claude: ${envExtra.CODEVER_CLAUDE_PATH}`)
    console.log(`  Node: ${nodePath}`)
    console.log(`  Default provider: ${config.getDefaultProvider()}`)
    console.log(`  Logs: ${getDaemonLogPath()}`)
}
