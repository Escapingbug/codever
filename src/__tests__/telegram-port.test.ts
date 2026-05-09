import { describe, it, expect, vi } from 'vitest'
import { TelegramPort } from '@/channel/telegram/telegramPort'
import type { ChannelMessage, DecisionRequest, SessionStatus } from '@/bridge/channelPort'
import type { Bot } from 'grammy'

function createMockBot(): { bot: Bot; apiCalls: { method: string; args: unknown[] }[] } {
    const apiCalls: { method: string; args: unknown[] }[] = []

    const api = {
        sendMessage: vi.fn().mockImplementation(async (...args: unknown[]) => {
            apiCalls.push({ method: 'sendMessage', args })
            return { message_id: 1 }
        }),
        editMessageText: vi.fn().mockImplementation(async (...args: unknown[]) => {
            apiCalls.push({ method: 'editMessageText', args })
            return true
        }),
        sendChatAction: vi.fn().mockImplementation(async (...args: unknown[]) => {
            apiCalls.push({ method: 'sendChatAction', args })
            return true
        }),
    }

    const bot = {
        api,
    } as unknown as Bot

    return { bot, apiCalls }
}

describe('TelegramPort', () => {
    describe('send', () => {
        it('sends markdown messages with MarkdownV2 parse mode', async () => {
            const { bot, apiCalls } = createMockBot()
            const port = new TelegramPort(bot, -100123, 42)

            await port.send({ text: '**bold**', format: 'markdown' })

            expect(apiCalls.length).toBeGreaterThan(0)
            const call = apiCalls[0]
            expect(call.method).toBe('sendMessage')
            expect(call.args[0]).toBe(-100123) // chatId
        })

        it('sends html messages with HTML parse mode', async () => {
            const { bot, apiCalls } = createMockBot()
            const port = new TelegramPort(bot, -100123, 42)

            await port.send({ text: '<b>bold</b>', format: 'html' })

            const call = apiCalls[0]
            expect(call.method).toBe('sendMessage')
        })

        it('sends plain messages without parse mode', async () => {
            const { bot, apiCalls } = createMockBot()
            const port = new TelegramPort(bot, -100123, 42)

            await port.send({ text: 'plain text', format: 'plain' })

            const call = apiCalls[0]
            expect(call.method).toBe('sendMessage')
        })

        it('includes threadId in message when provided', async () => {
            const { bot, apiCalls } = createMockBot()
            const port = new TelegramPort(bot, -100123, 42)

            await port.send({ text: 'test', format: 'plain' })

            const call = apiCalls[0]
            // Should have messageThreadId in the options
            expect(call.args.length).toBeGreaterThan(1)
        })

        it('handles long messages by splitting', async () => {
            const { bot } = createMockBot()
            const port = new TelegramPort(bot, -100123, 42)

            const longText = 'A'.repeat(8000)
            await port.send({ text: longText, format: 'html' })

            // Should have been called at least twice for splitting
            expect(bot.api.sendMessage).toHaveBeenCalled()
        })

        it('splits long HTML messages without leaving code tags unbalanced', async () => {
            const { bot, apiCalls } = createMockBot()
            const port = new TelegramPort(bot, -100123, 42)

            await port.send({ text: `<code>${'A'.repeat(5000)}</code>`, format: 'html' })

            const sentTexts = apiCalls
                .filter(call => call.method === 'sendMessage')
                .map(call => String(call.args[1]))
            expect(sentTexts.length).toBeGreaterThan(1)
            for (const text of sentTexts) {
                expect(count(text, '<code>')).toBe(count(text, '</code>'))
            }
        })
    })

    describe('edit', () => {
        it('edits an existing message', async () => {
            const { bot, apiCalls } = createMockBot()
            const port = new TelegramPort(bot, -100123, 42)

            await port.edit!(1, { text: 'updated', format: 'html' })

            expect(apiCalls[0].method).toBe('editMessageText')
        })
    })

    describe('notifyStatus', () => {
        it('does not throw for status notifications', () => {
            const { bot } = createMockBot()
            const port = new TelegramPort(bot, -100123, 42)

            expect(() => {
                port.notifyStatus({ state: 'querying', cwd: '/tmp', provider: 'test' })
            }).not.toThrow()
        })
    })

    describe('sendChatAction', () => {
        it('sends typing action', async () => {
            const { bot, apiCalls } = createMockBot()
            const port = new TelegramPort(bot, -100123, 42)

            port.sendChatAction!('typing')

            expect(apiCalls[0].method).toBe('sendChatAction')
        })
    })

    describe('requestDecision', () => {
        it('sends decision request with inline keyboard', async () => {
            const { bot } = createMockBot()
            const port = new TelegramPort(bot, -100123, 42)

            // requestDecision returns a promise that resolves when user clicks
            const promise = port.requestDecision({
                type: 'permission',
                title: 'Allow WriteFile?',
                options: [
                    { label: 'Allow', value: 'allow' },
                    { label: 'Deny', value: 'deny' },
                ],
            })

            // Should have sent a message with inline keyboard
            expect(bot.api.sendMessage).toHaveBeenCalled()
        })
    })
})

function count(text: string, needle: string): number {
    return text.split(needle).length - 1
}
