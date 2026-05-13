import { afterEach, describe, it, expect, vi } from 'vitest'
import { TelegramPort } from '@/channel/telegram/telegramPort'
import type { ChannelMessage, DecisionRequest, SessionStatus } from '@/bridge/channelPort'
import type { Bot } from 'grammy'
import { clearPendingDecisionsForTests, completePendingDecision, pendingDecisionCount } from '@/channel/telegram/decisionRegistry'

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
    afterEach(() => {
        clearPendingDecisionsForTests()
    })

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

        it('preserves inline keyboard markup when editing a message', async () => {
            const { bot, apiCalls } = createMockBot()
            const port = new TelegramPort(bot, -100123, 42)
            const replyMarkup = {
                inline_keyboard: [[{ text: 'Read f1', callback_data: 'file:f1' }]],
            }

            await port.edit!(1, { text: 'updated', format: 'html', replyMarkup })

            expect(apiCalls[0].method).toBe('editMessageText')
            expect(apiCalls[0].args[3]).toEqual(expect.objectContaining({
                reply_markup: replyMarkup,
            }))
        })
    })

    describe('notifyStatus', () => {
        it('sends an acknowledgement with provider, cwd, and model when a query starts', () => {
            const { bot, apiCalls } = createMockBot()
            const port = new TelegramPort(bot, -100123, 42)

            port.notifyStatus({ state: 'querying', cwd: '/tmp/<repo>', provider: 'test&provider', model: 'model<1>' })

            expect(apiCalls[0]).toEqual({
                method: 'sendMessage',
                args: [
                    -100123,
                    [
                        '🔄 Agent started working...',
                        'Provider: <code>test&amp;provider</code>',
                        'Cwd: <code>/tmp/&lt;repo&gt;</code>',
                        'Model: <code>model&lt;1&gt;</code>',
                    ].join('\n'),
                    expect.objectContaining({
                        parse_mode: 'HTML',
                        message_thread_id: 42,
                    }),
                ],
            })
        })

        it('omits model from the acknowledgement when no model is selected', () => {
            const { bot, apiCalls } = createMockBot()
            const port = new TelegramPort(bot, -100123, 42)

            port.notifyStatus({ state: 'querying', cwd: '/tmp', provider: 'test' })

            expect(String(apiCalls[0].args[1])).toBe([
                '🔄 Agent started working...',
                'Provider: <code>test</code>',
                'Cwd: <code>/tmp</code>',
            ].join('\n'))
        })

        it('does not send status messages for idle transitions', () => {
            const { bot } = createMockBot()
            const port = new TelegramPort(bot, -100123, 42)

            port.notifyStatus({ state: 'idle', cwd: '/tmp', provider: 'test' })

            expect(bot.api.sendMessage).not.toHaveBeenCalled()
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
        it('sends decision request and waits for callback resolution', async () => {
            const { bot, apiCalls } = createMockBot()
            const port = new TelegramPort(bot, -100123, 42)

            const promise = port.requestDecision({
                type: 'permission',
                title: 'Allow WriteFile?',
                options: [
                    { label: 'Allow', value: 'allow' },
                    { label: 'Deny', value: 'deny' },
                ],
            })

            expect(bot.api.sendMessage).toHaveBeenCalled()
            expect(pendingDecisionCount()).toBe(1)

            let resolved = false
            promise.then(() => { resolved = true })
            await Promise.resolve()
            expect(resolved).toBe(false)

            const options = apiCalls[0].args[2] as { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } }
            const callbackData = options.reply_markup.inline_keyboard[0][1].callback_data
            const [, decisionId, encodedValue] = callbackData.split(':')
            expect(decodeURIComponent(encodedValue)).toBe('deny')

            expect(completePendingDecision(decisionId, decodeURIComponent(encodedValue))).toBe(true)
            await expect(promise).resolves.toEqual({ value: 'deny' })
            expect(pendingDecisionCount()).toBe(0)
        })
    })
})

function count(text: string, needle: string): number {
    return text.split(needle).length - 1
}
