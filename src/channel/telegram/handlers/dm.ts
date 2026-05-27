import type { Context } from 'grammy'
import type { SessionManager } from '@/bridge/sessionManager'
import { config } from '@/config'
import { pairing } from '@/channel/telegram/pairing'
import { providerKeyboard } from '@/channel/telegram/keyboard'
import { escapeHtml } from '@/utils/formatting'
import { listProviders } from '@/providers/registry'

export function registerDmHandlers(bot: any, sessionManager: SessionManager, restart?: (chatId?: number, messageThreadId?: number) => Promise<void>): void {
    bot.command('start', async (ctx: Context, next: () => Promise<void>) => {
        if (ctx.chat?.type !== 'private') return next()
        const userId = ctx.from!.id
        if (pairing.isAuthorized(userId)) {
            await ctx.reply(
                '✅ Already paired!\n\n' +
                'Commands:\n' +
                '/status - Show active sessions\n' +
                '/provider - Set default coding agent\n' +
                '/restart - Restart the daemon\n' +
                '/help - Show help\n\n' +
                'To interact with a coding agent, create a group and add me to it.',
                { parse_mode: 'HTML' }
            )
            return
        }
        const code = pairing.generateCode(ctx.chat.id, userId)
        await ctx.reply(
            `👋 Welcome to <b>codever</b>!\n\n` +
            `To pair, run on your machine:\n` +
            `<pre>codever pair ${code}</pre>\n\n` +
            `⏳ Code expires in 5 minutes.`,
            { parse_mode: 'HTML' }
        )
    })

    bot.command('status', async (ctx: Context, next: () => Promise<void>) => {
        if (ctx.chat?.type !== 'private') return next()
        const userId = ctx.from!.id
        if (!pairing.isAuthorized(userId)) {
            await ctx.reply('Not paired. Use /start.')
            return
        }
        const sessions = sessionManager.listActiveSessions()
        if (sessions.length === 0) {
            await ctx.reply('📊 No active sessions.')
            return
        }
        const lines = sessions.map(s => {
            const group = s.groupChatId ? `group ${s.groupChatId}` : 'pending'
            return `• <code>${s.id.slice(0, 8)}</code> ${group} — <code>${s.cwd}</code>`
        })
        await ctx.reply(`📊 <b>Active Sessions</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' })
    })

    bot.command('restart', async (ctx: Context, next: () => Promise<void>) => {
        if (ctx.chat?.type !== 'private') return next()
        const userId = ctx.from!.id
        if (!pairing.isAuthorized(userId)) {
            await ctx.reply('❌ Unauthorized.')
            return
        }
        if (!restart) {
            await ctx.reply('⚠️ Restart is not available.')
            return
        }
        const chatId = ctx.chat!.id
        // Send the "restarting" message and wait for it to be delivered
        // (with a timeout so we don't hang if the network is slow).
        // The restart function will kill the process, so we must ensure
        // the reply is sent before that happens.
        await Promise.race([
            ctx.reply('🔄 Restarting daemon...').catch(() => {}),
            new Promise(resolve => setTimeout(resolve, 2000))
        ])
        restart(chatId).catch((e) => {
            console.error('[/restart] restart() failed:', e instanceof Error ? e.message : e)
        })
    })

    bot.command('provider', async (ctx: Context, next: () => Promise<void>) => {
        if (ctx.chat?.type !== 'private') return next()
        const current = config.getDefaultProvider()
        const providers = listProviders()
        await ctx.reply(`Default provider: <b>${current}</b>\nSelect default provider:`, {
            parse_mode: 'HTML',
            reply_markup: providerKeyboard(providers, current)
        })
    })

    bot.command('help', async (ctx: Context, next: () => Promise<void>) => {
        if (ctx.chat?.type !== 'private') {
            let helpText =
                '<b>codever — Group commands:</b>\n\n' +
                '<b>Session:</b>\n' +
                '/stop — Interrupt current query\n' +
                '/new — Start a new session\n' +
                '/resume — List and resume past sessions\n' +
                '/archive — Stop session, deactivate group\n' +
                '/restart — Restart the daemon\n\n' +
                '<b>Settings:</b>\n' +
                '/provider — Choose coding agent\n' +
                '/cwd &lt;path&gt; — Set working directory\n' +
                '/model — Choose model\n' +
                '/mode — Choose permission mode\n' +
                '/verbose — Set output verbosity\n' +
                '/help — Show this help'

            // Append provider commands if available
            const chatId = ctx.chat!.id
            const threadId = ctx.message?.message_thread_id
            const sessionRecord = sessionManager.getSessionByGroup(chatId, threadId)
            const commands = sessionRecord?.availableCommands
            if (commands && commands.length > 0) {
                helpText += '\n\n<b>Provider commands:</b>\n'
                for (const cmd of commands) {
                    const hint = cmd.inputHint ? ` &lt;${escapeHtml(cmd.inputHint)}&gt;` : ''
                    helpText += `/${escapeHtml(cmd.name)}${hint} — ${escapeHtml(cmd.description)}\n`
                }
            }

            helpText += '\n\nSend a message to talk to the coding agent.'
            await ctx.reply(helpText, { parse_mode: 'HTML' })
            return
        }
        await ctx.reply(
            '<b>codever — DM commands:</b>\n\n' +
            '/start — Pair this Telegram account\n' +
            '/status — Show active sessions\n' +
            '/provider — Set default coding agent\n' +
            '/restart — Restart the daemon\n' +
            '/help — Show help\n\n' +
            '<b>Getting started:</b>\n' +
            '1. Create a group and add this bot\n' +
            '2. Use /cwd &lt;path&gt; in the group to set working directory\n' +
            '3. Send a message to start a coding session',
            { parse_mode: 'HTML' }
        )
    })

    bot.on('message:text', async (ctx: Context, next: () => Promise<void>) => {
        if (ctx.chat?.type !== 'private') return next()
        const userId = ctx.from!.id
        if (!pairing.isAuthorized(userId)) {
            await ctx.reply('Not paired. Use /start to pair.')
            return
        }
        await ctx.reply('💬 Please interact with a coding agent in a group chat.\nCreate a group and add me to start a session.')
    })
}
