import type { Context } from 'grammy'
import type { SessionManager } from '@/bridge/sessionManager'
import { makeTopicKey } from '@/bridge/sessionManager'
import { config } from '@/config'
import { pairing } from '@/channel/telegram/pairing'
import { escapeHtml } from '@/utils/formatting'
import type { TopicSession } from '@/bridge/channelPort'
import { TelegramPort, type TableRecord } from '@/channel/telegram/telegramPort'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

/**
 * Pending cwd-create requests stored in memory.
 * keyed by a short id, value is the path to create.
 * This avoids encoding long paths in callback_data which
 * has a 64-byte Telegram limit.
 */
const pendingCwdCreates = new Map<string, string>()

/** Expose for callback handler to consume the stored path. */
export function consumePendingCwdPath(id: string): string | undefined {
    const path = pendingCwdCreates.get(id)
    if (path !== undefined) pendingCwdCreates.delete(id)
    return path
}

// Cleanup stale entries after 5 minutes
setInterval(() => {
    // Map is tiny, just clear entries older than 5 min via re-creation
    // (We don't track timestamps, so we clear all on each interval —
    // 5 min is generous; users will have long clicked or given up.)
    if (pendingCwdCreates.size > 10) {
        pendingCwdCreates.clear()
    }
}, 5 * 60 * 1000)

export interface GroupCommandContext {
    sessionManager: SessionManager
    topicSessions: Map<string, TopicSession>
    restart?: (chatId?: number) => Promise<void>
}

function formatElapsed(seconds: number): string {
    if (seconds < 60) return `${seconds}s`
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    if (m < 60) return `${m}m ${s}s`
    const h = Math.floor(m / 60)
    const rm = m % 60
    return `${h}h ${rm}m ${s}s`
}

export function registerGroupHandlers(bot: any, ctx: GroupCommandContext): void {
    const { sessionManager, topicSessions, restart } = ctx

    bot.command('cwd', async (c: Context) => {
        if (!c.chat || c.chat.type === 'private') {
            await c.reply('This command is for group chats only.')
            return
        }
        const userId = c.from!.id
        if (!pairing.isAuthorized(userId)) {
            await c.reply('❌ Unauthorized.')
            return
        }
        const messageThreadId = c.message?.message_thread_id
        const topicKey = makeTopicKey(c.chat.id, messageThreadId)
        let path = (c as any).match?.trim()
        if (!path) {
            const current = sessionManager.getGroupCwd(c.chat.id)
            await c.reply(current ? `Current cwd: <code>${current}</code>` : 'Usage: /cwd &lt;path&gt;', { parse_mode: 'HTML' })
            return
        }

        if (path.startsWith('~/')) {
            path = resolve(homedir(), path.slice(2))
        } else if (path === '~') {
            path = homedir()
        }

        if (!existsSync(path)) {
            // Store path in memory and use a short key in callback_data
            // to avoid exceeding Telegram's 64-byte callback_data limit
            const pendingId = randomUUID().slice(0, 8)
            pendingCwdCreates.set(pendingId, path)
            try {
                await c.reply(
                    `⚠️ Path does not exist: <code>${path}</code>\n\nDo you want to create it as a new project?`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '✅ Create', callback_data: `cwd_create:${pendingId}:${c.chat.id}:${messageThreadId ?? ''}` },
                                    { text: '❌ Cancel', callback_data: `cwd_cancel:${topicKey}` }
                                ]
                            ]
                        }
                    }
                )
            } catch (e) {
                // Inline keyboard failed (e.g. callback_data too long) —
                // fall back to plain text with /cwd --mkdir hint
                pendingCwdCreates.delete(pendingId)
                console.error('[/cwd] Failed to send create-prompt:', e instanceof Error ? e.message : e)
                await c.reply(
                    `⚠️ Path does not exist: <code>${path}</code>\n\nTo create it, run on your machine:\n<code>mkdir -p ${path}</code>\nThen retry /cwd.`,
                    { parse_mode: 'HTML' }
                ).catch(e => {
                    console.error('[/cwd] Failed to send fallback reply:', e instanceof Error ? e.message : e)
                })
            }
            return
        }

        sessionManager.setGroupCwd(c.chat.id, path)
        sessionManager.unarchiveGroup(topicKey)
        await c.reply(`✅ Working directory set to: <code>${path}</code>`, { parse_mode: 'HTML' })
    })

    bot.command('stop', async (c: Context) => {
        if (!c.chat || c.chat.type === 'private') return
        const messageThreadId = c.message?.message_thread_id
        const topicKey = makeTopicKey(c.chat.id, messageThreadId)
        console.error(`[codever] /stop: chatId=${c.chat.id} rawThreadId=${messageThreadId ?? 'none'} topicKey=${topicKey}`)

        const topicSession = topicSessions.get(topicKey)
        if (topicSession) {
            if (topicSession.state === 'querying' || topicSession.state === 'canceling') {
                try {
                    await topicSession.dispatch({ kind: 'cancel', reason: 'user', source: 'channel' })
                    await c.reply('⏹️ Interrupted. Next message will continue in the same conversation.')
                } catch (e) {
                    await c.reply('⏹️ Interrupt sent (query may have already finished).')
                }
            } else {
                await c.reply('No active query to interrupt.')
            }
            return
        }
        await c.reply('No active query to interrupt.')
    })

    bot.command('progress', async (c: Context) => {
        if (!c.chat || c.chat.type === 'private') return
        const messageThreadId = c.message?.message_thread_id
        const topicKey = makeTopicKey(c.chat.id, messageThreadId)

        const topicSession = topicSessions.get(topicKey)
        if (!topicSession) {
            await c.reply('✅ No active task')
            return
        }
        await topicSession.dispatch({ kind: 'command', name: 'progress', source: 'channel' })
    })

    bot.command(['new', 'reset'], async (c: Context) => {
        if (!c.chat || c.chat.type === 'private') return
        const messageThreadId = c.message?.message_thread_id
        const topicKey = makeTopicKey(c.chat.id, messageThreadId)

        const topicSession = topicSessions.get(topicKey)
        if (topicSession) {
            const prevSessionId = topicSession.queryLoop.conversationId
            const prevShortId = prevSessionId?.slice(0, 8)
            config.clearTopicConversation(topicKey)
            await topicSession.dispatch({ kind: 'command', name: 'new', source: 'channel' })
            if (prevShortId) {
                await c.reply(`🔄 Previous session <code>${prevShortId}</code> ended. New session created — send a message to start fresh.`, { parse_mode: 'HTML' })
            } else {
                await c.reply('🔄 Session reset. Send a message to start fresh.')
            }
            return
        }
        await c.reply('No active session. Send a message to start a new one.')
    })

    bot.command('archive', async (c: Context) => {
        if (!c.chat || c.chat.type === 'private') return
        const messageThreadId = c.message?.message_thread_id
        const topicKey = makeTopicKey(c.chat.id, messageThreadId)

        const topicSession = topicSessions.get(topicKey)
        if (topicSession) {
            await topicSession.dispatch({ kind: 'command', name: 'archive', source: 'channel' })
            topicSessions.delete(topicKey)
            sessionManager.removeSession(topicSession.queryLoop.id)
            sessionManager.archiveGroup(topicKey)
            await c.reply('📦 Session archived. Use /cwd to start a new session.')
            return
        }
        await c.reply('No active session.')
    })

    bot.command('tables', async (c: Context) => {
        if (!c.chat || c.chat.type === 'private') return
        const messageThreadId = c.message?.message_thread_id
        const topicKey = makeTopicKey(c.chat.id, messageThreadId)

        const topicSession = topicSessions.get(topicKey)
        if (!topicSession) {
            await c.reply('No active session.')
            return
        }

        const port = topicSession.channelPort
        if (!(port instanceof TelegramPort)) {
            await c.reply('❌ /tables is only supported in Telegram.')
            return
        }

        const tables = port.getRecentTables()
        if (tables.length === 0) {
            await c.reply('No tables have been rendered in this session since your last message.')
            return
        }

        for (let i = 0; i < tables.length; i++) {
            const label = tables.length === 1 ? '📊 **Table markdown:**' : `📊 **Table ${i + 1}/${tables.length}:**`
            const msg = `${label}\n\`\`\`\n${tables[i].markdown}\n\`\`\``
            await c.reply(msg, { parse_mode: 'Markdown' }).catch(() => {
                // Fallback to plain if markdown parse fails
                c.reply(`${label}\n${tables[i].markdown}`).catch(e => {
                    console.error('[/tables] Failed to send fallback reply:', e instanceof Error ? e.message : e)
                })
            })
        }
    })

    bot.command('restart', async (c: Context) => {
        if (!c.chat || c.chat.type === 'private') return
        const userId = c.from!.id
        if (!pairing.isAuthorized(userId)) {
            await c.reply('❌ Unauthorized.')
            return
        }
        if (!restart) {
            await c.reply('⚠️ Restart is not available.')
            return
        }
        const chatId = c.chat!.id
        // Send the "restarting" message and wait for it to be delivered
        // (with a timeout so we don't hang if the network is slow).
        // The restart function will kill the process, so we must ensure
        // the reply is sent before that happens.
        await Promise.race([
            c.reply('🔄 Restarting daemon...').catch(() => {}),
            new Promise(resolve => setTimeout(resolve, 2000))
        ])
        restart(chatId).catch((e) => {
            console.error('[/restart] restart() failed:', e instanceof Error ? e.message : e)
        })
    })

    bot.command('config', async (c: Context) => {
        if (!c.chat || c.chat.type === 'private') return
        const groupChatId = c.chat.id
        const messageThreadId = c.message?.message_thread_id
        const topicKey = makeTopicKey(groupChatId, messageThreadId)
        const topicSession = topicSessions.get(topicKey)
        const queryLoop = topicSession?.queryLoop
        const groupSettings = sessionManager.getGroupSettings(groupChatId)

        const text = c.message?.text?.trim() || ''
        const parts = text.split(/\s+/).slice(1)

        if (parts.length === 0) {
            const timeout = queryLoop?.timeoutSeconds ?? groupSettings?.timeoutSeconds ?? 180
            const verbose = queryLoop?.verboseLevel ?? groupSettings?.verboseLevel ?? 1
            const model = queryLoop?.model ?? groupSettings?.model ?? 'default'
            const provider = queryLoop?.providerName ?? groupSettings?.providerName ?? config.getDefaultProvider()
            const verboseLabels = ['Quiet', 'Normal', 'Verbose']
            const lines = [
                `<b>⚙️ Configuration</b>`,
                `  Timeout: <code>${timeout}s</code>`,
                `  Verbose: <code>${verboseLabels[verbose]}</code>`,
                `  Model: <code>${escapeHtml(model)}</code>`,
                `  Provider: <code>${escapeHtml(provider)}</code>`,
                '',
                '<i>Usage:</i>',
                '  /config timeout=120',
            ]
            await c.reply(lines.join('\n'), { parse_mode: 'HTML' })
            return
        }

        for (const part of parts) {
            const eqIdx = part.indexOf('=')
            if (eqIdx === -1) {
                await c.reply(`⚠️ Invalid format: <code>${escapeHtml(part)}</code>\nUse: /config key=value`, { parse_mode: 'HTML' })
                return
            }
            const key = part.slice(0, eqIdx).toLowerCase()
            const value = part.slice(eqIdx + 1)

            switch (key) {
                case 'timeout': {
                    const seconds = parseInt(value, 10)
                    if (isNaN(seconds) || seconds < 10 || seconds > 600) {
                        await c.reply('⚠️ Timeout must be between 10 and 600 seconds')
                        return
                    }
                    if (topicSession) await topicSession.dispatch({ kind: 'command', name: 'timeout', args: String(seconds), source: 'channel' })
                    sessionManager.setGroupSettings(groupChatId, { timeoutSeconds: seconds })
                    await c.reply(`✅ Timeout set to <b>${seconds}s</b>`, { parse_mode: 'HTML' })
                    break
                }
                default:
                    await c.reply(`⚠️ Unknown config key: <code>${escapeHtml(key)}</code>\nAvailable: timeout`, { parse_mode: 'HTML' })
                    return
            }
        }
    })
}
