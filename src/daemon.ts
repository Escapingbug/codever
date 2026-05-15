import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { config, getDaemonPidPath, getDaemonBaseDir } from './config'
import { registerProvider, listProviders, getProvider } from './providers/registry'

import { AgentProvider } from './providers/agent'
import { CodebuddyProvider } from './providers/codebuddy'
import { OpencodeProvider } from './providers/opencode'
import { createBot } from './channel/telegram/bot'
import { SessionManager, makeTopicKey } from './bridge/sessionManager'
import { createTopicSession } from './bridge/topicSession'
import { Scheduler } from './core/scheduler'
import { startDaemonApi, type ScheduleRequest, type SendFileRequest, type SendRequest } from './daemon/api'
import { ensureDaemonPath, resolveNodePath } from './utils/nodePath'
import { GroupLogger } from './utils/groupLogger'

let logger: GroupLogger

async function main() {
    ensureDaemonPath()

    const baseDir = getDaemonBaseDir()
    logger = new GroupLogger(baseDir, 'daemon')

    const origStdout = process.stdout.write.bind(process.stdout)
    const origStderr = process.stderr.write.bind(process.stderr)

    process.stdout.write = (chunk: any, ...args: any[]) => {
        const str = typeof chunk === 'string' ? chunk : chunk.toString()
        logger.global(str.trimEnd())
        origStdout(chunk, ...args)
        return true
    }
    process.stderr.write = (chunk: any, ...args: any[]) => {
        const str = typeof chunk === 'string' ? chunk : chunk.toString()
        logger.global(str.trimEnd())
        origStderr(chunk, ...args)
        return true
    }

    console.log('[daemon] Starting codever daemon...')
    console.log(`[daemon] Global log: ${logger.globalLogPath}`)
    console.log(`[daemon] NODE_PATH=${process.env.CODEVER_NODE_PATH || '(not set)'}`)
    console.log(`[daemon] CLAUDE_PATH=${process.env.CODEVER_CLAUDE_PATH || '(not set)'}`)
    console.log(`[daemon] PATH=${process.env.PATH}`)

    const opencodeProvider = new OpencodeProvider()
    const codebuddyProvider = new CodebuddyProvider()
    const agentProvider = new AgentProvider()
    registerProvider(opencodeProvider, () => new OpencodeProvider())
    registerProvider(codebuddyProvider, () => new CodebuddyProvider())
    registerProvider(agentProvider, () => new AgentProvider())

    const initProviders = async () => {
        for (const name of listProviders()) {
            const p = getProvider(name)!
            if ('init' in p && typeof (p as any).init === 'function') {
                try {
                    await (p as any).init()
                } catch (e) {
                    console.error(`[daemon] Provider "${name}" init failed: ${e instanceof Error ? e.message : e}`)
                }
            }
        }
        for (const name of listProviders()) {
            const p = getProvider(name)!
            if (p.isReady()) {
                console.log(`[daemon] Provider "${name}": ready`)
            } else {
                console.warn(`[daemon] Provider "${name}": NOT READY (${p.getInitError() ?? 'init pending'})`)
            }
        }
    }
    void initProviders()

    const sessionManager = new SessionManager()
    sessionManager.loadPersistedState()

    const eventBus = new (await import('./core/eventBus.js')).DefaultEventBus()
    sessionManager.setEventBus(eventBus)

    // --- Scheduler: handles timed reminders ---

    const persistTasks = () => {
        config.saveScheduledTasks(scheduler.saveTasks())
    }

    const scheduler = new Scheduler({
        onTrigger: (task) => {
            console.log(`[daemon] Scheduler trigger: task=${task.id.slice(0, 8)} topicKey=${task.topicKey} message="${task.message.slice(0, 50)}"`)

            // Look up the TopicSession by topicKey
            const topicSession = sessionManager.getTopicSession(task.topicKey)
            if (!topicSession) {
                console.warn(`[daemon] Scheduler: no topic session found for topicKey=${task.topicKey}, skipping`)
                persistTasks()
                return
            }

            topicSession.receiveInput({ text: task.message, username: 'reminder' })
            persistTasks()
        },
    })

    // Load persisted tasks (past-due tasks fire immediately)
    const savedTasks = config.getScheduledTasks()
    if (savedTasks.length > 0) {
        scheduler.loadTasks(savedTasks)
        console.log(`[daemon] Loaded ${savedTasks.length} scheduled tasks`)
    }

    // --- Daemon Internal API: IPC bridge for MCP subprocess ---

    const daemonApi = await startDaemonApi({
        onSchedule: (req: ScheduleRequest) => {
            // Store topicKey as sessionId for scheduled tasks
            const topicKey = req.sessionId

            const task = scheduler.schedule({
                topicKey: topicKey,
                triggerAt: req.triggerAt,
                message: req.message,
                context: req.context,
                ...(req.recurringMs ? { recurringMs: req.recurringMs } : {}),
            })
            persistTasks()
            console.log(`[daemon] Scheduled task ${task.id.slice(0, 8)} for topicKey ${topicKey} at ${new Date(req.triggerAt).toISOString()}`)
            return { taskId: task.id }
        },
        onCancel: (req) => {
            scheduler.cancel(req.taskId)
            persistTasks()
            console.log(`[daemon] Cancelled task ${req.taskId.slice(0, 8)}`)
        },
        onSend: (req: SendRequest) => {
            // Find the topic session
            let topicSession = sessionManager.getTopicSessionByConversationId(req.sessionId)
            if (!topicSession) {
                const sessionRecord = sessionManager.getSession(req.sessionId)
                if (sessionRecord) {
                    topicSession = sessionManager.getTopicSessionBySessionId(sessionRecord.id)
                }
            }
            if (topicSession) {
                topicSession.receiveInput({ text: req.message, username: 'system' })
                console.log(`[daemon] Sent message to session ${req.sessionId.slice(0, 8)}: "${req.message.slice(0, 50)}"`)
            } else {
                console.warn(`[daemon] Send: no topic session found for ${req.sessionId.slice(0, 8)}`)
            }
        },
        onSendFile: (req: SendFileRequest) => {
            let topicSession = sessionManager.getTopicSessionByConversationId(req.sessionId)
            if (!topicSession) {
                const sessionRecord = sessionManager.getSession(req.sessionId)
                if (sessionRecord) {
                    topicSession = sessionManager.getTopicSessionBySessionId(sessionRecord.id)
                }
            }
            if (topicSession) {
                void topicSession.dispatch({
                    kind: 'command',
                    name: 'send_file',
                    args: JSON.stringify({
                        path: req.path,
                        ...(req.caption ? { caption: req.caption } : {}),
                        ...(req.filename ? { filename: req.filename } : {}),
                        ...(req.type ? { type: req.type } : {}),
                        ...(req.language ? { language: req.language } : {}),
                    }),
                    source: 'mcp',
                })
                console.log(`[daemon] Sent file to session ${req.sessionId.slice(0, 8)}: "${req.path}"`)
            } else {
                console.warn(`[daemon] Send file: no topic session found for ${req.sessionId.slice(0, 8)}`)
            }
        },
    })

    // Write API port to well-known file for MCP subprocess discovery
    const apiPortFile = join(baseDir, 'daemon.api.port')
    mkdirSync(dirname(apiPortFile), { recursive: true })
    writeFileSync(apiPortFile, daemonApi.port.toString())
    console.log(`[daemon] Daemon API port ${daemonApi.port} written to ${apiPortFile}`)

    const botToken = config.getBotToken()
    if (!botToken) {
        console.error('[daemon] No bot token configured. Run: codever config set-bot-token <token>')
        process.exit(1)
    }

    let restartFn: ((chatId?: number) => Promise<void>) | undefined
    const bot = createBot({ sessionManager, processCwd: process.cwd(), logger, restart: async (chatId?: number) => { await restartFn!(chatId) } })

    const botPolling = bot.start({
        onStart: () => {
            console.log('[daemon] Telegram bot polling started')
        }
    })

    botPolling.catch((e) => {
        console.error('[daemon] Bot polling error:', e)
    })

    // If this daemon was spawned by a restart, notify the user immediately.
    const restartChatId = process.env.CODEVER_RESTART_CHAT_ID
    if (restartChatId) {
        delete process.env.CODEVER_RESTART_CHAT_ID
        const sendRestartNotification = async (attempt = 0): Promise<void> => {
            try {
                await bot.api.sendMessage(restartChatId, '✅ Daemon restarted successfully.')
                console.log('[daemon] Restart notification sent')
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e)
                console.warn(`[daemon] Failed to send restart notification (attempt ${attempt + 1}): ${msg}`)
                if (attempt < 3) {
                    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
                    return sendRestartNotification(attempt + 1)
                }
                console.error('[daemon] Giving up on restart notification after 4 attempts')
            }
        }
        void sendRestartNotification()
    }

    const pidPath = getDaemonPidPath()
    mkdirSync(dirname(pidPath), { recursive: true })
    writeFileSync(pidPath, process.pid.toString())
    console.log(`[daemon] PID ${process.pid} written to ${pidPath}`)

    const cleanup = async () => {
        console.log('[daemon] Shutting down...')
        try { await bot.stop() } catch {}

        // Persist and stop all scheduled tasks
        persistTasks()
        scheduler.stopAll()

        daemonApi.stop()

        for (const topicSession of Array.from(sessionManager.getTopicSessionsMap().values())) {
            try { await topicSession.destroy() } catch (e) {
                console.error(`[daemon] Failed to destroy topic session: ${e instanceof Error ? e.message : e}`)
            }
        }

        // NOTE: We intentionally do NOT clear conversationId for mid-query sessions.
        // The agent (opencode/codebuddy) persists session data to disk (e.g. SQLite).
        // resumeSession can safely restore a session even after an interrupted query —
        // the agent discards the incomplete turn and continues from the last completed state.
        // Clearing conversationId would make recovery impossible, turning a recoverable
        // session into a lost one (agent sees it as a brand-new conversation).

        // Clear any stale queryInProgress flags for idle sessions.
        // These can remain if the process was previously killed (SIGKILL) before
        // the query.completed event could clear them. On next startup they would
        // prevent session resumption, so we clean them up on graceful shutdown.
        for (const sessionRecord of sessionManager.listActiveSessions()) {
            if (sessionRecord.groupChatId !== null) {
                const topicKey = makeTopicKey(sessionRecord.groupChatId, sessionRecord.messageThreadId ?? undefined)
                const topicState = config.getTopicState(topicKey)
                if (topicState?.queryInProgress) {
                    console.error(`[daemon] Clearing stale queryInProgress for idle session ${sessionRecord.id.slice(0, 8)} topicKey=${topicKey}`)
                    config.clearTopicQueryInProgress(topicKey)
                }
            }
        }

        // Clean up API port file
        try { unlinkSync(apiPortFile) } catch {}
        try { unlinkSync(pidPath) } catch {}
        logger.close()
        console.log('[daemon] Cleanup complete')
    }

    const restart = async (chatId?: number) => {
        console.log('[daemon] Restarting...')
        await cleanup()

        const nodePath = process.env.CODEVER_NODE_PATH || resolveNodePath()
        const daemonScript = process.argv[1]
        const env = { ...process.env }
        if (chatId) {
            env.CODEVER_RESTART_CHAT_ID = chatId.toString()
        }
        console.log(`[daemon] Spawning new daemon: ${nodePath} ${daemonScript}`)

        const child = spawn(nodePath, [daemonScript], {
            detached: true,
            stdio: 'ignore',
            env
        })

        child.on('error', (err) => {
            console.error(`[daemon] Failed to spawn new daemon: ${err.message}`)
        })

        await new Promise<void>((resolve) => {
            child.on('spawn', () => {
                console.log('[daemon] New daemon process spawned')
                resolve()
            })
            child.on('error', () => {
                resolve()
            })
            setTimeout(resolve, 3000)
        })

        child.unref()
        process.exit(0)
    }

    process.on('SIGTERM', async () => { await cleanup(); process.exit(0) })
    process.on('SIGINT', async () => { await cleanup(); process.exit(0) })

    restartFn = restart

    console.log('[daemon] Ready and waiting for Telegram messages')
}

main().catch((e) => {
    console.error('[daemon] Fatal error:', e)
    process.exit(1)
})

process.on('uncaughtException', (e) => {
    console.error('[daemon] UNCAUGHT EXCEPTION:', e)
})

process.on('unhandledRejection', (reason) => {
    console.error('[daemon] UNHANDLED REJECTION:', reason)
})

export { logger }
