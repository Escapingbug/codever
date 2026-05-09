import { Bot } from 'grammy'
import { config } from '@/config'
import { pairing } from '@/channel/telegram/pairing'
import type { SessionManager } from '@/bridge/sessionManager'
import { registerDmHandlers } from '@/transport/telegram/handlers/dm'
import { registerGroupHandlers } from '@/transport/telegram/handlers/groupCommands'
import { registerSettingsHandlers } from '@/transport/telegram/handlers/settings'
import { registerCallbackHandlers } from '@/transport/telegram/handlers/callbacks'
import { registerMessageRouter } from '@/transport/telegram/handlers/messageRouter'
import type { GroupLogger } from '@/utils/groupLogger'

export interface CreateBotOptions {
    sessionManager: SessionManager
    processCwd: string
    logger?: GroupLogger
    restart?: (chatId?: number) => Promise<void>
}

export function createBot(options: CreateBotOptions): Bot {
    const { sessionManager, logger } = options
    const token = config.getBotToken()
    if (!token) throw new Error('Bot token not configured. Run: codever config set-bot-token <token>')

    const bot = new Bot(token)
    const topicSessions = sessionManager.getTopicSessionsMap()

    // Register all handlers
    registerDmHandlers(bot, sessionManager, options.restart)
    registerGroupHandlers(bot, { sessionManager, topicSessions, restart: options.restart })
    registerSettingsHandlers(bot, { sessionManager, topicSessions })
    registerCallbackHandlers(bot, { sessionManager, topicSessions })
    registerMessageRouter(bot, { sessionManager, topicSessions, bot, logger })

    // Error handling
    bot.catch((err) => {
        const e = (err as any).error
        if (e instanceof Error) {
            console.error('[bot error]', e.message)
        }
    })

    return bot
}
