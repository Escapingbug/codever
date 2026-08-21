import { parseArgs } from 'node:util'
import { spawn } from 'node:child_process'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { chmodSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import QRCode from 'qrcode'
import { config, getDaemonLogPath, getDaemonBaseDir } from './config'
import { pairing } from './channel/telegram/pairing'
import { GatewayAdminClient } from './gateway/admin/client'
import { loadProviderProfiles } from './providers/configured'
import { resolveNodePath } from './utils/nodePath'
import { isDaemonRunning, startDaemon, stopDaemon } from './daemon/process'
import {
    installPrivilegeHelper,
    UnixSocketPrivilegeExecutor,
} from './privilege/index'
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
            socket: { type: 'string' },
            'app-url': { type: 'string' },
            lifetime: { type: 'string' },
            'matrix-login': { type: 'string' },
            qr: { type: 'string' },
            output: { type: 'string' },
            reason: { type: 'string' },
            caption: { type: 'string' },
            filename: { type: 'string' },
            source: { type: 'string' },
            'idempotency-key': { type: 'string' },
            'privilege-approval': { type: 'boolean', default: false },
            'gateway-data-dir': { type: 'string' },
            'allow-executable': { type: 'string', multiple: true },
            'allow-arbitrary-root-executables': { type: 'boolean', default: false },
            'target-uid': { type: 'string' },
            'target-gid': { type: 'string' },
            json: { type: 'boolean', default: false },
        },
        allowPositionals: true,
        strict: false
    })

    const command = positionals[0]

    if (command === 'gateway') {
        await handleGatewayCommand(positionals.slice(1), values)
        return
    }
    if (command === 'send-file') {
        await handleGatewayCommand(['send-file', ...positionals.slice(1)], values)
        return
    }

    if (command === 'privilege') {
        await handlePrivilegeCommand(positionals.slice(1), values)
        return
    }

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
            try {
                const providerProfiles = loadProviderProfiles()
                const profileSummary = providerProfiles.providers.map(profile => `${profile.id}:${profile.type}`).join(', ')
                console.log('Provider profiles:', profileSummary)
                console.log('Provider profile config:', providerProfiles.exists ? providerProfiles.path : `${providerProfiles.path} (not found, using built-ins)`)
                console.log('Default provider:', providerProfiles.defaultProvider ?? config.getDefaultProvider())
            } catch (e) {
                console.log('Provider profiles: invalid config -', e instanceof Error ? e.message : String(e))
            }
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
  codever gateway status            Show the local Matrix Gateway status
  codever gateway invite            Create a one-time device invitation QR
  codever gateway devices           List paired PWA devices
  codever gateway cancel <offer>    Cancel an unused invitation
  codever gateway revoke <device>   Revoke a paired PWA device
  codever send-file <path>          Send a file to the workspace inbox
  codever privilege status          Check the local root Helper
  sudo codever privilege install    Install the local root Helper once
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

async function handlePrivilegeCommand(
    positionals: string[],
    values: Record<string, unknown>,
): Promise<void> {
    if (values.help) {
        console.log(`Usage:
  codever privilege status --gateway-data-dir PATH
  sudo codever privilege install --gateway-data-dir PATH
      --allow-executable ABSOLUTE_PATH [--allow-executable ABSOLUTE_PATH ...]
      [--allow-arbitrary-root-executables]
      [--target-uid UID --target-gid GID]

The install command prompts for local administrator access once and prints a
TOTP setup key. Later root operations require fingerprint/device unlock and a
fresh client-side TOTP from a separately authorized PWA device.
Prefer an executable allowlist. The arbitrary-executable option grants the
widest host policy and should only be used on a dedicated machine.
`)
        return
    }
    const subcommand = positionals[0] ?? 'status'
    const gatewayDataDirectory = stringOption(values['gateway-data-dir'])
        ?? process.env.CODEVER_MATRIX_DATA_DIR
    if (!gatewayDataDirectory) {
        throw new Error('--gateway-data-dir or CODEVER_MATRIX_DATA_DIR is required')
    }
    const credentialPath = join(gatewayDataDirectory, 'privilege-client.json')
    if (subcommand === 'status') {
        const status = await new UnixSocketPrivilegeExecutor(credentialPath).status()
        if (values.json) {
            console.log(JSON.stringify(status, null, 2))
            return
        }
        console.log(`Privilege Helper: ${status.state}`)
        console.log(`TOTP required: ${status.totpRequired ? 'yes' : 'no'}`)
        console.log(`Credential: ${credentialPath}`)
        return
    }
    if (subcommand !== 'install') {
        throw new Error(`Unknown privilege command: ${subcommand}`)
    }
    const helperBundlePath = fileURLToPath(
        new URL('./privilege/helperMain.js', import.meta.url),
    )
    const targetUid = identityOption(values['target-uid'], '--target-uid')
    const targetGid = identityOption(values['target-gid'], '--target-gid')
    const result = await installPrivilegeHelper({
        gatewayDataDirectory,
        helperBundlePath,
        allowedExecutables: stringArrayOption(values['allow-executable']),
        allowArbitraryRootExecutables:
            values['allow-arbitrary-root-executables'] === true,
        ...(targetUid === undefined ? {} : { targetUid }),
        ...(targetGid === undefined ? {} : { targetGid }),
    })
    console.log('Privilege Helper installed and healthy.')
    console.log(`Service: ${result.layout.serviceName}`)
    console.log(`Credential: ${result.layout.credentialPath}`)
    console.log(
        result.allowArbitraryRootExecutables
            ? 'Host policy: any safe root-owned executable'
            : `Host policy: ${result.allowedExecutables.join(', ')}`,
    )
    console.log('Save this TOTP setup key in the privilege-approval PWA now.')
    console.log(`TOTP setup key: ${result.totpSecret}`)
    console.log(`TOTP provisioning URI: ${result.totpProvisioningUri}`)
    console.log('The setup key is stored only in the root Helper configuration and is not recoverable from the Gateway credential.')
    console.log('Restart the Matrix Gateway so it discovers the Helper credential.')
    console.log(
        'Pair an approval device with: codever gateway invite --privilege-approval',
    )
}

async function handleGatewayCommand(
    positionals: string[],
    values: Record<string, unknown>,
): Promise<void> {
    if (values.help) {
        console.log(`Usage:
  codever gateway status [--socket PATH] [--json]
  codever gateway invite [--socket PATH] [--app-url URL]
      [--lifetime SECONDS] [--matrix-login required|preferred|disabled]
      [--privilege-approval]
      [--qr terminal|png|none] [--output PATH] [--json]
  codever gateway devices [--socket PATH] [--json]
  codever gateway cancel <invitation-id> [--socket PATH]
  codever gateway revoke <device-id> [--reason TEXT] [--socket PATH]
  codever gateway send-file <path> [--caption TEXT] [--filename NAME]
      [--source LABEL] [--idempotency-key KEY] [--socket PATH] [--json]
`)
        return
    }
    const subcommand = positionals[0] ?? 'status'
    const socketPath =
        stringOption(values.socket)
        ?? process.env.CODEVER_GATEWAY_ADMIN_SOCKET
        ?? defaultGatewayAdminSocket()
    const client = new GatewayAdminClient({
        socketPath,
        timeoutMs: subcommand === 'send-file' ? 120_000 : 5_000,
    })

    if (subcommand === 'status') {
        const status = await client.status()
        if (values.json) {
            console.log(JSON.stringify(status, null, 2))
            return
        }
        console.log(`Gateway: ${status.state}`)
        console.log(`Gateway ID: ${status.gatewayId}`)
        console.log(`PID: ${status.pid}`)
        console.log(`Active devices: ${status.activeDeviceCount}`)
        console.log(`Open invitations: ${status.openInvitationCount}`)
        console.log(`Admin socket: ${socketPath}`)
        return
    }

    if (subcommand === 'invite') {
        const appUrl =
            stringOption(values['app-url'])
            ?? process.env.CODEVER_PWA_URL
        const matrixLogin = parseMatrixLoginMode(values['matrix-login'])
        const lifetimeMs = parseLifetimeMs(values.lifetime)
        const invitation = await client.createInvitation({
            ...(lifetimeMs === undefined ? {} : { lifetimeMs }),
            matrixLogin,
            ...(appUrl ? { appUrl } : {}),
            ...(values['privilege-approval'] ? { privilegeApproval: true } : {}),
        })
        if (values.json) {
            console.log(JSON.stringify(invitation, null, 2))
            return
        }
        const qrMode = stringOption(values.qr) ?? 'terminal'
        if (qrMode === 'terminal') {
            console.log(await QRCode.toString(invitation.url, {
                type: 'terminal',
                small: true,
                errorCorrectionLevel: 'L',
            }))
        } else if (qrMode === 'png') {
            const output = stringOption(values.output)
                ?? join(process.cwd(), 'codever-device-invitation.png')
            const png = await QRCode.toBuffer(invitation.url, {
                type: 'png',
                width: 512,
                margin: 2,
                errorCorrectionLevel: 'L',
            })
            writeFileSync(output, png, { mode: 0o600 })
            if (process.platform !== 'win32') chmodSync(output, 0o600)
            console.log(`QR code: ${output}`)
        } else if (qrMode !== 'none') {
            throw new Error('--qr must be terminal, png, or none')
        }
        console.log(`Invitation link:\n${invitation.url}`)
        console.log(`Verification code: ${formatGatewayCode(invitation.verificationCode)}`)
        console.log(`Expires: ${new Date(invitation.expiresAt).toISOString()}`)
        console.log(
            invitation.includesMatrixLogin
                ? 'Matrix login: one-time token included'
                : `Matrix login: ${invitation.matrixLoginStatus}`,
        )
        console.log('Treat this one-time invitation as a credential until it expires.')
        return
    }

    if (subcommand === 'devices') {
        const devices = await client.devices()
        if (values.json) {
            console.log(JSON.stringify({ devices }, null, 2))
            return
        }
        if (devices.length === 0) {
            console.log('No paired PWA devices.')
            return
        }
        for (const device of devices) {
            console.log(
                `${device.deviceId}\t${device.status}\t${device.deviceName}`
                + `\t${device.matrixDeviceId}`,
            )
        }
        return
    }

    if (subcommand === 'send-file') {
        const path = positionals[1]
        if (!path) {
            throw new Error('Usage: codever send-file <path> [--caption TEXT] [--filename NAME]')
        }
        const result = await client.sendFile({
            path: resolve(path),
            ...(stringOption(values.filename) ? { filename: stringOption(values.filename) } : {}),
            ...(stringOption(values.caption) ? { caption: stringOption(values.caption) } : {}),
            ...(stringOption(values.source) ? { sourceLabel: stringOption(values.source) } : {}),
        }, stringOption(values['idempotency-key']))
        if (values.json) {
            console.log(JSON.stringify(result, null, 2))
            return
        }
        console.log(
            result.delivery === 'delivered'
                ? `Sent ${path} to the Codever workspace file inbox.`
                : `Queued ${path} for the Codever workspace file inbox.`,
        )
        console.log(`File ID: ${result.fileId}`)
        return
    }

    if (subcommand === 'cancel') {
        const invitationId = positionals[1]
        if (!invitationId) {
            throw new Error('Usage: codever gateway cancel <invitation-id>')
        }
        await client.cancelInvitation(invitationId)
        console.log(`Cancelled invitation ${invitationId}.`)
        return
    }

    if (subcommand === 'revoke') {
        const deviceId = positionals[1]
        if (!deviceId) {
            throw new Error('Usage: codever gateway revoke <device-id> [--reason TEXT]')
        }
        const reason = stringOption(values.reason)
        await client.revokeDevice(deviceId, reason ? { reason } : {})
        console.log(`Revoked device ${deviceId}.`)
        return
    }

    throw new Error(
        'Usage: codever gateway [status | invite | devices | send-file <path> | cancel <offer> | revoke <device>]',
    )
}

function parseLifetimeMs(value: unknown): number | undefined {
    const text = stringOption(value)
    if (!text) return undefined
    const seconds = Number(text)
    if (!Number.isSafeInteger(seconds) || seconds < 30 || seconds > 600) {
        throw new Error('--lifetime must be an integer between 30 and 600 seconds')
    }
    return seconds * 1_000
}

function parseMatrixLoginMode(
    value: unknown,
): 'required' | 'preferred' | 'disabled' {
    const mode = stringOption(value) ?? 'preferred'
    if (mode !== 'required' && mode !== 'preferred' && mode !== 'disabled') {
        throw new Error('--matrix-login must be required, preferred, or disabled')
    }
    return mode
}

function stringOption(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringArrayOption(value: unknown): string[] {
    if (value === undefined) return []
    const candidates = Array.isArray(value) ? value : [value]
    return candidates.map(candidate => {
        const parsed = stringOption(candidate)
        if (!parsed) throw new Error('--allow-executable requires a non-empty path')
        return parsed
    })
}

function identityOption(value: unknown, name: string): number | undefined {
    const text = stringOption(value)
    if (text === undefined) return undefined
    if (!/^\d+$/u.test(text)) throw new Error(`${name} must be a non-negative integer`)
    const parsed = Number(text)
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`${name} must be a non-negative integer`)
    }
    return parsed
}

function defaultGatewayAdminSocket(): string {
    if (process.platform === 'win32') return String.raw`\\.\pipe\codever-gateway-admin`
    return join(
        homedir(),
        '.config',
        'codever-rewrite-pwa',
        'gateway-data',
        'admin.sock',
    )
}

function formatGatewayCode(code: string): string {
    return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
