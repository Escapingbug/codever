/**
 * TelegramPort — ChannelPort implementation for Telegram via grammY.
 * Wraps Telegram rendering and decision UI behind the ChannelPort interface.
 */

import type { Bot } from 'grammy'
import type { ChannelPort, ChannelMessage, ChannelSendResult, DecisionRequest, DecisionResponse, SessionStatus } from '@/bridge/channelPort'
import { tgmdConvert, tgmdSplit, tgmdTableImage } from '@/utils/tgmdrender'
import { splitHtmlChunks } from '@/utils/formatting'
import { InputFile } from 'grammy'
import { basename } from 'node:path'
import { buildMessageThreadParams, buildChatActionThreadParams } from '@/bridge/sessionManager'
import { completePendingDecision, registerPendingDecision } from './decisionRegistry'

const MAX_MESSAGE_LENGTH = 4000
const TABLE_IMAGE_SEND_TIMEOUT_MS = 10_000
const INVALID_ENTITY_URL_PATTERN = /entity URL .* is invalid|Wrong port number specified in the URL/i
const PATH_LIKE_TOKEN_PATTERN = /\b[A-Za-z]:[\\/][^\s<>"'`()\[\]{}]+|(?<![\w:./\\-])(?:\.{1,2}[\\/])?(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]{1,10}(?::\d+){0,2}\b|(?<![\w:./\\-])[\w.-]+\.[A-Za-z0-9]{1,10}:\d+(?::\d+)?\b/g

export interface TableRecord {
    /** Raw markdown of the table */
    markdown: string
    /** Timestamp when the table was rendered */
    timestamp: number
}

export class TelegramPort implements ChannelPort {
    /** Tables rendered since the last user message */
    private tableHistory: TableRecord[] = []
    /** Timestamp of the last user message received */
    private lastUserMessageTime: number = 0

    constructor(
        private bot: Bot,
        private chatId: number,
        private threadId?: number,
        private onLog?: (message: string) => void,
    ) {}

    async send(message: ChannelMessage): Promise<ChannelSendResult> {
        const { text, format, replyMarkup } = message

        if (message.attachments?.length) {
            return await this.sendAttachments(message)
        }

        switch (format) {
            case 'markdown':
                return await this.sendMarkdown(text, replyMarkup)
            case 'html':
                return await this.sendHtml(text, replyMarkup)
            case 'plain':
                return await this.sendPlain(text, replyMarkup)
        }
    }

    async edit(messageId: string | number, message: ChannelMessage): Promise<void> {
        const { text, format, replyMarkup } = message

        try {
            if (format === 'markdown') {
                const converted = await tgmdConvert(text)
                // For edits, only edit the first text segment (progressive display is short)
                for (const segment of converted) {
                    if (segment.kind === 'text' && segment.text !== undefined) {
                        await this.bot.api.editMessageText(
                            this.chatId,
                            Number(messageId),
                            segment.text,
                            {
                                entities: segment.entities as any,
                                reply_markup: replyMarkup as any,
                                ...buildMessageThreadParams(this.threadId),
                            },
                        )
                        break
                    }
                }
            } else if (format === 'html') {
                // Tool bubbles are short, no chunking needed for edits
                await this.bot.api.editMessageText(
                    this.chatId,
                    Number(messageId),
                    text,
                    {
                        parse_mode: 'HTML',
                        reply_markup: replyMarkup as any,
                        ...buildMessageThreadParams(this.threadId),
                    },
                )
            } else {
                await this.bot.api.editMessageText(
                    this.chatId,
                    Number(messageId),
                    text,
                    {
                        reply_markup: replyMarkup as any,
                        ...buildMessageThreadParams(this.threadId),
                    },
                )
            }
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e)
            // Silently swallow "message is not modified" errors — expected when content hasn't changed
            if (errMsg.includes('message is not modified') || errMsg.includes('MESSAGE_NOT_MODIFIED')) {
                return
            }
            console.error('[TelegramPort] edit failed:', errMsg)
            throw e
        }
    }

    requestDecision(request: DecisionRequest): Promise<DecisionResponse> {
        const { decisionId, promise } = registerPendingDecision({
            fallbackValue: request.type === 'permission' ? 'deny' : '',
        })
        const keyboard = {
            inline_keyboard: [
                request.options.map(opt => ({
                    text: opt.label,
                    callback_data: `decision:${decisionId}:${encodeURIComponent(opt.value)}`,
                })),
            ],
        }

        const text = request.type === 'permission'
            ? `🔐 <b>${this.escapeHtml(request.title)}</b>${request.details ? `\n\n${this.escapeHtml(request.details)}` : ''}`
            : `❓ <b>${this.escapeHtml(request.title)}</b>${request.details ? `\n\n${this.escapeHtml(request.details)}` : ''}`

        this.bot.api.sendMessage(this.chatId, text, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
            ...buildMessageThreadParams(this.threadId),
        }).catch((e) => {
            console.error('[TelegramPort] Failed to send decision request:', e instanceof Error ? e.message : e)
            completePendingDecision(decisionId, request.type === 'permission' ? 'deny' : '')
        })

        return promise
    }

    notifyStatus(status: SessionStatus): void {
        if (status.state !== 'querying') return

        const details = [
            '🔄 Agent started working...',
            `Provider: <code>${this.escapeHtml(status.provider)}</code>`,
            `Cwd: <code>${this.escapeHtml(status.cwd)}</code>`,
        ]
        if (status.model) {
            details.push(`Model: <code>${this.escapeHtml(status.model)}</code>`)
        }

        const text = details.join('\n')
        const options = {
            parse_mode: 'HTML' as const,
            ...buildMessageThreadParams(this.threadId),
        }

        if (status.editMessageId != null) {
            this.bot.api.editMessageText(this.chatId, Number(status.editMessageId), text, options).catch((e) => {
                console.error('[TelegramPort] Failed to edit status notification, falling back to send:', e instanceof Error ? e.message : e)
                this.bot.api.sendMessage(this.chatId, text, options).catch((e2) => {
                    console.error('[TelegramPort] Failed to send status notification:', e2 instanceof Error ? e2.message : e2)
                })
            })
        } else {
            this.bot.api.sendMessage(this.chatId, text, options).catch((e) => {
                console.error('[TelegramPort] Failed to send status notification:', e instanceof Error ? e.message : e)
            })
        }
    }

    sendChatAction(action: string): void {
        this.bot.api.sendChatAction(this.chatId, action as any, buildChatActionThreadParams(this.threadId)).catch(e => console.warn('[telegramPort] sendChatAction failed:', e instanceof Error ? e.message : e))
    }

    /**
     * Called when a user message arrives — marks the boundary for /tables.
     * Clears table history from before this user message.
     */
    notifyUserMessage(): void {
        this.lastUserMessageTime = Date.now()
        // Clear tables from before the previous user message cycle
        this.tableHistory = this.tableHistory.filter(t => t.timestamp >= this.lastUserMessageTime)
    }

    /**
     * Get tables rendered since the last user message.
     * Used by /tables command to retrieve raw markdown of rendered table images.
     */
    getRecentTables(): TableRecord[] {
        if (this.lastUserMessageTime === 0) return this.tableHistory
        return this.tableHistory.filter(t => t.timestamp >= this.lastUserMessageTime)
    }

    // --- Private helpers ---

    private async sendAttachments(message: ChannelMessage): Promise<ChannelSendResult> {
        let firstMessageId: number | undefined
        const caption = message.text.trim()
        const captionOptions = await this.captionOptions(message)

        for (let i = 0; i < (message.attachments ?? []).length; i++) {
            const attachment = message.attachments![i]
            const filename = attachment.filename || basename(attachment.path)
            this.log(`[telegram] sending attachment index=${i + 1}/${message.attachments!.length} type=${attachment.type} path=${attachment.path} filename=${filename} captionChars=${caption.length}`)
            const options = {
                ...(i === 0 && caption ? captionOptions : {}),
                reply_markup: i === 0 ? message.replyMarkup as any : undefined,
                ...buildMessageThreadParams(this.threadId),
            }
            const inputFile = new InputFile(attachment.path, filename)
            const msg = attachment.type === 'photo'
                ? await this.bot.api.sendPhoto(this.chatId, inputFile, options)
                : await this.bot.api.sendDocument(this.chatId, inputFile, options)
            if (firstMessageId === undefined) firstMessageId = msg.message_id
            this.log(`[telegram] sent attachment index=${i + 1}/${message.attachments!.length} type=${attachment.type} messageId=${msg.message_id} filename=${filename}`)
        }

        return { messageId: firstMessageId }
    }

    private async captionOptions(message: ChannelMessage): Promise<Record<string, unknown>> {
        if (!message.text.trim()) return {}
        if (message.format === 'html') {
            return { caption: message.text, parse_mode: 'HTML' }
        }
        if (message.format === 'plain') {
            return { caption: message.text }
        }

        const converted = await tgmdConvert(message.text)
        const firstText = converted.find(segment => segment.kind === 'text' && segment.text !== undefined)
        if (firstText?.kind === 'text') {
            return {
                caption: firstText.text?.replace(/<!--\s*raw\s*-->\s*\n?/g, ''),
                entities: firstText.entities as any,
            }
        }
        return { caption: message.text }
    }

    private async sendMarkdown(text: string, replyMarkup?: unknown): Promise<ChannelSendResult> {
        let converted: Awaited<ReturnType<typeof tgmdSplit>>
        try {
            converted = await tgmdSplit(text, MAX_MESSAGE_LENGTH)
        } catch (e) {
            // Fallback to plain text only when markdown conversion itself fails.
            console.error('[TelegramPort] Markdown conversion failed, falling back to plain:', e instanceof Error ? e.message : e)
            return await this.sendPlain(text, replyMarkup)
        }

        let isFirst = true
        let firstMessageId: number | undefined
        for (const segment of converted) {
            const markup = isFirst ? replyMarkup : undefined
            isFirst = false

            if (segment.kind === 'table' && segment.markdown) {
                // Track the table for /tables command
                this.tableHistory.push({ markdown: segment.markdown, timestamp: Date.now() })
                // Render table as PNG image
                try {
                    const imgBuffer = await withTimeout(
                        tgmdTableImage(segment.markdown),
                        TABLE_IMAGE_SEND_TIMEOUT_MS,
                        'table image rendering',
                    )
                    const msg = await withTimeout(
                        this.bot.api.sendPhoto(this.chatId, new InputFile(imgBuffer, 'table.png'), {
                            ...buildMessageThreadParams(this.threadId),
                        }),
                        TABLE_IMAGE_SEND_TIMEOUT_MS,
                        'table image upload',
                    )
                    if (firstMessageId === undefined) firstMessageId = msg.message_id
                } catch (e) {
                    // Fallback: send table as plain text
                    console.error('[TelegramPort] Table image failed, sending as text:', e instanceof Error ? e.message : e)
                    const result = await this.sendPlain(segment.markdown)
                    if (firstMessageId === undefined && result.messageId !== undefined) {
                        firstMessageId = result.messageId as number
                    }
                }
            } else if (segment.kind === 'text' && segment.text !== undefined) {
                // Strip <!-- raw --> markers from text — they serve as rendering
                // hints (preventing table image conversion) but should not
                // appear in the final message.
                const cleanedText = segment.text.replace(/<!--\s*raw\s*-->\s*\n?/g, '')
                // Adjust entity offsets: removing <!-- raw --> shifts positions
                // For simplicity, if markers were present, strip entities
                // (entity offsets would be wrong after text modification)
                const hadMarker = segment.text !== cleanedText
                const entities = hadMarker ? undefined : segment.entities

                const msg = await this.sendMarkdownTextSegment(cleanedText, entities, markup)
                if (firstMessageId === undefined) firstMessageId = msg.message_id
            }
        }
        return { messageId: firstMessageId }
    }

    private async sendMarkdownTextSegment(
        text: string,
        entities: unknown,
        replyMarkup?: unknown,
    ): Promise<{ message_id: number }> {
        try {
            return await this.bot.api.sendMessage(this.chatId, text, {
                entities: entities as any,
                reply_markup: replyMarkup as any,
                ...buildMessageThreadParams(this.threadId),
            })
        } catch (error) {
            if (!isInvalidEntityUrlError(error)) throw error

            const protectedEntities = createPathCodeEntities(text)
            if (protectedEntities.length === 0) throw error

            console.error('[TelegramPort] Markdown send failed on path-like URL entity; retrying with path code entities:', error instanceof Error ? error.message : error)
            return await this.bot.api.sendMessage(this.chatId, text, {
                entities: protectedEntities as any,
                reply_markup: replyMarkup as any,
                ...buildMessageThreadParams(this.threadId),
            })
        }
    }

    private async sendHtml(text: string, replyMarkup?: unknown): Promise<ChannelSendResult> {
        const chunks = splitHtmlChunks(text, MAX_MESSAGE_LENGTH)
        let firstMessageId: number | undefined
        for (let i = 0; i < chunks.length; i++) {
            const isLast = i === chunks.length - 1
            const msg = await this.bot.api.sendMessage(this.chatId, chunks[i], {
                parse_mode: 'HTML',
                reply_markup: isLast ? replyMarkup as any : undefined,
                ...buildMessageThreadParams(this.threadId),
            })
            if (firstMessageId === undefined) firstMessageId = msg.message_id
        }
        return { messageId: firstMessageId }
    }

    private async sendPlain(text: string, replyMarkup?: unknown): Promise<ChannelSendResult> {
        const chunks = this.splitText(text)
        let firstMessageId: number | undefined
        for (let i = 0; i < chunks.length; i++) {
            const isLast = i === chunks.length - 1
            const msg = await this.bot.api.sendMessage(this.chatId, chunks[i], {
                reply_markup: isLast ? replyMarkup as any : undefined,
                ...buildMessageThreadParams(this.threadId),
            })
            if (firstMessageId === undefined) firstMessageId = msg.message_id
        }
        return { messageId: firstMessageId }
    }

    private splitText(text: string): string[] {
        if (text.length <= MAX_MESSAGE_LENGTH) return [text]
        const chunks: string[] = []
        let remaining = text
        while (remaining.length > 0) {
            if (remaining.length <= MAX_MESSAGE_LENGTH) {
                chunks.push(remaining)
                break
            }
            // Find a safe split point (line break preferred)
            let splitAt = MAX_MESSAGE_LENGTH
            const lastNewline = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH)
            if (lastNewline > MAX_MESSAGE_LENGTH * 0.5) {
                splitAt = lastNewline + 1
            }
            chunks.push(remaining.slice(0, splitAt))
            remaining = remaining.slice(splitAt)
        }
        return chunks
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
    }

    private log(message: string): void {
        this.onLog?.(message)
    }
}

class TelegramPortTimeoutError extends Error {
    constructor(operation: string, timeoutMs: number) {
        super(`${operation} timed out after ${timeoutMs}ms`)
        this.name = 'TelegramPortTimeoutError'
    }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TelegramPortTimeoutError(operation, timeoutMs)), timeoutMs)
    })
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer)
    })
}

function isInvalidEntityUrlError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return INVALID_ENTITY_URL_PATTERN.test(message)
}

function createPathCodeEntities(text: string): Array<{ type: 'code'; offset: number; length: number }> {
    const entities: Array<{ type: 'code'; offset: number; length: number }> = []
    for (const match of text.matchAll(PATH_LIKE_TOKEN_PATTERN)) {
        const raw = match[0]
        const index = match.index
        if (index === undefined) continue

        const token = trimPathToken(raw)
        if (!token) continue

        const start = index + raw.indexOf(token)
        const end = start + token.length
        if (entities.some(entity => rangesOverlap(start, end, entity.offset, entity.offset + entity.length))) {
            continue
        }
        entities.push({
            type: 'code',
            offset: utf16Length(text.slice(0, start)),
            length: utf16Length(token),
        })
    }
    return entities
}

function trimPathToken(token: string): string {
    return token.replace(/[.,;:!?]+$/g, '')
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
    return startA < endB && startB < endA
}

function utf16Length(text: string): number {
    return text.length
}
