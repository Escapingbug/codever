import { parseArgs } from 'node:util'
import { spawn, execSync } from 'node:child_process'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { existsSync, readFileSync, unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, getDaemonPidPath, getDaemonLogPath, getDaemonBaseDir } from './config'
import { pairing } from './channel/telegram/pairing'
import { resolveNodePath } from './utils/nodePath'

function isDaemonRunning(): { running: boolean; pid?: number } {
    const pidPath = getDaemonPidPath()
    if (!existsSync(pidPath)) return { running: false }

    const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10)
    if (isNaN(pid)) return { running: false }

    try {
        process.kill(pid, 0) // test if process exists
        return { running: true, pid }
    } catch {
        // Stale PID file — clean up
        try { unlinkSync(pidPath) } catch {}
        return { running: false }
    }
}

async function stopDaemon() {
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

async function startDaemon() {
    const status = isDaemonRunning()
    if (status.running) {
        console.log(`Daemon already running (PID ${status.pid})`)
        return
    }

    // Resolve provider CLI paths (best-effort, not all providers require CLI)
    const nodePath = resolveNodePath()
    const envExtra: Record<string, string> = {
        CODEVER_NODE_PATH: nodePath,
    }

    // Try to find claude CLI (optional)
    try {
        const claudePath = execSync(
            process.platform === 'win32' ? 'where claude' : 'which claude',
            { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim().split('\n')[0].trim()
        if (claudePath) envExtra.CODEVER_CLAUDE_PATH = claudePath
    } catch {
        // Claude CLI not found — not fatal, other providers may be available
    }

    const botToken = config.getBotToken()
    if (!botToken) {
        console.error('Bot token not configured. Run: codever config set-bot-token <token>')
        process.exit(1)
    }

    const daemonScript = fileURLToPath(new URL('./daemon.js', import.meta.url))

    const child = spawn(nodePath, [daemonScript], {
        detached: true,
        stdio: 'ignore',
        env: {
            ...process.env,
            ...envExtra,
        }
    })

    child.unref()
    console.log(`Daemon started (PID ${child.pid})`)
    if (envExtra.CODEVER_CLAUDE_PATH) console.log(`  Claude: ${envExtra.CODEVER_CLAUDE_PATH}`)
    console.log(`  Node: ${nodePath}`)
    console.log(`  Default provider: ${config.getDefaultProvider()}`)
    console.log(`  Logs: ${getDaemonLogPath()}`)
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
