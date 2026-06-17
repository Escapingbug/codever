import type { Context } from 'grammy'
import type { SessionManager } from '@/bridge/sessionManager'
import { isGenericTopic, makeTopicKey } from '@/bridge/sessionManager'
import { config } from '@/config'
import { getProvider, getDefaultProvider, listProviders } from '@/providers/registry'
import {
    modeKeyboard,
    modelKeyboard,
    modelProviderKeyboard,
    modelProviderDetailKeyboard,
    verboseKeyboard,
    providerKeyboard,
    resumeSessionKeyboard,
} from '@/channel/telegram/keyboard'
import type { SessionEntry } from '@/providers/provider'
import { escapeHtml } from '@/utils/formatting'
import type { TopicSession } from '@/bridge/channelPort'

export interface SettingsHandlerContext {
    sessionManager: SessionManager
    topicSessions: Map<string, TopicSession>
}

export function registerSettingsHandlers(bot: any, ctx: SettingsHandlerContext): void {
    const { sessionManager, topicSessions } = ctx

    bot.command('model', async (c: Context) => {
        if (!c.chat || c.chat.type === 'private') return
        const messageThreadId = c.message?.message_thread_id
        const topicKey = makeTopicKey(c.chat.id, messageThreadId)
        const topicSession = topicSessions.get(topicKey)
        const sessionRecord = topicSession?.sessionRecord
        const groupSettings = sessionManager.getGroupSettings(c.chat.id)
        const topicSettings = sessionManager.getTopicSettings(c.chat.id, messageThreadId)
        const genericTopic = isGenericTopic(messageThreadId)
        const providerName = genericTopic
            ? groupSettings?.providerName || config.getDefaultProvider()
            : sessionRecord?.providerName || topicSettings?.providerName || groupSettings?.providerName || config.getDefaultProvider()
        const provider = getProvider(providerName) ?? getDefaultProvider()
        const args = String((c as any).match ?? '').trim()

        if (args) {
            const modelToSet = args.toLowerCase()
            const models = provider.getAvailableModels()
            const found = models.find(m => m.id.toLowerCase() === modelToSet || m.name.toLowerCase() === modelToSet)
            if (!found) {
                const modelNames = models.map(m => m.id).join(', ')
                await c.reply(`Model "<b>${args}</b>" not found.\n\nAvailable: ${modelNames}`, { parse_mode: 'HTML' })
                return
            }
            if (topicSession) {
                await topicSession.dispatch({ kind: 'command', name: 'model', args: found.id, source: 'channel' })
            }
            const reasoningEffort = getDefaultReasoningEffort(found)
            if (topicSession) {
                await topicSession.dispatch({ kind: 'command', name: 'reasoningEffort', args: reasoningEffort, source: 'channel' })
            }
            if (genericTopic || topicSession) {
                sessionManager.setGroupSettings(c.chat.id, { model: found.id, reasoningEffort })
            } else {
                sessionManager.setTopicSettings(c.chat.id, messageThreadId, { model: found.id, reasoningEffort })
            }
            await c.reply(formatModelStatus(`Model set to: <b>${escapeHtml(found.id)}</b>`, reasoningEffort), { parse_mode: 'HTML' })
            return
        }

        const configuredCurrent = genericTopic
            ? groupSettings?.model || 'default'
            : sessionRecord?.model || topicSettings?.model || groupSettings?.model || 'default'
        const models = provider.getAvailableModels()
        const current = isSelectableModel(configuredCurrent, models) ? configuredCurrent : 'default'
        const currentReasoningEffort = getConfiguredReasoningEffort(genericTopic, sessionRecord, topicSettings, groupSettings)
        if (models.length === 0) {
            await c.reply(`${formatModelStatus(`Current model: <b>${escapeHtml(current)}</b>`, currentReasoningEffort)}\nNo models are available for provider <b>${escapeHtml(providerName)}</b>.`, {
                parse_mode: 'HTML',
            })
            return
        }
        await c.reply(`${formatModelStatus(`Current model: <b>${escapeHtml(current)}</b>`, currentReasoningEffort)}\nSelect a provider:`, {
            parse_mode: 'HTML',
            reply_markup: modelProviderKeyboard(models)
        })
    })

    bot.command('mode', async (c: Context) => {
        if (!c.chat || c.chat.type === 'private') return
        const messageThreadId = c.message?.message_thread_id
        const topicKey = makeTopicKey(c.chat.id, messageThreadId)
        const topicSession = topicSessions.get(topicKey)
        const sessionRecord = topicSession?.sessionRecord
        const groupSettings = sessionManager.getGroupSettings(c.chat.id)
        const current = (sessionRecord?.providerSettings?.permissionMode as string) || groupSettings?.permissionMode || 'default'
        const providerName = sessionRecord?.providerName || groupSettings?.providerName || config.getDefaultProvider()
        const provider = getProvider(providerName) ?? getDefaultProvider()
        const modes = provider.getAvailablePermissionModes()
        const codeverModes = ['approve-reads', 'approve-all', 'deny-all']
        const allModes = [...modes, ...codeverModes.filter(m => !modes.includes(m))]
        await c.reply(`Current mode: <b>${current}</b>\nSelect permission mode:`, {
            parse_mode: 'HTML',
            reply_markup: modeKeyboard(allModes)
        })
    })

    bot.command('verbose', async (c: Context) => {
        if (!c.chat || c.chat.type === 'private') return
        const messageThreadId = c.message?.message_thread_id
        const topicKey = makeTopicKey(c.chat.id, messageThreadId)
        const topicSession = topicSessions.get(topicKey)
        const sessionRecord = topicSession?.sessionRecord
        const groupSettings = sessionManager.getGroupSettings(c.chat.id)
        const labels = ['🔇 Quiet', '📊 Normal', '📢 Verbose']
        const current = sessionRecord?.verboseLevel ?? groupSettings?.verboseLevel ?? 1

        const args = String((c as any).match ?? '').trim()
        if (args) {
            const level = parseInt(args, 10)
            if (level !== 0 && level !== 1 && level !== 2) {
                await c.reply(`Invalid level "${args}". Use 0 (Quiet), 1 (Normal), or 2 (Verbose).`, { parse_mode: 'HTML' })
                return
            }
            if (sessionRecord) {
                sessionRecord.setVerboseLevel(level as 0 | 1 | 2)
            }
            sessionManager.setGroupSettings(c.chat.id, { verboseLevel: level as 0 | 1 | 2 })
            await c.reply(`✅ Verbose set to <b>${labels[level]}</b>`, { parse_mode: 'HTML' })
            return
        }

        await c.reply(`Verbose: <b>${labels[current]}</b>\nSelect level:`, {
            parse_mode: 'HTML',
            reply_markup: verboseKeyboard()
        })
    })

    bot.command('provider', async (c: Context) => {
        if (!c.chat || c.chat.type === 'private') return
        const messageThreadId = c.message?.message_thread_id
        const topicKey = makeTopicKey(c.chat.id, messageThreadId)
        const topicSession = topicSessions.get(topicKey)
        const sessionRecord = topicSession?.sessionRecord
        const groupSettings = sessionManager.getGroupSettings(c.chat.id)
        const topicSettings = sessionManager.getTopicSettings(c.chat.id, messageThreadId)
        const genericTopic = isGenericTopic(messageThreadId)
        const current = genericTopic
            ? groupSettings?.providerName || config.getDefaultProvider()
            : sessionRecord?.providerName || topicSettings?.providerName || groupSettings?.providerName || config.getDefaultProvider()
        const target = genericTopic ? 'new sessions' : topicSession ? 'this session' : 'this topic'
        const providers = listProviders()
        await c.reply(`Current provider: <b>${current}</b>\nSelect provider for ${target}:`, {
            parse_mode: 'HTML',
            reply_markup: providerKeyboard(providers, current)
        })
    })

    bot.command('timeout', async (c: Context) => {
        if (!c.chat || c.chat.type === 'private') return
        const messageThreadId = c.message?.message_thread_id
        const topicKey = makeTopicKey(c.chat.id, messageThreadId)
        const topicSession = topicSessions.get(topicKey)
        const sessionRecord = topicSession?.sessionRecord
        const groupSettings = sessionManager.getGroupSettings(c.chat.id)
        const current = sessionRecord?.timeoutSeconds ?? groupSettings?.timeoutSeconds ?? 180

        const args = String((c as any).match ?? '').trim()
        if (args) {
            const seconds = parseInt(args, 10)
            if (isNaN(seconds) || seconds < 10 || seconds > 600) {
                await c.reply(`⚠️ Timeout must be between 10 and 600 seconds`, { parse_mode: 'HTML' })
                return
            }
            if (sessionRecord) {
                sessionRecord.setTimeoutSeconds(seconds)
            }
            sessionManager.setGroupSettings(c.chat.id, { timeoutSeconds: seconds })
            await c.reply(`✅ Timeout set to <b>${seconds}s</b>`, { parse_mode: 'HTML' })
            return
        }

        await c.reply(`Timeout: <b>${current}s</b>\n\nUsage: /timeout 120\nRange: 10-600 seconds`, { parse_mode: 'HTML' })
    })

    bot.command(['session', 'sessions', 'session_list'], async (c: Context) => {
        if (!c.chat || c.chat.type === 'private') return
            await sendSessionList(c, c.chat.id, 0, sessionManager, topicSessions)
    })

    bot.command('resume', async (c: Context) => {
        if (!c.chat || c.chat.type === 'private') return
        const shortId = (c as any).match?.trim()
        const messageThreadId = c.message?.message_thread_id
        if (!shortId) {
        await sendSessionList(c, c.chat.id, 0, sessionManager, topicSessions)
            return
        }
        const cwd = getCwdForChat(c.chat.id, sessionManager)
        if (!cwd) {
            await c.reply('No working directory set. Use /cwd &lt;path&gt; first.', { parse_mode: 'HTML' })
            return
        }

        const groupSettings = sessionManager.getGroupSettings(c.chat.id)
        const providerName = groupSettings?.providerName || config.getDefaultProvider()
        const provider = getProvider(providerName)

        let sessionId: string | null = null
        if (provider?.listSessions) {
            const sessions = await provider.listSessions(cwd)
            const found = sessions.find(s => s.sessionId.startsWith(shortId))
            if (found) sessionId = found.sessionId
        }

        if (!sessionId) {
            await c.reply(`❌ Session <code>${shortId}</code> not found.`, { parse_mode: 'HTML' })
            return
        }
        await performResume(c, c.chat.id, sessionId, messageThreadId, sessionManager, topicSessions)
    })
}

function isSelectableModel(model: string, models: Array<{ id: string; name: string }>): boolean {
    if (model === 'default') return true
    if (models.length === 0) return false
    const normalized = model.toLowerCase()
    return models.some(entry => entry.id.toLowerCase() === normalized || entry.name.toLowerCase() === normalized)
}

export function getDefaultReasoningEffort(model: { defaultReasoningLevel?: string; supportedReasoningLevels?: Array<{ effort: string }> }): string | undefined {
    const levels = model.supportedReasoningLevels ?? []
    if (levels.length === 0) return undefined
    if (model.defaultReasoningLevel && levels.some(level => level.effort === model.defaultReasoningLevel)) {
        return model.defaultReasoningLevel
    }
    return levels[0]?.effort
}

function getConfiguredReasoningEffort(
    genericTopic: boolean,
    sessionRecord: TopicSession['sessionRecord'] | undefined,
    topicSettings: { reasoningEffort?: string } | undefined,
    groupSettings: { reasoningEffort?: string } | undefined,
): string | undefined {
    if (genericTopic) return groupSettings?.reasoningEffort
    const sessionReasoningEffort = sessionRecord?.providerSettings?.reasoningEffort
    if (typeof sessionReasoningEffort === 'string' && sessionReasoningEffort.trim()) {
        return sessionReasoningEffort
    }
    return topicSettings?.reasoningEffort ?? groupSettings?.reasoningEffort
}

function formatModelStatus(firstLine: string, reasoningEffort: string | undefined): string {
    return reasoningEffort
        ? `${firstLine}\nReasoning effort: <b>${escapeHtml(reasoningEffort)}</b>`
        : firstLine
}

export function getCwdForChat(chatId: number, sessionManager: SessionManager): string | undefined {
    const session = sessionManager.getSessionByGroup(chatId)
    if (session) return session.cwd
    return sessionManager.getGroupCwd(chatId)
}

export async function performResume(
    ctx: Context,
    chatId: number,
    sessionId: string,
    messageThreadId: number | undefined,
    sessionManager: SessionManager,
    topicSessions: Map<string, TopicSession>
): Promise<void> {
    const shortId = sessionId.slice(0, 8)
    const topicKey = makeTopicKey(chatId, messageThreadId)
    const topicSession = topicSessions.get(topicKey)
    if (topicSession) {
        await topicSession.dispatch({ kind: 'command', name: 'resume', args: sessionId, source: 'channel' })
    }
    config.saveTopicState(topicKey, { conversationId: sessionId })
    await ctx.reply(`🔄 Resuming session <code>${shortId}</code>. Send a message to continue.`, { parse_mode: 'HTML' })
}

export async function sendSessionList(
    ctx: Context,
    chatId: number,
    page: number,
    sessionManager: SessionManager,
    topicSessions: Map<string, TopicSession>
): Promise<void> {
    const cwd = getCwdForChat(chatId, sessionManager)
    if (!cwd) {
        await ctx.reply('No working directory set. Use /cwd &lt;path&gt; first.', { parse_mode: 'HTML' })
        return
    }

    const groupSettings = sessionManager.getGroupSettings(chatId)
    const providerName = groupSettings?.providerName || config.getDefaultProvider()
    const provider = getProvider(providerName)

    let entries: SessionEntry[] = []
    let total = 0
    let totalPages = 1

    if (provider?.listSessions) {
        const sessions = await provider.listSessions(cwd)
        entries = sessions.map(s => ({
            sessionId: s.sessionId,
            title: s.title,
            updated: s.updated,
            cwd: cwd,
        }))
        total = entries.length
        totalPages = Math.max(1, Math.ceil(total / 5))
    }

    if (total === 0) {
        await ctx.reply(`No sessions found for this project with provider <b>${providerName}</b>.`, { parse_mode: 'HTML' })
        return
    }

    const start = page * 5
    const pageEntries = entries.slice(start, start + 5)

    const header = `📋 <b>Sessions</b> (${providerName}, ${page + 1}/${totalPages}, ${total} total)\nClick to resume:\n`
    const kb = resumeSessionKeyboard(pageEntries as any, page, totalPages)
    await ctx.reply(header, {
        parse_mode: 'HTML',
        reply_markup: kb
    })
}
