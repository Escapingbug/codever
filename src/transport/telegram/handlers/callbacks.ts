import type { Context } from 'grammy'
import type { SessionManager } from '@/bridge/sessionManager'
import { makeTopicKey } from '@/bridge/sessionManager'
import { config } from '@/config'
import { getProvider, getDefaultProvider } from '@/providers/registry'
import {
    modelKeyboard,
    modelProviderKeyboard,
    modelProviderDetailKeyboard,
    resumeSessionKeyboard,
    timeoutKeyboard,
} from '@/transport/telegram/keyboard'
import { escapeHtml } from '@/utils/formatting'
import type { TopicSession } from '@/bridge/channelPort'
import { getCwdForChat, performResume, sendSessionList } from './settings'
import { consumePendingCwdPath } from './groupCommands'
import { mkdirSync } from 'node:fs'

export interface CallbackHandlerContext {
    sessionManager: SessionManager
    topicSessions: Map<string, TopicSession>
}

export function registerCallbackHandlers(bot: any, ctx: CallbackHandlerContext): void {
    const { sessionManager, topicSessions } = ctx

    bot.on('callback_query:data', async (c: Context) => {
        if (!c.callbackQuery) return
        const data = c.callbackQuery.data
        if (!data) return

        if (data.startsWith('perm:')) {
            await handlePermissionCallback(c, data, sessionManager)
            return
        }

        if (data.startsWith('ask:')) {
            await handleAskCallback(c, data, sessionManager)
            return
        }

        if (data.startsWith('model:')) {
            await handleModelCallback(c, data, sessionManager, topicSessions)
            return
        }

        if (data.startsWith('mlist:')) {
            await handleModelListCallback(c, data, sessionManager, topicSessions)
            return
        }

        if (data.startsWith('mprov:')) {
            await handleModelProviderCallback(c, data, sessionManager, topicSessions)
            return
        }

        if (data.startsWith('mprovpage:')) {
            await handleModelProviderPageCallback(c, data, sessionManager, topicSessions)
            return
        }

        if (data.startsWith('timeout:')) {
            await handleTimeoutCallback(c, data, sessionManager, topicSessions)
            return
        }

        if (data.startsWith('verbose:')) {
            await handleVerboseCallback(c, data, sessionManager, topicSessions)
            return
        }

        if (data.startsWith('mode:')) {
            await handleModeCallback(c, data, sessionManager, topicSessions)
            return
        }

        if (data.startsWith('cres:')) {
            await handleResumeCallback(c, data, sessionManager, topicSessions)
            return
        }

        if (data.startsWith('crlist:')) {
            await handleResumeListCallback(c, data, sessionManager, topicSessions)
            return
        }

        if (data.startsWith('crdet:')) {
            await handleResumeDetailCallback(c, data, sessionManager)
            return
        }

        if (data.startsWith('provider:')) {
            await handleProviderCallback(c, data, sessionManager, topicSessions)
            return
        }

        if (data.startsWith('cwd_create:')) {
            await handleCwdCreateCallback(c, data, sessionManager)
            return
        }

        if (data.startsWith('cwd_cancel:')) {
            await c.answerCallbackQuery('Cancelled')
            try { await c.editMessageText('❌ Cancelled', { parse_mode: 'HTML' }) } catch {}
            return
        }

        await c.answerCallbackQuery()
    })
}

async function handlePermissionCallback(c: Context, data: string, sessionManager: SessionManager): Promise<void> {
    const parts = data.split(':')
    const action = parts[1] as 'allow' | 'session' | 'deny'
    const requestId = parts[2]

    const queryLoop = sessionManager.getSessionForPermission(requestId)
    if (queryLoop) {
        const decision = action === 'deny' ? 'deny' as const : 'allow' as const
        const handled = queryLoop.resolvePermission(requestId, decision)
        if (handled) {
            sessionManager.removePermission(requestId)
            const label = action === 'deny' ? '❌ Denied' : '✅ Allowed'
            await c.answerCallbackQuery(label)
            try { await c.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }) } catch {}
        } else {
            await c.answerCallbackQuery('Request expired or already handled')
        }
        return
    }

    await c.answerCallbackQuery('Request expired or already handled')
}

async function handleAskCallback(c: Context, data: string, sessionManager: SessionManager): Promise<void> {
    // AskUserQuestion callbacks are handled via the permission handler
    // This is a legacy path that should not be reached with CoreSession
    await c.answerCallbackQuery('Not supported in this session type')
}

async function handleModelCallback(c: Context, data: string, sessionManager: SessionManager, topicSessions: Map<string, TopicSession>): Promise<void> {
    const model = data.split(':')[1]
    if (!c.callbackQuery) return
    const chatId = c.callbackQuery.message?.chat.id
    const messageThreadId = c.callbackQuery.message?.message_thread_id
    if (!chatId) {
        await c.answerCallbackQuery('Error')
        return
    }
    const topicKey = makeTopicKey(chatId, messageThreadId)
    const topicSession = topicSessions.get(topicKey)
    const queryLoop = topicSession?.queryLoop

    if (queryLoop) {
        queryLoop.setModel(model)
    }
    sessionManager.setGroupSettings(chatId, { model })
    const providerName = queryLoop?.providerName || sessionManager.getGroupSettings(chatId)?.providerName || config.getDefaultProvider()
    const provider = getProvider(providerName) ?? getDefaultProvider()
    const modelEntry = provider.getAvailableModels().find(m => m.id === model)
    const displayName = modelEntry?.name || model
    await c.answerCallbackQuery(`Model set to ${displayName}`)
    try { await c.editMessageText(`✅ Model set to <b>${displayName}</b>`, { parse_mode: 'HTML' }) } catch {}
}

async function handleModelListCallback(c: Context, data: string, sessionManager: SessionManager, topicSessions: Map<string, TopicSession>): Promise<void> {
    const page = parseInt(data.split(':')[1], 10)
    if (!c.callbackQuery) return
    const chatId = c.callbackQuery.message?.chat.id
    const messageThreadId = c.callbackQuery.message?.message_thread_id
    if (!chatId) return

    const groupSettings = sessionManager.getGroupSettings(chatId)
    const providerName = groupSettings?.providerName || config.getDefaultProvider()
    const provider = getProvider(providerName) ?? getDefaultProvider()
    const models = provider.getAvailableModels()
    const totalPages = Math.ceil(models.length / 10)
    const header = `Select a model (page ${page + 1}/${totalPages}):`
    try {
        await c.editMessageText(header, {
            parse_mode: 'HTML',
            reply_markup: modelKeyboard(models, page)
        })
    } catch {}
    await c.answerCallbackQuery()
}

async function handleModelProviderCallback(c: Context, data: string, sessionManager: SessionManager, topicSessions: Map<string, TopicSession>): Promise<void> {
    const provider = data.split(':')[1]
    if (!c.callbackQuery) return
    const chatId = c.callbackQuery.message?.chat.id
    const messageThreadId = c.callbackQuery.message?.message_thread_id
    if (!chatId) return

    const groupSettings = sessionManager.getGroupSettings(chatId)
    const providerName = groupSettings?.providerName || config.getDefaultProvider()
    const agentProvider = getProvider(providerName) ?? getDefaultProvider()
    const models = agentProvider.getAvailableModels()

    if (provider === 'back') {
        try {
            await c.editMessageText('Select a provider:', {
                parse_mode: 'HTML',
                reply_markup: modelProviderKeyboard(models)
            })
        } catch {}
    } else {
        try {
            await c.editMessageText(`Select a model from <b>${provider}</b>:`, {
                parse_mode: 'HTML',
                reply_markup: modelProviderDetailKeyboard(models, provider, 0)
            })
        } catch {}
    }
    await c.answerCallbackQuery()
}

async function handleModelProviderPageCallback(c: Context, data: string, sessionManager: SessionManager, topicSessions: Map<string, TopicSession>): Promise<void> {
    const parts = data.split(':')
    const provider = parts[1]
    const page = parseInt(parts[2], 10)
    if (!c.callbackQuery) return
    const chatId = c.callbackQuery.message?.chat.id
    const messageThreadId = c.callbackQuery.message?.message_thread_id
    if (!chatId) return

    const groupSettings = sessionManager.getGroupSettings(chatId)
    const providerName = groupSettings?.providerName || config.getDefaultProvider()
    const agentProvider = getProvider(providerName) ?? getDefaultProvider()
    const models = agentProvider.getAvailableModels()
    try {
        await c.editMessageText(`Select a model from <b>${provider}</b>:`, {
            parse_mode: 'HTML',
            reply_markup: modelProviderDetailKeyboard(models, provider, page)
        })
    } catch {}
    await c.answerCallbackQuery()
}

async function handleTimeoutCallback(c: Context, data: string, sessionManager: SessionManager, topicSessions: Map<string, TopicSession>): Promise<void> {
    const parts = data.split(':')
    const action = parts[1]
    if (!c.callbackQuery) return
    const chatId = c.callbackQuery.message?.chat.id
    const messageThreadId = c.callbackQuery.message?.message_thread_id
    if (!chatId) return

    const topicKey = makeTopicKey(chatId, messageThreadId)
    const topicSession = topicSessions.get(topicKey)
    const queryLoop = topicSession?.queryLoop

    if (action === 'continue') {
        if (queryLoop) {
            queryLoop.setTimeoutExtended(true)
            // Emit event so timeoutMiddleware can reset its internal state.
            // Without this, the middleware's timeoutNotified flag stays true
            // and periodic "still waiting" messages continue every 60s.
            queryLoop.bus.emit({ type: 'timeout.continue', sessionId: queryLoop.id })
        }
        try { await c.editMessageText('⏳ Continuing to wait... (periodic status updates active)') } catch {}
        await c.answerCallbackQuery('Continuing to wait')
    } else if (action === 'stop') {
        if (queryLoop && (queryLoop.state === 'querying' || queryLoop.state === 'canceling')) {
            try { await queryLoop.interrupt('stop') } catch {}
            try { await c.editMessageText('⏹️ Stopped. Next message will continue in the same conversation.') } catch {}
            await c.answerCallbackQuery('Stopped')
        } else if (queryLoop) {
            // Session is idle but user clicked stop on a stale timeout message.
            // Just acknowledge it — the timeoutMiddleware has already been stopped
            // by the session.state_changed handler (Bug 1 fix).
            try { await c.editMessageText('⏹️ Already stopped.') } catch {}
            await c.answerCallbackQuery('Already stopped')
        } else {
            await c.answerCallbackQuery('Session not found')
        }
    }
}

async function handleVerboseCallback(c: Context, data: string, sessionManager: SessionManager, topicSessions: Map<string, TopicSession>): Promise<void> {
    const level = parseInt(data.split(':')[1], 10)
    if (level !== 0 && level !== 1 && level !== 2) {
        await c.answerCallbackQuery('Invalid level')
        return
    }
    if (!c.callbackQuery) return
    const chatId = c.callbackQuery.message?.chat.id
    const messageThreadId = c.callbackQuery.message?.message_thread_id
    if (!chatId) return

    const topicKey = makeTopicKey(chatId, messageThreadId)
    const topicSession = topicSessions.get(topicKey)
    const queryLoop = topicSession?.queryLoop

    if (queryLoop) {
        queryLoop.setVerboseLevel(level as 0 | 1 | 2)
    }
    sessionManager.setGroupSettings(chatId, { verboseLevel: level as 0 | 1 | 2 })
    const labels = ['🔇 Quiet', '📊 Normal', '📢 Verbose']
    await c.answerCallbackQuery(`Verbose: ${labels[level]}`)
    try { await c.editMessageText(`✅ Verbose set to <b>${labels[level]}</b>`, { parse_mode: 'HTML' }) } catch {}
}

async function handleModeCallback(c: Context, data: string, sessionManager: SessionManager, topicSessions: Map<string, TopicSession>): Promise<void> {
    const mode = data.split(':')[1]
    if (!c.callbackQuery) return
    const chatId = c.callbackQuery.message?.chat.id
    const messageThreadId = c.callbackQuery.message?.message_thread_id
    if (!chatId) return

    const topicKey = makeTopicKey(chatId, messageThreadId)
    const topicSession = topicSessions.get(topicKey)
    const queryLoop = topicSession?.queryLoop

    if (queryLoop) {
        queryLoop.providerSettings.permissionMode = mode
    }
    sessionManager.setGroupSettings(chatId, { permissionMode: mode })
    await c.answerCallbackQuery(`Mode set to ${mode}`)
    try { await c.editMessageText(`✅ Permission mode set to <b>${mode}</b>`, { parse_mode: 'HTML' }) } catch {}
}

async function handleResumeCallback(c: Context, data: string, sessionManager: SessionManager, topicSessions: Map<string, TopicSession>): Promise<void> {
    const sessionId = data.slice(5)
    if (!c.callbackQuery) return
    const chatId = c.callbackQuery.message?.chat.id
    const messageThreadId = c.callbackQuery.message?.message_thread_id
    if (chatId) {
        await performResume(c, chatId, sessionId, messageThreadId, sessionManager, topicSessions)
        try { await c.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }) } catch {}
    }
    await c.answerCallbackQuery('Resuming session')
}

async function handleResumeListCallback(c: Context, data: string, sessionManager: SessionManager, topicSessions: Map<string, TopicSession>): Promise<void> {
    const page = parseInt(data.split(':')[1], 10)
    if (!c.callbackQuery) return
    const chatId = c.callbackQuery.message?.chat.id
    if (!chatId) return
    await sendSessionList(c, chatId, page, sessionManager, topicSessions)
    await c.answerCallbackQuery()
}

async function handleResumeDetailCallback(c: Context, data: string, sessionManager: SessionManager): Promise<void> {
    const sessionId = data.slice(6)
    if (!c.callbackQuery) return
    const chatId = c.callbackQuery.message?.chat.id
    if (!chatId) return

    const cwd = getCwdForChat(chatId, sessionManager)
    if (!cwd) {
        await c.answerCallbackQuery('No cwd set')
        return
    }

    const groupSettings = sessionManager.getGroupSettings(chatId)
    const providerName = groupSettings?.providerName || config.getDefaultProvider()
    const provider = getProvider(providerName)
    let firstMessage = '(no first message)'
    if (provider?.getSessionFirstMessage) {
        try {
            const msg = await provider.getSessionFirstMessage(sessionId)
            if (msg) firstMessage = msg
        } catch {}
    } else if (provider?.listSessions) {
        const sessions = await provider.listSessions(cwd)
        const session = sessions.find(s => s.sessionId === sessionId)
        if (session?.firstMessage) firstMessage = session.firstMessage
    }
    const detailText = `📋 <b>Session Details</b>\n\n<b>Session ID:</b> ${escapeHtml(sessionId)}\n\n<b>First message:</b>\n${escapeHtml(firstMessage)}`
    await c.reply(detailText, { parse_mode: 'HTML' })
    await c.answerCallbackQuery()
}

async function handleProviderCallback(c: Context, data: string, sessionManager: SessionManager, topicSessions: Map<string, TopicSession>): Promise<void> {
    const providerName = data.split(':')[1]
    if (!c.callbackQuery) return
    const chatId = c.callbackQuery.message?.chat.id
    const messageThreadId = c.callbackQuery.message?.message_thread_id
    const chatType = c.callbackQuery.message?.chat.type

    if (!chatId) {
        await c.answerCallbackQuery('Error')
        return
    }

    const targetProvider = getProvider(providerName)
    if (targetProvider && !targetProvider.isReady()) {
        const err = targetProvider.getInitError() ?? 'Provider not available'
        await c.answerCallbackQuery(`❌ Provider "${providerName}" is not available`)
        try { await c.editMessageText(`❌ Provider <b>${providerName}</b> is not available: ${err}`, { parse_mode: 'HTML' }) } catch {}
        return
    }

    if (chatType === 'private') {
        config.setDefaultProvider(providerName)
        await c.answerCallbackQuery(`Default provider set to ${providerName}`)
        try { await c.editMessageText(`✅ Default provider set to <b>${providerName}</b>`, { parse_mode: 'HTML' }) } catch {}
    } else {
        const topicKey = makeTopicKey(chatId, messageThreadId)
        const topicSession = topicSessions.get(topicKey)
        if (topicSession) {
            topicSession.queryLoop.setProviderName(providerName)
            topicSession.queryLoop.setConversationId(null)
            topicSession.queryLoop.resetRequested = true
            if (topicSession.queryLoop.state === 'querying' || topicSession.queryLoop.state === 'canceling') {
                try { await topicSession.queryLoop.interrupt('new') } catch {}
            }
        }
        sessionManager.setGroupSettings(chatId, { providerName })
        config.clearTopicConversation(topicKey)
        await c.answerCallbackQuery(`Provider set to ${providerName}`)
        try { await c.editMessageText(`✅ Provider set to <b>${providerName}</b>. Session will restart.`, { parse_mode: 'HTML' }) } catch {}
    }
}

async function handleCwdCreateCallback(c: Context, data: string, sessionManager: SessionManager): Promise<void> {
    const parts = data.split(':')
    // Format: cwd_create:pendingId:chatId:threadId
    const pendingId = parts[1]
    const chatId = parseInt(parts[2], 10)
    const threadIdStr = parts[3] ?? ''
    const threadId = threadIdStr ? parseInt(threadIdStr, 10) : undefined

    const path = consumePendingCwdPath(pendingId)
    if (!path) {
        await c.answerCallbackQuery('⚠️ Request expired. Please use /cwd again.')
        try { await c.editMessageText('⚠️ Request expired. Please use /cwd again.', { parse_mode: 'HTML' }) } catch {}
        return
    }

    try {
        mkdirSync(path, { recursive: true })
        sessionManager.setGroupCwd(chatId, path)
        const topicKey = makeTopicKey(chatId, threadId)
        sessionManager.unarchiveGroup(topicKey)
        await c.answerCallbackQuery('✅ Directory created')
        try { await c.editMessageText(`✅ Directory created and set as working directory:\n<code>${path}</code>`, { parse_mode: 'HTML' }) } catch (e) { console.warn('[callbacks] editMessageText failed:', e instanceof Error ? e.message : e) }
    } catch (e) {
        const err = e instanceof Error ? e.message : String(e)
        await c.answerCallbackQuery(`❌ Failed to create directory: ${err}`)
        try { await c.editMessageText(`❌ Failed to create directory:\n<code>${err}</code>`, { parse_mode: 'HTML' }) } catch (e) { console.warn('[callbacks] editMessageText failed:', e instanceof Error ? e.message : e) }
    }
}
