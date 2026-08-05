import type { Context } from 'grammy'
import type { SessionManager } from '@/bridge/sessionManager'
import { isGenericTopic, makeTopicKey } from '@/bridge/sessionManager'
import { config } from '@/config'
import { pairing } from '@/channel/telegram/pairing'
import { createTopicSession, createTopicSessionRecord } from '@/bridge/topicSession'
import { TelegramPort } from '@/channel/telegram/telegramPort'
import type { TopicSession } from '@/bridge/channelPort'
import { createProviderInstance, getProvider } from '@/providers/registry'
import type { Bot } from 'grammy'
import type { GroupLogger } from '@/utils/groupLogger'
import { buildRichInputFromTelegramMessage } from '@/channel/telegram/uploadInput'
import type { RichUserInput } from '@/runtime/semantic'
import { LongInputBuffer, type LongInputScope, type LongInputStats } from '@/channel/telegram/longInputBuffer'

export interface MessageRouterContext {
    sessionManager: SessionManager
    topicSessions: Map<string, TopicSession>
    bot: Bot
    logger?: GroupLogger
    longInputBuffer?: LongInputBuffer
}

export function registerMessageRouter(bot: any, ctx: MessageRouterContext): void {
    const { sessionManager, topicSessions, bot: botInstance, logger } = ctx
    const pendingUploadsByTopic = new Map<string, RichUserInput['parts']>()
    const longInputBuffer = ctx.longInputBuffer ?? new LongInputBuffer()

    function glog(chatId: number | null, line: string): void {
        if (logger && chatId !== null) logger.group(chatId, line)
    }

    bot.on('my_chat_member', async (c: Context) => {
        const update = c.myChatMember
        if (!update) return
        const chat = update.chat
        if (chat.type !== 'group' && chat.type !== 'supergroup') return

        if (chat.title && logger) {
            logger.registerGroupTitle(chat.id, chat.title)
        }

        const newStatus = update.new_chat_member.status
        if (newStatus !== 'member' && newStatus !== 'administrator') return

        const userId = update.from.id
        glog(chat.id, `[bot] my_chat_member: userId=${userId} status=${newStatus}`)

        if (!pairing.isAuthorized(userId)) {
            glog(chat.id, `[bot] Unauthorized user ${userId}`)
            await c.api.sendMessage(chat.id, '❌ Unauthorized. The person adding me must pair first via DM.')
            return
        }

        if (sessionManager.hasSessionInGroup(chat.id)) {
            glog(chat.id, `[bot] Already has session, status=${newStatus}`)
            if (newStatus === 'administrator') {
                await c.api.sendMessage(chat.id, '✅ Admin permissions received. I can now see all messages.', { parse_mode: 'HTML' })
            }
            return
        }

        const privacyWarning = newStatus === 'administrator'
            ? ''
            : '\n\n⚠️ <b>Important:</b> Please make me a group admin, otherwise I can\'t see your messages (Telegram privacy mode).'

        await c.api.sendMessage(
            chat.id,
            `👋 Added to group! Use /cwd &lt;path&gt; to set working directory, then send a message to start a coding session.${privacyWarning}`,
            { parse_mode: 'HTML' }
        )
    })

    bot.command('paste', async (c: Context) => {
        const messageContext = getGroupMessageContext(c)
        if (!messageContext) return
        registerGroupTitle(c)

        if (!pairing.isAuthorized(messageContext.userId)) {
            await c.reply('Unauthorized.')
            return
        }
        if (isGenericTopic(messageContext.messageThreadId)) {
            await c.reply('Please create or use a topic to start a Codever session. The general topic only supports control commands like /help and /provider.')
            return
        }

        const result = longInputBuffer.begin(messageContext.scope)
        if (result.status === 'already_active') {
            await c.reply(`Long input mode is already active (${formatLongInputStats(result.stats)}). Send /done to submit or /paste_cancel to discard.`)
            return
        }

        await c.reply(`Long input mode started. Send text chunks, then /done to submit them as one prompt. Send /paste_cancel to discard. Limit: ${formatCharCount(longInputBuffer.maxChars)}.`)
    })

    bot.command('done', async (c: Context) => {
        const messageContext = getGroupMessageContext(c)
        if (!messageContext) return
        registerGroupTitle(c)

        if (!pairing.isAuthorized(messageContext.userId)) {
            await c.reply('Unauthorized.')
            return
        }

        const draft = longInputBuffer.read(messageContext.scope)
        if (draft.status === 'inactive') {
            await c.reply('No long input draft is active. Send /paste to start one.')
            return
        }
        if (draft.status === 'expired') {
            await c.reply('Long input draft expired. Send /paste to start again.')
            return
        }
        if (draft.status === 'empty') {
            longInputBuffer.clear(messageContext.scope)
            pendingUploadsByTopic.delete(messageContext.topicKey)
            await c.reply('Long input draft was empty and has been discarded.')
            return
        }

        const topicSession = await getOrCreateTopicSession(
            c,
            messageContext.groupChatId,
            messageContext.messageThreadId,
            messageContext.topicKey,
        )
        if (!topicSession) return

        longInputBuffer.clear(messageContext.scope)
        submitUserInput(c, topicSession, messageContext.topicKey, draft.text)
        await c.reply(`Long input submitted (${formatLongInputStats(draft.stats)}).`)
        await sendTyping(messageContext.groupChatId)
    })

    bot.command('paste_cancel', async (c: Context) => {
        const messageContext = getGroupMessageContext(c)
        if (!messageContext) return
        registerGroupTitle(c)

        if (!pairing.isAuthorized(messageContext.userId)) {
            await c.reply('Unauthorized.')
            return
        }

        const result = longInputBuffer.cancel(messageContext.scope)
        pendingUploadsByTopic.delete(messageContext.topicKey)
        if (result.status === 'inactive') {
            await c.reply('No long input draft is active.')
            return
        }
        if (result.status === 'expired') {
            await c.reply('Long input draft expired and has been discarded.')
            return
        }

        await c.reply(`Long input draft discarded (${formatLongInputStats(result.stats)}).`)
    })

    async function handleUserMessage(c: Context): Promise<void> {
        const chat = c.chat
        const from = c.from
        if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup') || !from) return

        registerGroupTitle(c)

        const userId = from.id
        const messageThreadId = c.message?.message_thread_id
        const topicKey = makeTopicKey(chat.id, messageThreadId)
        const scope: LongInputScope = { topicKey, userId }
        const messageText = getTextMessageText(c)
        glog(chat.id, `[msg:in] userId=${userId} text="${messageText.slice(0, 80)}"`)

        if (!pairing.isAuthorized(userId)) {
            glog(chat.id, `[msg:in] User ${userId} not authorized, ignoring`)
            return
        }

        if (isGenericTopic(messageThreadId)) {
            const text = messageText.trim()
            if (!text.startsWith('/')) {
                await c.reply('Please create or use a topic to start a Codever session. The general topic only supports control commands like /help and /provider.')
            }
            return
        }

        if (hasUpload(c)) {
            await stageUpload(
                c,
                topicKey,
                pendingUploadsByTopic,
                longInputBuffer.hasActive(scope)
                    ? 'Attachment received. It will be included when you submit the long input with /done.'
                    : undefined,
            )
            return
        }

        if (longInputBuffer.hasActive(scope)) {
            const result = longInputBuffer.append(scope, messageText, { messageId: c.message?.message_id })
            if (result.status === 'appended') {
                if (result.stats.partCount === 1 || result.stats.partCount % 10 === 0) {
                    await c.reply(`Long input chunk collected (${formatLongInputStats(result.stats)}). Send /done to submit or /paste_cancel to discard.`)
                }
                return
            }
            if (result.status === 'expired') {
                await c.reply('Long input draft expired. Send /paste to start again.')
                return
            }
            if (result.status === 'too_large') {
                await c.reply(`Long input limit exceeded (${formatCharCount(result.attemptedChars)} > ${formatCharCount(result.maxChars)}). Send /done to submit the collected text or /paste_cancel to discard.`)
                return
            }
            if (result.status === 'too_many_parts') {
                await c.reply(`Long input has too many chunks (${result.stats.partCount}/${result.maxParts}). Send /done to submit the collected text or /paste_cancel to discard.`)
                return
            }
        }

        let topicSession = topicSessions.get(topicKey)
        const fileCommandMatch = messageText.match(/^\/file_([A-Za-z0-9_-]+)(?:@\w+)?(?:\s|$)/)
        if (fileCommandMatch) {
            if (!topicSession) {
                await c.reply('No active session.')
                return
            }
            await topicSession.dispatch({ kind: 'command', name: 'file', args: fileCommandMatch[1], source: 'channel' })
            return
        }

        const retryDeliveryAliasMatch = messageText.match(/^\/retry-delivery(?:@\w+)?(?:\s+(.+?))?\s*$/i)
        if (retryDeliveryAliasMatch) {
            if (!topicSession) {
                await c.reply('No active session.')
                return
            }
            await topicSession.dispatch({
                kind: 'command',
                name: 'retry_delivery',
                args: retryDeliveryAliasMatch[1],
                source: 'channel',
            })
            return
        }

        topicSession = await getOrCreateTopicSession(c, chat.id, messageThreadId, topicKey)
        if (!topicSession) return

        submitUserInput(c, topicSession, topicKey, messageText)
        await sendTyping(chat.id)
    }

    function getGroupMessageContext(c: Context): {
        groupChatId: number
        messageThreadId: number | undefined
        topicKey: string
        userId: number
        scope: LongInputScope
    } | null {
        const chat = c.chat
        const from = c.from
        if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup') || !from) return null
        const messageThreadId = c.message?.message_thread_id
        const topicKey = makeTopicKey(chat.id, messageThreadId)
        return {
            groupChatId: chat.id,
            messageThreadId,
            topicKey,
            userId: from.id,
            scope: { topicKey, userId: from.id },
        }
    }

    function registerGroupTitle(c: Context): void {
        const chat = c.chat
        if (chat && (chat.type === 'group' || chat.type === 'supergroup') && chat.title && logger) {
            logger.registerGroupTitle(chat.id, chat.title)
        }
    }

    async function getOrCreateTopicSession(
        c: Context,
        groupChatId: number,
        messageThreadId: number | undefined,
        topicKey: string,
    ): Promise<TopicSession | undefined> {
        let topicSession = topicSessions.get(topicKey)
        if (topicSession) return topicSession

        if (sessionManager.isGroupArchived(topicKey)) {
            await c.reply('📦 Session was archived. Use /cwd to set up a new session.')
            return undefined
        }

        if (sessionManager.isGroupInCooldown(topicKey)) {
            await c.reply('⏳ Recent error. Please try again shortly.')
            return undefined
        }

        const cwd = sessionManager.getGroupCwd(groupChatId)
        if (!cwd) {
            await c.reply('Please set working directory first: /cwd &lt;path&gt;', { parse_mode: 'HTML' })
            return undefined
        }

        if (!sessionManager.tryAcquireCreationLock(topicKey)) {
            await new Promise(resolve => setTimeout(resolve, 100))
            topicSession = topicSessions.get(topicKey)
            if (!topicSession) {
                glog(groupChatId, '[session] Failed to acquire creation lock')
                await c.reply('⚠️ Session creation in progress. Please wait a moment and try again.')
                return undefined
            }
            return topicSession
        }

        const groupSettings = sessionManager.getGroupSettings(groupChatId)
        const topicState = config.getTopicState(topicKey)
        const topicSettings = topicState?.settings
        const conversationId = topicState?.conversationId
        const conversationProviderName = conversationId ? topicState?.providerName : undefined
        if (conversationProviderName && !getProvider(conversationProviderName)) {
            sessionManager.releaseCreationLock(topicKey)
            await c.reply(`Provider "${conversationProviderName}" for the persisted session is not available. Use /reset to start a new session or /provider to choose another provider.`)
            return undefined
        }
        const configuredProviderName = conversationProviderName || topicSettings?.providerName || groupSettings?.providerName || config.getDefaultProvider()
        const providerName = getProvider(configuredProviderName) ? configuredProviderName : config.getDefaultProvider()
        const permissionMode = topicSettings?.permissionMode ?? groupSettings?.permissionMode
        const reasoningEffort = topicSettings?.reasoningEffort ?? groupSettings?.reasoningEffort

        if (topicState?.queryInProgress) {
            // Preserve conversationId while clearing stale in-progress state from a killed daemon.
            config.clearTopicQueryInProgress(topicKey)
        }

        const sessionRecord = createTopicSessionRecord({
            cwd,
            providerName,
            groupChatId,
            messageThreadId,
            model: topicSettings?.model ?? groupSettings?.model,
            verboseLevel: topicSettings?.verboseLevel ?? groupSettings?.verboseLevel,
            timeoutSeconds: topicSettings?.timeoutSeconds ?? groupSettings?.timeoutSeconds,
            providerSettings: {
                ...(permissionMode ? { permissionMode } : {}),
                ...(reasoningEffort ? { reasoningEffort } : {}),
            },
            conversationId,
        })

        sessionManager.registerSession(sessionRecord, groupChatId, messageThreadId)
        glog(groupChatId, `[session] Created session record id=${sessionRecord.id.slice(0, 8)} provider=${sessionRecord.providerName}`)

        // Provider instances own ACP subprocess state, so sharing one across topics breaks concurrency.
        const provider = createProviderInstance(providerName) ?? (conversationProviderName ? undefined : createProviderInstance(config.getDefaultProvider()))
        if (!provider) {
            sessionManager.removeSession(sessionRecord.id)
            sessionManager.releaseCreationLock(topicKey)
            await c.reply(`❌ Provider "${providerName}" is not available.`)
            return undefined
        }

        const channelPort = new TelegramPort(
            botInstance,
            groupChatId,
            messageThreadId,
            (line) => glog(groupChatId, line),
        )

        sessionRecord.onLog = (msg) => glog(groupChatId, msg)

        const bridge = createTopicSession({
            sessionRecord,
            provider,
            channelPort,
            logger: logger ? { group: (chatId: number, line: string) => logger.group(chatId, line) } : undefined,
        })

        sessionManager.registerTopicSession(topicKey, bridge)

        sessionRecord.bus.on('session.state_changed', (e) => {
            if (e.type !== 'session.state_changed') return
            if (e.sessionId !== sessionRecord.id) return
            if (e.to === 'dead') {
                sessionManager.removeTopicSession(topicKey)
                sessionManager.removeSession(sessionRecord.id)
                sessionManager.clearGroupFailures(topicKey)
                sessionManager.releaseCreationLock(topicKey)
                glog(groupChatId, '[session] Session dead, cleaned up')
            }
        })

        return bridge
    }

    function submitUserInput(c: Context, topicSession: TopicSession, topicKey: string, messageText: string): void {
        const stagedUploads = pendingUploadsByTopic.get(topicKey) ?? []
        pendingUploadsByTopic.delete(topicKey)
        const richInput: RichUserInput | undefined = stagedUploads.length > 0
            ? { parts: [{ type: 'text', text: messageText }, ...stagedUploads] }
            : undefined
        topicSession.receiveInput({
            text: messageText,
            username: c.from?.username || c.from?.first_name,
            ...(richInput ? { richInput } : {}),
        })
    }

    async function sendTyping(groupChatId: number): Promise<void> {
        await botInstance.api.sendChatAction(groupChatId, 'typing').catch(e => console.warn('[messageRouter] sendChatAction failed:', e instanceof Error ? e.message : e))
    }

    bot.on('message:text', handleUserMessage)
    bot.on('message:photo', handleUserMessage)
    bot.on('message:document', handleUserMessage)
    bot.on('message:audio', handleUserMessage)
    bot.on('message:voice', handleUserMessage)
}

async function stageUpload(
    c: Context,
    topicKey: string,
    pendingUploadsByTopic: Map<string, RichUserInput['parts']>,
    acknowledgement = 'Attachment received. Send a text message to use it in the next prompt.',
): Promise<void> {
    const botToken = config.getBotToken()
    if (!botToken) {
        await c.reply('Bot token is not configured, cannot download Telegram upload.')
        return
    }

    try {
        const built = await buildRichInputFromTelegramMessage({
            api: c.api,
            botToken,
            topicKey,
            message: c.message as any,
        })
        const uploadParts = built.richInput.parts.filter(part => part.type !== 'text')
        if (uploadParts.length === 0) return
        const existing = pendingUploadsByTopic.get(topicKey) ?? []
        pendingUploadsByTopic.set(topicKey, [...existing, ...uploadParts])
        await c.reply(acknowledgement)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await c.reply(`Cannot process upload: ${message}`)
    }
}

function getTextMessageText(c: Context): string {
    const message = c.message as any
    return typeof message?.text === 'string' ? message.text : ''
}

function hasUpload(c: Context): boolean {
    const message = c.message as any
    return Boolean(message?.photo?.length || message?.document || message?.audio || message?.voice)
}

function formatLongInputStats(stats: LongInputStats): string {
    return `${stats.partCount} chunk(s), ${formatCharCount(stats.totalChars)}`
}

function formatCharCount(chars: number): string {
    if (chars < 1024) return `${chars} chars`
    return `${Math.round(chars / 1024)}K chars`
}
