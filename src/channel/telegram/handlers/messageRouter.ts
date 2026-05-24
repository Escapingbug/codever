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

export interface MessageRouterContext {
    sessionManager: SessionManager
    topicSessions: Map<string, TopicSession>
    bot: Bot
    logger?: GroupLogger
}

export function registerMessageRouter(bot: any, ctx: MessageRouterContext): void {
    const { sessionManager, topicSessions, bot: botInstance, logger } = ctx

    function glog(chatId: number | null, line: string): void {
        if (logger) logger.group(chatId!, line)
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

        const isAdmin = newStatus === 'administrator'
        const privacyWarning = isAdmin
            ? ''
            : '\n\n⚠️ <b>Important:</b> Please make me a group admin, otherwise I can\'t see your messages (Telegram privacy mode).'

        await c.api.sendMessage(
            chat.id,
            `👋 Added to group! Use /cwd &lt;path&gt; to set working directory, then send a message to start a coding session.${privacyWarning}`,
            { parse_mode: 'HTML' }
        )
    })

    async function handleUserMessage(c: Context): Promise<void> {
        const chat = c.chat
        if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return

        if (chat.title && logger) {
            logger.registerGroupTitle(chat.id, chat.title)
        }

        const userId = c.from!.id
        const messageThreadId = c.message?.message_thread_id
        const topicKey = makeTopicKey(chat.id, messageThreadId)
        const messageText = getMessageText(c)
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

        const groupChatId = chat.id
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

        if (!topicSession) {
            if (sessionManager.isGroupArchived(topicKey)) {
                await c.reply('📦 Session was archived. Use /cwd to set up a new session.')
                return
            }

            if (sessionManager.isGroupInCooldown(topicKey)) {
                await c.reply('⏳ Recent error. Please try again shortly.')
                return
            }

            const cwd = sessionManager.getGroupCwd(groupChatId)
            if (!cwd) {
                await c.reply('Please set working directory first: /cwd &lt;path&gt;', { parse_mode: 'HTML' })
                return
            }

            if (!sessionManager.tryAcquireCreationLock(topicKey)) {
                await new Promise(resolve => setTimeout(resolve, 100))
                topicSession = topicSessions.get(topicKey)
                if (!topicSession) {
                    glog(groupChatId, `[session] Failed to acquire creation lock`)
                    await c.reply('⚠️ Session creation in progress. Please wait a moment and try again.')
                    return
                }
            } else {
                const groupSettings = sessionManager.getGroupSettings(groupChatId)
                const topicState = config.getTopicState(topicKey)
                const topicSettings = topicState?.settings
                const configuredProviderName = topicSettings?.providerName || groupSettings?.providerName || config.getDefaultProvider()
                const providerName = getProvider(configuredProviderName) ? configuredProviderName : config.getDefaultProvider()
                const permissionMode = topicSettings?.permissionMode ?? groupSettings?.permissionMode

                let conversationId = topicState?.conversationId
                if (topicState?.queryInProgress) {
                    // Daemon was killed while a query was in progress. Clear the stale
                    // queryInProgress flag but preserve conversationId — resumeSession
                    // can safely restore the session from disk even after an interrupted
                    // query; the agent discards the incomplete turn and continues from
                    // the last completed state. Clearing conversationId would make
                    // recovery impossible, turning a recoverable session into a lost one.
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
                    providerSettings: permissionMode ? { permissionMode } : {},
                    conversationId,
                })

                sessionManager.registerSession(sessionRecord, groupChatId, messageThreadId)
                glog(groupChatId, `[session] Created session record id=${sessionRecord.id.slice(0, 8)} provider=${sessionRecord.providerName}`)

                // Create the bridge: wire session metadata + session-scoped Provider + ChannelPort.
                // Provider instances own ACP subprocess state, so sharing one across topics breaks concurrency.
                const provider = createProviderInstance(providerName) ?? createProviderInstance(config.getDefaultProvider())
                if (!provider) {
                    sessionManager.removeSession(sessionRecord.id)
                    sessionManager.releaseCreationLock(topicKey)
                    await c.reply(`❌ Provider "${providerName}" is not available.`)
                    return
                }
                const channelPort = new TelegramPort(botInstance, groupChatId, messageThreadId)

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
                        glog(groupChatId, `[session] Session dead, cleaned up`)
                    }
                })

                topicSession = bridge
            }
        }

        if (topicSession) {
            let richInput: RichUserInput | undefined
            if (hasUpload(c)) {
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
                    richInput = built.richInput
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    await c.reply(`Cannot process upload: ${message}`)
                    return
                }
            }
            topicSession.receiveInput({
                text: messageText,
                username: c.from?.username || c.from?.first_name,
                ...(richInput ? { richInput } : {}),
            })
        }

        await botInstance.api.sendChatAction(groupChatId, 'typing').catch(e => console.warn('[messageRouter] sendChatAction failed:', e instanceof Error ? e.message : e))
    }

    bot.on('message:text', handleUserMessage)
    bot.on('message:photo', handleUserMessage)
    bot.on('message:document', handleUserMessage)
    bot.on('message:audio', handleUserMessage)
    bot.on('message:voice', handleUserMessage)
}

function getMessageText(c: Context): string {
    const message = c.message as any
    return typeof message?.text === 'string'
        ? message.text
        : typeof message?.caption === 'string'
            ? message.caption
            : ''
}

function hasUpload(c: Context): boolean {
    const message = c.message as any
    return Boolean(message?.photo?.length || message?.document || message?.audio || message?.voice)
}
