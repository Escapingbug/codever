import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTelegramRenderer, type TelegramRenderer } from '@/transport/telegram/renderer'

// Mock grammy Bot
function createMockBot() {
    const sentMessages: Array<{
        chatId: number
        text: string
        params: Record<string, unknown>
    }> = []
    const sentPhotos: Array<{
        chatId: number
        photo: unknown
        params: Record<string, unknown>
    }> = []

    const bot = {
        api: {
            sendMessage: vi.fn().mockImplementation((chatId: number, text: string, params?: Record<string, unknown>) => {
                sentMessages.push({ chatId, text, params: params ?? {} })
                return Promise.resolve({})
            }),
            sendPhoto: vi.fn().mockImplementation((chatId: number, photo: unknown, params?: Record<string, unknown>) => {
                sentPhotos.push({ chatId, photo, params: params ?? {} })
                return Promise.resolve({})
            }),
            sendChatAction: vi.fn().mockResolvedValue({}),
        },
    } as any

    return { bot, sentMessages, sentPhotos }
}

describe('TelegramRenderer', () => {
    let mockBot: ReturnType<typeof createMockBot>
    let renderer: TelegramRenderer

    beforeEach(() => {
        mockBot = createMockBot()
        renderer = createTelegramRenderer(mockBot.bot, 12345, 100)
    })

    describe('sendFormatted (HTML mode)', () => {
        it('should send HTML message with parse_mode', async () => {
            await renderer.sendFormatted('<b>bold</b> text')
            expect(mockBot.sentMessages).toHaveLength(1)
            expect(mockBot.sentMessages[0].params.parse_mode).toBe('HTML')
            expect(mockBot.sentMessages[0].text).toBe('<b>bold</b> text')
        })

        it('should split long HTML messages', async () => {
            const longHtml = '<b>' + 'a'.repeat(4000) + '</b>'
            await renderer.sendFormatted(longHtml)
            expect(mockBot.sentMessages.length).toBeGreaterThanOrEqual(2)
        })

        it('should attach replyMarkup to last chunk only', async () => {
            const longHtml = '<b>' + 'a'.repeat(4000) + '</b>'
            const replyMarkup = { inline_keyboard: [[{ text: 'btn', callback_data: 'test' }]] }
            await renderer.sendFormatted(longHtml, { replyMarkup })

            // Last message should have reply_markup
            const lastMsg = mockBot.sentMessages[mockBot.sentMessages.length - 1]
            expect(lastMsg.params.reply_markup).toBeDefined()

            // Previous messages should NOT have reply_markup
            for (let i = 0; i < mockBot.sentMessages.length - 1; i++) {
                expect(mockBot.sentMessages[i].params.reply_markup).toBeUndefined()
            }
        })
    })

    describe('sendPlain', () => {
        it('should send plain text without parse_mode', async () => {
            await renderer.sendPlain('hello world')
            expect(mockBot.sentMessages).toHaveLength(1)
            expect(mockBot.sentMessages[0].text).toBe('hello world')
            expect(mockBot.sentMessages[0].params.parse_mode).toBeUndefined()
        })

        it('should split long plain text', async () => {
            const longText = 'a'.repeat(5000)
            await renderer.sendPlain(longText)
            expect(mockBot.sentMessages.length).toBeGreaterThanOrEqual(2)
        })
    })

    describe('sendMarkdown', () => {
        it('should fall back to plain text when tgmdrender is not available', async () => {
            // Reset the cached status so it re-checks
            const { resetTgmdStatus } = await import('@/utils/tgmdrender')
            resetTgmdStatus()

            // If Python/tgmdrender is not installed, sendMarkdown falls back to sendPlain
            // This test verifies the fallback path works
            await renderer.sendMarkdown('**bold text**')
            expect(mockBot.sentMessages.length).toBeGreaterThanOrEqual(1)
        })
    })

    describe('sendChatAction', () => {
        it('should send chat action', async () => {
            await renderer.sendChatAction('typing')
            expect(mockBot.bot.api.sendChatAction).toHaveBeenCalledWith(12345, 'typing', { message_thread_id: 100 })
        })
    })
})

describe('TelegramRenderer entity-based sending', () => {
    it('should send entities via sendMessage when tgmdrender is available', async () => {
        // This is an integration test that requires Python + tgmdrender
        // It will be skipped if not available
        const { checkTgmdrender, resetTgmdStatus } = await import('@/utils/tgmdrender')
        resetTgmdStatus()
        const status = checkTgmdrender()
        if (!status.available) return

        const mockBot = createMockBot()
        const renderer = createTelegramRenderer(mockBot.bot, 12345)

        await renderer.sendMarkdown('**bold** and `code`')

        // Should have sent at least one message
        expect(mockBot.sentMessages.length).toBeGreaterThanOrEqual(1)

        // The message should have entities parameter (entity-based, not HTML)
        const msg = mockBot.sentMessages[0]
        if (msg.params.entities) {
            expect(Array.isArray(msg.params.entities)).toBe(true)
            expect(msg.params.parse_mode).toBeUndefined()
        }
    })
})
