import type { Bot } from 'grammy'
import { InputFile } from 'grammy'
import { checkTgmdrender, tgmdSplit, tgmdTableImage, type TgmdSegment, type TgEntity } from '@/utils/tgmdrender'
import { splitHtmlChunks } from '@/utils/formatting'
import { buildMessageThreadParams, buildChatActionThreadParams } from '@/bridge/sessionManager'

const MAX_LENGTH = 4000

export interface TelegramRenderer {
    /** Send markdown text via tgmdrender entity-based pipeline (preferred for agent output) */
    sendMarkdown(markdown: string, options?: { replyMarkup?: unknown }): Promise<void>
    /** Send pre-formatted HTML (fallback / system messages) */
    sendFormatted(text: string, options?: { replyMarkup?: unknown }): Promise<void>
    /** Send plain text without any formatting */
    sendPlain(text: string): Promise<void>
    /** Send a chat action indicator */
    sendChatAction(action: 'typing' | 'upload_photo' | 'record_video' | 'upload_video' | 'record_voice' | 'upload_voice' | 'upload_document' | 'choose_sticker' | 'find_location' | 'record_video_note' | 'upload_video_note'): Promise<void>
}

export function createTelegramRenderer(
    bot: Bot,
    chatId: number,
    messageThreadId?: number
): TelegramRenderer {
    return {
        async sendMarkdown(markdown: string, options?: { replyMarkup?: unknown }): Promise<void> {
            const status = checkTgmdrender()
            console.error(`[renderer] sendMarkdown called, tgmdrender available=${status.available}${status.error ? ' error=' + status.error : ''}, text length=${markdown.length}`)
            console.error(`[renderer] sendMarkdown content preview: ${JSON.stringify(markdown.slice(0, 300))}`)
            if (!status.available) {
                // Fallback: treat as plain text
                console.error('[renderer] Falling back to sendPlainChunks')
                await sendPlainChunks(bot, chatId, markdown, messageThreadId)
                return
            }

            try {
                const segments = await tgmdSplit(markdown, MAX_LENGTH)
                console.error(`[renderer] tgmdSplit returned ${segments.length} segments, kinds=[${segments.map(s => s.kind).join(',')}]`)
                let isFirst = true
                for (const seg of segments) {
                    const replyMarkup = isFirst ? options?.replyMarkup : undefined
                    isFirst = false

                    if (seg.kind === 'table' && seg.markdown) {
                        await sendTableAsImage(bot, chatId, messageThreadId, seg.markdown)
                    } else if (seg.kind === 'text' && seg.text !== undefined) {
                        await sendEntityMessage(
                            bot, chatId, messageThreadId,
                            seg.text, seg.entities, replyMarkup,
                        )
                    }
                }
            } catch (e) {
                console.error(`[renderer] tgmdrender failed, falling back to plain text: ${e instanceof Error ? e.message : e}`)
                await sendPlainChunks(bot, chatId, markdown, messageThreadId)
            }
        },

        async sendFormatted(text: string, options?: { replyMarkup?: unknown }): Promise<void> {
            const chunks = splitHtmlChunks(text, MAX_LENGTH)
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i]
                const isLast = i === chunks.length - 1
                const replyMarkup = isLast ? options?.replyMarkup : undefined
                await sendHtmlMessage(bot, chatId, chunk, messageThreadId, replyMarkup)
            }
        },

        async sendPlain(text: string): Promise<void> {
            await sendPlainChunks(bot, chatId, text, messageThreadId)
        },

        async sendChatAction(action): Promise<void> {
            await bot.api.sendChatAction(chatId, action, buildChatActionThreadParams(messageThreadId)).catch(e => console.warn('[renderer] sendChatAction failed:', e instanceof Error ? e.message : e))
        },
    }
}

// ---------- Entity-based sending (tgmdrender) ----------

async function sendEntityMessage(
    bot: Bot,
    chatId: number,
    messageThreadId: number | undefined,
    text: string,
    entities?: TgEntity[],
    replyMarkup?: unknown,
): Promise<void> {
    const params: Record<string, unknown> = buildMessageThreadParams(messageThreadId)

    if (entities && entities.length > 0) {
        // Convert tgmdrender entities to grammy MessageEntity format
        params.entities = entities.map(e => {
            const ent: Record<string, unknown> = {
                type: e.type,
                offset: e.offset,
                length: e.length,
            }
            if (e.url) ent.url = e.url
            if (e.language) ent.language = e.language
            return ent
        })
    }

    if (replyMarkup) {
        params.reply_markup = replyMarkup
    }

    try {
        await bot.api.sendMessage(chatId, text, params as any)
    } catch (e) {
        // Fallback: send as plain text without entities
        console.error(`[renderer] Entity send failed, falling back to plain: ${e instanceof Error ? e.message : e}`)
        await sendPlainChunks(bot, chatId, text, messageThreadId)
    }
}

async function sendTableAsImage(
    bot: Bot,
    chatId: number,
    messageThreadId: number | undefined,
    tableMarkdown: string,
): Promise<void> {
    try {
        const imgBuffer = await tgmdTableImage(tableMarkdown)
        await bot.api.sendPhoto(chatId, new InputFile(imgBuffer, 'table.png'), {
            ...buildMessageThreadParams(messageThreadId),
        })
    } catch (e) {
        // Fallback: send table as plain text
        console.error(`[renderer] Table image failed, sending as text: ${e instanceof Error ? e.message : e}`)
        await sendPlainChunks(bot, chatId, tableMarkdown, messageThreadId)
    }
}

// ---------- HTML-based sending (legacy) ----------

async function sendHtmlMessage(
    bot: Bot,
    chatId: number,
    text: string,
    messageThreadId?: number,
    replyMarkup?: unknown
): Promise<void> {
    const params: Record<string, unknown> = { parse_mode: 'HTML', ...buildMessageThreadParams(messageThreadId) }
    if (replyMarkup) {
        params.reply_markup = replyMarkup
    }
    await bot.api.sendMessage(chatId, text, params as any).catch((e: unknown) => {
        const plain = text
            .replace(/<\/?[^>]+(>|$)/g, '')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
        bot.api.sendMessage(chatId, plain, buildMessageThreadParams(messageThreadId)).catch((e2: unknown) => {
            console.error(`[renderer] Failed to send message to chat ${chatId}: HTML error=${e instanceof Error ? e.message : e}, plain error=${e2 instanceof Error ? e2.message : e2}`)
        })
    })
}

// ---------- Plain text sending ----------

async function sendPlainChunks(
    bot: Bot,
    chatId: number,
    text: string,
    messageThreadId?: number,
): Promise<void> {
    const chunks = splitPlainChunks(text, MAX_LENGTH)
    for (const chunk of chunks) {
        await bot.api.sendMessage(chatId, chunk, buildMessageThreadParams(messageThreadId)).catch((e: unknown) => {
            console.error(`[renderer] Failed to send plain chunk to chat ${chatId}: ${e instanceof Error ? e.message : e}`)
        })
    }
}

// ---------- Chunk splitters (legacy HTML, kept for sendFormatted fallback) ----------

function splitPlainChunks(text: string, maxLen: number): string[] {
    const chunks: string[] = []
    let remaining = text
    while (remaining.length > 0) {
        if (remaining.length <= maxLen) {
            chunks.push(remaining)
            break
        }
        let splitAt = maxLen
        while (splitAt > maxLen * 0.5 && remaining[splitAt] !== '\n' && remaining[splitAt] !== ' ') {
            splitAt--
        }
        if (splitAt <= maxLen * 0.5) splitAt = maxLen
        chunks.push(remaining.slice(0, splitAt))
        remaining = remaining.slice(splitAt)
    }
    return chunks
}


