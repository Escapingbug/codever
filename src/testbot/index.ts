import { Bot } from 'grammy'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { GroupLogger } from '@/utils/groupLogger'

export interface TestBotConfig {
    token: string
    logDir?: string
}

interface LogEntry {
    time: string
    direction: 'IN' | 'OUT'
    from: string
    chatId: number
    chat: string
    text: string
    extra?: Record<string, unknown>
}

type ResponseWaiter = {
    chatId: number
    resolve: (entries: LogEntry[]) => void
    timeout: ReturnType<typeof setTimeout>
    predicate?: (entries: LogEntry[]) => boolean
    since: number
}

const logs: LogEntry[] = []
const waiters: ResponseWaiter[] = []

function ts(): string {
    return new Date().toISOString().slice(11, 23)
}

function chatLabel(chat: { id: number; title?: string; type?: string }): string {
    const title = chat.title ?? 'DM'
    return `${title}(${chat.id})`
}

function userLabel(user: { id: number; username?: string; first_name?: string }): string {
    return user.username ? `@${user.username}` : `${user.first_name ?? ''}(${user.id})`
}

function truncate(s: string, max = 4000): string {
    return s.length > max ? s.slice(0, max) + `... (${s.length} chars)` : s
}

function formatEntry(entry: LogEntry): string {
    const tag = entry.direction === 'OUT' ? 'BOT' : 'USER'
    let line = `[${entry.time}] [${tag}] ${entry.from} @ ${entry.chat}\n  ${entry.text}`
    if (entry.extra) {
        line += `\n  extra: ${JSON.stringify(entry.extra)}`
    }
    return line
}

function notifyWaiters(entry: LogEntry): void {
    for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i]
        if (w.chatId !== entry.chatId) continue
        const chatLogs = logs.filter(l => l.chatId === w.chatId)
        if (w.predicate && w.predicate(chatLogs)) {
            clearTimeout(w.timeout)
            waiters.splice(i, 1)
            w.resolve(chatLogs)
        }
    }
}

export function createTestBot(config: TestBotConfig): Bot {
    const bot = new Bot(config.token)

    const baseDir = config.logDir ?? join(homedir(), '.config', 'codever')
    const logger = new GroupLogger(baseDir, 'testbot')

    bot.on('message:text', async (ctx) => {
        const msg = ctx.message
        const chat = ctx.chat
        const from = msg.from
        if (!from) return

        const chatStr = chatLabel(chat)
        const fromStr = userLabel(from)
        const isBot = from.is_bot
        const direction = isBot ? 'OUT' : 'IN'
        const text = msg.text
        const threadId = msg.message_thread_id

        const entry: LogEntry = {
            time: ts(),
            direction,
            from: fromStr + (isBot ? ' [BOT]' : ''),
            chatId: chat.id,
            chat: chatStr,
            text,
        }
        if (threadId) entry.extra = { threadId }
        if (msg.reply_to_message) entry.extra = { ...(entry.extra ?? {}), replyTo: msg.reply_to_message.message_id }

        logs.push(entry)

        const tag = isBot ? 'BOT' : 'USER'
        const logLine = `[${tag}] ${fromStr}: ${text}`
        logger.group(chat.id, logLine)

        console.log(formatEntry(entry))
        console.log()

        if (isBot) {
            notifyWaiters(entry)
        }
    })

    bot.on('edited_message:text', async (ctx) => {
        const msg = ctx.editedMessage
        const chat = msg.chat
        const from = msg.from
        if (!from || !msg.text) return

        const entry: LogEntry = {
            time: ts(),
            direction: from.is_bot ? 'OUT' : 'IN',
            from: userLabel(from) + (from.is_bot ? ' [BOT]' : '') + ' [EDITED]',
            chatId: chat.id,
            chat: chatLabel(chat),
            text: msg.text,
            extra: { editDate: msg.edit_date },
        }
        logs.push(entry)

        logger.group(chat.id, `[EDITED] ${userLabel(from)}: ${msg.text}`)

        console.log(formatEntry(entry))
        console.log()

        if (from.is_bot) {
            notifyWaiters(entry)
        }
    })

    bot.command('testlog', async (ctx) => {
        const chatId = ctx.chat.id
        const recent = logs.filter(l => l.chatId === chatId).slice(-50)

        if (recent.length === 0) {
            await ctx.reply('No logged messages in this chat yet.')
            return
        }

        const lines = recent.map(l => {
            const tag = l.direction === 'OUT' ? 'BOT' : 'USER'
            return `[${l.time}] [${tag}] ${l.from}: ${truncate(l.text, 120)}`
        })

        const full = lines.join('\n')
        const chunks = splitMessage(full, 4000)
        for (const chunk of chunks) {
            await ctx.reply(chunk).catch(() => {})
        }
    })

    bot.command('testlast', async (ctx) => {
        const recent = logs.slice(-20)
        if (recent.length === 0) {
            await ctx.reply('No messages yet.')
            return
        }

        const lines = recent.map(l => {
            const tag = l.direction === 'OUT' ? 'BOT' : 'USER'
            return `[${l.time}] [${tag}] ${l.from}\n  ${truncate(l.text, 200)}`
        })

        await ctx.reply(lines.join('\n\n')).catch(() => {})
    })

    bot.command('testcount', async (ctx) => {
        const chatId = ctx.chat.id
        const chatLogs = logs.filter(l => l.chatId === chatId)
        const inCount = chatLogs.filter(l => l.direction === 'IN').length
        const outCount = chatLogs.filter(l => l.direction === 'OUT').length
        await ctx.reply(`Messages in this chat:\n  User: ${inCount}\n  Bot: ${outCount}\n  Total: ${chatLogs.length}`)
    })

    bot.command('testclear', async (ctx) => {
        const chatId = ctx.chat.id
        for (let i = logs.length - 1; i >= 0; i--) {
            if (logs[i].chatId === chatId) logs.splice(i, 1)
        }
        await ctx.reply('Logs cleared for this chat.')
    })

    bot.command('testpath', async (ctx) => {
        const chatId = ctx.chat.id
        await ctx.reply(
            `Global log: ${logger.globalLogPath}\n` +
            `This chat: ${logger.getGroupLogPath(chatId)}`
        ).catch(() => {})
    })

    bot.command('testdump', async (ctx) => {
        const chatId = ctx.chat.id
        const chatLogs = logs.filter(l => l.chatId === chatId)
        if (chatLogs.length === 0) {
            await ctx.reply('No logs for this chat.').catch(() => {})
            return
        }

        const content = chatLogs.map(formatEntry).join('\n---\n')
        const chunks = splitMessage(content, 4000)
        for (const chunk of chunks) {
            await ctx.reply(chunk).catch(() => {})
        }
    })

    bot.command('testhelp', async (ctx) => {
        await ctx.reply(
            `Test Bot Commands\n\n` +
            `/testlog — Last 50 messages (this chat, compact)\n` +
            `/testdump — Full dump (this chat, verbose)\n` +
            `/testlast — Last 20 messages (all chats)\n` +
            `/testcount — Message counts (this chat)\n` +
            `/testpath — Show log file paths\n` +
            `/testclear — Clear logs (this chat)\n` +
            `/testhelp — This message\n\n` +
            `Log dir: ${logger.baseDir}\n` +
            `  global.log — startup / non-group messages\n` +
            `  groups/<chatId>/session.log — per-group messages`,
        )
    })

    bot.catch((err) => {
        console.error('[testbot error]', err)
        logger.global(`[ERROR] ${String(err)}`)
    })

    return bot
}

function splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text]
    const chunks: string[] = []
    let remaining = text
    while (remaining.length > 0) {
        let splitAt = maxLen
        if (remaining.length > maxLen) {
            const lastNewline = remaining.lastIndexOf('\n', maxLen)
            if (lastNewline > maxLen * 0.5) splitAt = lastNewline + 1
        }
        chunks.push(remaining.slice(0, splitAt))
        remaining = remaining.slice(splitAt)
    }
    return chunks
}

export async function startTestBot(token: string, logDir?: string): Promise<void> {
    const bot = createTestBot({ token, logDir })

    console.log('[testbot] Starting test listener bot...')

    const me = await bot.api.getMe()
    console.log(`[testbot] Connected as @${me.username} (${me.first_name}, ID: ${me.id})`)
    console.log('[testbot] Add this bot to the same group as the project bot.')
    console.log('[testbot] It will silently log all messages per-group to file and console.')
    console.log('[testbot] Use /testhelp for commands.')
    console.log()

    await bot.start({
        onStart: () => {
            console.log('[testbot] Polling started.')
        },
    })
}

export interface TestBotClient {
    sendToChat(chatId: number, text: string): Promise<void>
    waitForBotResponses(chatId: number, options?: {
        timeoutMs?: number
        predicate?: (entries: LogEntry[]) => boolean
        minResponses?: number
    }): Promise<LogEntry[]>
    getChatLogs(chatId: number): LogEntry[]
    clearChatLogs(chatId: number): void
    waitForDaemonLog(chatId: number, options: {
        logDir: string
        predicate: (lines: string[]) => boolean
        timeoutMs?: number
    }): Promise<string[]>
    bot: Bot
    botInfo: { id: number; username: string; firstName: string }
}

export async function createTestBotClient(config: TestBotConfig): Promise<TestBotClient> {
    const bot = createTestBot(config)
    const me = await bot.api.getMe()

    const started = new Promise<void>((resolve, reject) => {
        bot.start({
            onStart: () => {
                console.log(`[testbot-client] Started as @${me.username} (ID: ${me.id})`)
                resolve()
            },
        }).catch(reject)
    })

    await started

    return {
        bot,
        botInfo: { id: me.id, username: me.username ?? 'testbot', firstName: me.first_name },

        async sendToChat(chatId: number, text: string): Promise<void> {
            await bot.api.sendMessage(chatId, text)
        },

        waitForBotResponses(chatId: number, options?: {
            timeoutMs?: number
            predicate?: (entries: LogEntry[]) => boolean
            minResponses?: number
        }): Promise<LogEntry[]> {
            const timeoutMs = options?.timeoutMs ?? 120_000
            const minResponses = options?.minResponses ?? 1
            const predicate = options?.predicate

            const startIndex = logs.length

            return new Promise<LogEntry[]>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    const idx = waiters.findIndex(w => w.chatId === chatId && w.resolve === resolve)
                    if (idx !== -1) waiters.splice(idx, 1)
                    const chatLogs = logs.filter(l => l.chatId === chatId && logs.indexOf(l) >= startIndex)
                    reject(new Error(
                        `Timeout after ${timeoutMs}ms waiting for ${minResponses} bot responses in chat ${chatId}. ` +
                        `Got ${chatLogs.filter(l => l.direction === 'OUT').length} responses. ` +
                        `Last 5 entries: ${chatLogs.slice(-5).map(l => `[${l.direction}] ${l.text.slice(0, 80)}`).join(' | ')}`
                    ))
                }, timeoutMs)

                const effectivePredicate = predicate ?? ((entries: LogEntry[]) => {
                    const newBotEntries = entries.filter(l => l.direction === 'OUT' && logs.indexOf(l) >= startIndex)
                    return newBotEntries.length >= minResponses
                })

                const chatLogs = logs.filter(l => l.chatId === chatId)
                if (effectivePredicate(chatLogs)) {
                    clearTimeout(timeout)
                    resolve(chatLogs)
                    return
                }

                waiters.push({
                    chatId,
                    resolve,
                    timeout,
                    predicate: effectivePredicate,
                    since: startIndex,
                })
            })
        },

        getChatLogs(chatId: number): LogEntry[] {
            return logs.filter(l => l.chatId === chatId)
        },

        clearChatLogs(chatId: number): void {
            for (let i = logs.length - 1; i >= 0; i--) {
                if (logs[i].chatId === chatId) logs.splice(i, 1)
            }
        },
    }
}

export function readGroupLogFile(logDir: string, chatId: number): string[] {
    const logPath = join(logDir, 'logs', 'testbot', 'groups', String(chatId), 'session.log')
    if (!existsSync(logPath)) return []
    return readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
}

export type { LogEntry }
