import { parseArgs } from 'node:util'
import { spawn } from 'node:child_process'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, getDaemonLogPath, getDaemonBaseDir } from './config'
import { pairing } from './channel/telegram/pairing'
import { resolveNodePath } from './utils/nodePath'
import { isDaemonRunning, startDaemon, stopDaemon } from './daemon/process'
import {
    DEFAULT_WATCHDOG_INTERVAL_MS,
    DEFAULT_WATCHDOG_MAX_RESTARTS,
    DEFAULT_WATCHDOG_RESTART_WINDOW_MS,
    installWatchdogTask,
    runWatchdogLoop,
    runWatchdogOnce,
    uninstallWatchdogTask,
} from './daemon/watchdog'

function parsePositiveInt(value: unknown, fallback: number): number {
    if (typeof value !== 'string') return fallback
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function quoteCommandArg(value: string): string {
    return `"${value.replace(/"/g, '\\"')}"`
}

function buildWatchdogOnceCommand(): string {
    const nodePath = resolveNodePath()
    const binPath = fileURLToPath(new URL('../bin/codever.js', import.meta.url))
    return `${quoteCommandArg(nodePath)} ${quoteCommandArg(binPath)} watchdog --once`
}

async function main() {
    const { values, positionals } = parseArgs({
        args: process.argv.slice(2),
        options: {
            help: { type: 'boolean', short: 'h' },
            version: { type: 'boolean', short: 'v' },
            follow: { type: 'boolean', short: 'f' },
            'log-dir': { type: 'string' },
            groups: { type: 'boolean', default: false },
            group: { type: 'string' },
            once: { type: 'boolean', default: false },
            interval: { type: 'string' },
            'max-restarts': { type: 'string' },
            'restart-window': { type: 'string' },
        },
        allowPositionals: true,
        strict: false
    })

    const command = positionals[0]

    // --- codever start ---
    if (command === 'start') {
        await startDaemon()
        return
    }

    // --- codever restart ---
    if (command === 'restart') {
        await stopDaemon()
        await startDaemon()
        return
    }

    // --- codever stop ---
    if (command === 'stop') {
        await stopDaemon()
        return
    }

    // --- codever watchdog [--once] | watchdog install | watchdog uninstall ---
    if (command === 'watchdog') {
        const subcommand = positionals[1]
        if (subcommand === 'install') {
            const taskCommand = buildWatchdogOnceCommand()
            installWatchdogTask(taskCommand)
            console.log(`Watchdog scheduled task installed: ${taskCommand}`)
            return
        }
        if (subcommand === 'uninstall') {
            uninstallWatchdogTask()
            console.log('Watchdog scheduled task removed.')
            return
        }

        const maxRestarts = parsePositiveInt(values['max-restarts'], DEFAULT_WATCHDOG_MAX_RESTARTS)
        const restartWindowMs = parsePositiveInt(values['restart-window'], DEFAULT_WATCHDOG_RESTART_WINDOW_MS)
        const intervalMs = parsePositiveInt(values.interval, DEFAULT_WATCHDOG_INTERVAL_MS)
        const deps = {
            isDaemonRunning,
            startDaemon,
            now: () => Date.now(),
            log: (message: string) => console.log(`[watchdog] ${message}`),
            warn: (message: string) => console.warn(`[watchdog] ${message}`),
        }

        if (values.once) {
            await runWatchdogOnce(deps, { restartTimestamps: [] }, { maxRestarts, restartWindowMs })
            return
        }

        const controller = new AbortController()
        const stop = () => controller.abort()
        process.once('SIGINT', stop)
        process.once('SIGTERM', stop)
        await runWatchdogLoop(deps, { intervalMs, maxRestarts, restartWindowMs, signal: controller.signal })
        return
    }

    // --- codever status ---
    if (command === 'status') {
        const status = isDaemonRunning()
        const token = config.getBotToken()
        const chats = pairing.listPairedChats()
        console.log('codever status:')
        console.log('  Daemon:', status.running ? `running (PID ${status.pid})` : 'stopped')
        console.log('  Bot token:', token ? 'configured' : 'not set')
        console.log('  Paired chats:', chats.length === 0 ? '(none)' : chats.map(c => c.chatId).join(', '))
        return
    }

    // --- codever logs [-f] [--groups] [--group <chatId>] ---
    if (command === 'logs') {
        const baseDir = getDaemonBaseDir()
        const groupsDir = join(baseDir, 'logs', 'daemon', 'groups')

        // --groups: list all group log directories
        if (values['groups']) {
            if (!existsSync(groupsDir)) {
                console.log('No group logs found.')
                return
            }
            const dirs = readdirSync(groupsDir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name)
            if (dirs.length === 0) {
                console.log('No group logs found.')
            } else {
                for (const dir of dirs) {
                    console.log(dir)
                }
            }
            return
        }

        // --group <chatId>: show group-specific log
        const groupChatId = values['group']
        if (groupChatId) {
            if (typeof groupChatId !== 'string') {
                console.error('Usage: codever logs --group <chatId>')
                process.exit(1)
            }
            // Find the matching group directory
            let groupDirName: string | null = null
            if (existsSync(groupsDir)) {
                const dirs = readdirSync(groupsDir, { withFileTypes: true })
                    .filter(d => d.isDirectory())
                    .map(d => d.name)
                // Try exact match first (for directories named just with chatId)
                if (dirs.includes(groupChatId)) {
                    groupDirName = groupChatId
                } else {
                    // Try to find a directory that contains the chatId in parentheses
                    const match = dirs.find(d => d.endsWith(`(${groupChatId})`))
                    if (match) {
                        groupDirName = match
                    }
                }
            }
            if (!groupDirName) {
                console.error(`No log found for group ${groupChatId}`)
                process.exit(1)
            }
            const groupLogPath = join(groupsDir, groupDirName, 'session.log')
            if (!existsSync(groupLogPath)) {
                console.error(`No log file found for group ${groupChatId}`)
                process.exit(1)
            }
            const args = values['follow'] ? ['-f', '-n', '50', groupLogPath] : ['-n', '50', groupLogPath]
            const tail = spawn('tail', args, { stdio: 'inherit' })
            await new Promise<void>((resolve) => {
                tail.on('exit', () => resolve())
            })
            return
        }

        // Default: show daemon global log
        const logPath = getDaemonLogPath()
        if (!existsSync(logPath)) {
            console.log('No log file found.')
            return
        }

        const args = values['follow'] ? ['-f', '-n', '50', logPath] : ['-n', '50', logPath]
        const tail = spawn('tail', args, { stdio: 'inherit' })
        await new Promise<void>((resolve) => {
            tail.on('exit', () => resolve())
        })
        return
    }

    // --- codever pair <code> ---
    if (command === 'pair') {
        const code = positionals[1]
        if (!code) {
            console.error('Usage: codever pair <code>')
            process.exit(1)
        }

        const botToken = config.getBotToken()
        if (!botToken) {
            console.error('Bot token not configured. Run: codever config set-bot-token <token>')
            process.exit(1)
        }

        const result = pairing.completePairing(code)
        if (!result) {
            console.error('Invalid or expired pairing code.')
            process.exit(1)
        }

        console.log(`Paired with user ${result.userId} (DM chat ${result.chatId})`)

        // Notify the Telegram DM
        try {
            const { Bot } = await import('grammy')
            const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY
            const bot = proxyUrl
                ? new Bot(botToken, { client: { baseFetchConfig: { agent: new HttpsProxyAgent(proxyUrl) } } })
                : new Bot(botToken)
            await bot.api.sendMessage(
                result.chatId,
                '<b>Paired!</b>\n\nTo start a session, create a group and add me.\nUse /cwd &lt;path&gt; in the group to set the working directory, then send a message.',
                { parse_mode: 'HTML' }
            )
        } catch (e) {
            console.warn('Could not send Telegram notification:', e instanceof Error ? e.message : e)
        }
        return
    }

    // --- codever testbot [--log-dir <dir>] ---
    if (command === 'testbot') {
        const testBotToken = config.getTestBotToken()
        if (!testBotToken) {
            console.error('Test bot token not configured. Run: codever config set-test-bot-token <token>')
            process.exit(1)
        }

        const logDir = values['log-dir'] as string | undefined
        const { startTestBot } = await import('./testbot/index.js')
        await startTestBot(testBotToken, logDir)
        return
    }

    // --- codever config <subcommand> ---
    if (command === 'config') {
        const subcommand = positionals[1]
        if (subcommand === 'set-bot-token') {
            const token = positionals[2]
            if (!token) {
                console.error('Usage: codever config set-bot-token <token>')
                process.exit(1)
            }
            config.setBotToken(token)
            console.log('Bot token saved.')
            return
        }
        if (subcommand === 'set-test-bot-token') {
            const token = positionals[2]
            if (!token) {
                console.error('Usage: codever config set-test-bot-token <token>')
                process.exit(1)
            }
            config.setTestBotToken(token)
            console.log('Test bot token saved.')
            return
        }
        if (subcommand === 'show') {
            const token = config.getBotToken()
            console.log('Bot token:', token ? `${token.slice(0, 10)}...` : '(not set)')
            const testToken = config.getTestBotToken()
            console.log('Test bot token:', testToken ? `${testToken.slice(0, 10)}...` : '(not set)')
            const chats = pairing.listPairedChats()
            console.log('Paired chats:', chats.length === 0 ? '(none)' : chats.map(c => c.chatId).join(', '))
            return
        }
        console.error('Usage: codever config [set-bot-token <token> | set-test-bot-token <token> | show]')
        process.exit(1)
    }

    // --- codever --help / -h / no command ---
    if (values['help'] || !command) {
        console.log(`codever - Telegram-driven Claude Code remote agent

Usage:
  codever start                     Start the daemon
  codever stop                      Stop the daemon
  codever restart                   Restart the daemon (stop + start)
  codever watchdog                  Keep daemon running in foreground
  codever watchdog --once           Start daemon if it is not running, then exit
  codever watchdog install          Install Windows scheduled watchdog task
  codever watchdog uninstall        Remove Windows scheduled watchdog task
  codever status                    Show daemon and config status
  codever logs [-f]                 Show daemon logs (follow with -f)
  codever logs --groups             List all group log directories
  codever logs --group <chatId>     Show logs for a specific group
  codever testbot                   Start the test listener bot
  codever testbot --log-dir <dir>   Start test bot with custom log directory
  codever pair <code>               Complete pairing from terminal
  codever config set-bot-token <t>  Configure Telegram bot token
  codever config set-test-bot-token <t>  Configure test bot token
  codever config show               Show configuration

Architecture:
  - Daemon runs in background with Telegram bot polling
  - DM = Control panel (pairing, status, help)
  - Groups = Session interaction (each group = one Claude session)
  - /cwd <path> in group to set working directory, then send messages
  - testbot = Observer bot that logs all messages for testing
`)
        return
    }

    console.error(`Unknown command: ${command}`)
    console.error('Run "codever --help" for usage.')
    process.exit(1)
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
