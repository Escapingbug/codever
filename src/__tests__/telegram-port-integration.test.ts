import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TelegramPort } from '@/channel/telegram/telegramPort'
import { clearPendingDecisionsForTests, completePendingDecision } from '@/channel/telegram/decisionRegistry'

const renderMocks = vi.hoisted(() => ({
    tgmdConvert: vi.fn(),
    tgmdSplit: vi.fn(),
    tgmdTableImage: vi.fn(),
}))

vi.mock('@/utils/tgmdrender', () => ({
    tgmdConvert: renderMocks.tgmdConvert,
    tgmdSplit: renderMocks.tgmdSplit,
    tgmdTableImage: renderMocks.tgmdTableImage,
}))

vi.mock('grammy', () => ({
    InputFile: vi.fn(function InputFile(buffer: Buffer, filename: string) {
        return { buffer, filename }
    }),
}))

function createBot() {
    return {
        api: {
            sendMessage: vi.fn(async () => ({ message_id: 1 })),
            editMessageText: vi.fn(async () => ({})),
            sendPhoto: vi.fn(async () => ({ message_id: 2 })),
            sendChatAction: vi.fn(async () => ({})),
        },
    } as any
}

describe('TelegramPort integration', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-05-09T12:00:00Z'))
        vi.clearAllMocks()
        renderMocks.tgmdConvert.mockResolvedValue([{ kind: 'text', text: 'rendered text', entities: [] }])
        renderMocks.tgmdSplit.mockResolvedValue([{ kind: 'text', text: 'rendered text', entities: [] }])
        renderMocks.tgmdTableImage.mockResolvedValue(Buffer.from('png'))
    })

    afterEach(() => {
        clearPendingDecisionsForTests()
        vi.useRealTimers()
    })

    it('renders channel decision requests into Telegram inline keyboard messages', async () => {
        const bot = createBot()
        const port = new TelegramPort(bot, -100, 10)

        const response = port.requestDecision({
            type: 'permission',
            title: 'Run Bash?',
            details: 'rm -rf tmp',
            options: [
                { label: 'Allow', value: 'allow' },
                { label: 'Deny', value: 'deny' },
            ],
        })

        expect(bot.api.sendMessage).toHaveBeenCalledWith(-100, expect.stringContaining('Run Bash?'), expect.objectContaining({
            parse_mode: 'HTML',
            message_thread_id: 10,
            reply_markup: {
                inline_keyboard: [[
                    expect.objectContaining({ text: 'Allow', callback_data: expect.stringContaining('allow') }),
                    expect.objectContaining({ text: 'Deny', callback_data: expect.stringContaining('deny') }),
                ]],
            },
        }))

        const markup = bot.api.sendMessage.mock.calls[0][2].reply_markup
        const callbackData = markup.inline_keyboard[0][0].callback_data
        const [, decisionId, encodedValue] = callbackData.split(':')
        completePendingDecision(decisionId, decodeURIComponent(encodedValue))
        await expect(response).resolves.toEqual({ value: 'allow' })
    })

    it('tracks rendered markdown tables so /tables can return raw table markdown', async () => {
        renderMocks.tgmdSplit.mockResolvedValue([
            { kind: 'text', text: 'before table', entities: [] },
            { kind: 'table', markdown: '| A |\n|---|\n| 1 |' },
        ])
        const bot = createBot()
        const port = new TelegramPort(bot, -100, 10)

        await port.send({ text: '| A |\n|---|\n| 1 |', format: 'markdown' })

        expect(bot.api.sendPhoto).toHaveBeenCalled()
        expect(port.getRecentTables()).toEqual([
            expect.objectContaining({ markdown: '| A |\n|---|\n| 1 |' }),
        ])
    })

    it('splits long markdown output before sending to Telegram', async () => {
        renderMocks.tgmdSplit.mockResolvedValue([
            { kind: 'text', text: 'A'.repeat(3900), entities: [] },
            { kind: 'text', text: 'B'.repeat(3900), entities: [] },
        ])
        const bot = createBot()
        const port = new TelegramPort(bot, -100, 10)

        await port.send({ text: `${'A'.repeat(3900)}${'B'.repeat(3900)}`, format: 'markdown' })

        expect(renderMocks.tgmdSplit).toHaveBeenCalledWith(expect.any(String), 4000)
        expect(bot.api.sendMessage).toHaveBeenCalledTimes(2)
        expect(bot.api.sendMessage.mock.calls[0][1]).toBe('A'.repeat(3900))
        expect(bot.api.sendMessage.mock.calls[1][1]).toBe('B'.repeat(3900))
    })

    it('continues sending markdown text after table image fallback', async () => {
        renderMocks.tgmdSplit.mockResolvedValue([
            { kind: 'text', text: 'before table', entities: [] },
            { kind: 'table', markdown: '| A |\n|---|\n| 1 |' },
            { kind: 'text', text: 'after table', entities: [] },
        ])
        renderMocks.tgmdTableImage.mockRejectedValue(new Error('render failed'))
        const bot = createBot()
        const port = new TelegramPort(bot, -100, 10)

        await port.send({ text: 'before\n| A |\n|---|\n| 1 |\nafter', format: 'markdown' })

        expect(bot.api.sendMessage).toHaveBeenCalledTimes(3)
        expect(bot.api.sendMessage.mock.calls[0][1]).toBe('before table')
        expect(bot.api.sendMessage.mock.calls[1][1]).toBe('| A |\n|---|\n| 1 |')
        expect(bot.api.sendMessage.mock.calls[2][1]).toBe('after table')
    })

    it('clears old table history when a new user-message boundary begins', async () => {
        renderMocks.tgmdSplit.mockResolvedValue([
            { kind: 'table', markdown: '| Old |\n|---|\n| 1 |' },
        ])
        const port = new TelegramPort(createBot(), -100, 10)

        await port.send({ text: 'old table', format: 'markdown' })
        vi.advanceTimersByTime(1_000)
        port.notifyUserMessage()

        expect(port.getRecentTables()).toEqual([])
    })

    it('ignores Telegram not-modified edit errors', async () => {
        const bot = createBot()
        bot.api.editMessageText.mockRejectedValue(new Error("Call to 'editMessageText' failed! (400: Bad Request: message is not modified)"))
        const port = new TelegramPort(bot, -100, 10)

        await expect(port.edit(123, { text: 'same text', format: 'html' })).resolves.toBeUndefined()
    })

    it('propagates retryable Telegram edit errors to the delivery outbox', async () => {
        const retryAfter = new Error("Call to 'editMessageText' failed! (429: Too Many Requests: retry after 42)")
        const bot = createBot()
        bot.api.editMessageText.mockRejectedValue(retryAfter)
        const port = new TelegramPort(bot, -100, 10)

        await expect(port.edit(123, { text: 'updated text', format: 'html' })).rejects.toBe(retryAfter)
    })

    it('does not treat Telegram send failures as markdown conversion failures', async () => {
        const retryAfter = new Error("Call to 'sendMessage' failed! (429: Too Many Requests: retry after 42)")
        const bot = createBot()
        bot.api.sendMessage.mockRejectedValue(retryAfter)
        const port = new TelegramPort(bot, -100, 10)

        await expect(port.send({ text: '**hello**', format: 'markdown' })).rejects.toBe(retryAfter)
        expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    })

    it('retries markdown sends with path code entities when Telegram rejects a path-like URL', async () => {
        renderMocks.tgmdSplit.mockResolvedValue([{
            kind: 'text',
            text: 'See D:/personal/facere/CLAUDE.md:1 for details.',
            entities: [],
        }])
        const invalidUrl = new Error("Call to 'sendMessage' failed! (400: Bad Request: entity URL 'D:/personal/facere/CLAUDE.md:1' is invalid: Wrong port number specified in the URL)")
        const bot = createBot()
        bot.api.sendMessage
            .mockRejectedValueOnce(invalidUrl)
            .mockResolvedValueOnce({ message_id: 9 })
        const port = new TelegramPort(bot, -100, 10)

        await expect(port.send({ text: 'See D:/personal/facere/CLAUDE.md:1 for details.', format: 'markdown' })).resolves.toEqual({ messageId: 9 })

        expect(bot.api.sendMessage).toHaveBeenCalledTimes(2)
        expect(bot.api.sendMessage.mock.calls[1][1]).toBe('See D:/personal/facere/CLAUDE.md:1 for details.')
        expect(bot.api.sendMessage.mock.calls[1][2]).toMatchObject({
            entities: [
                { type: 'code', offset: 4, length: 'D:/personal/facere/CLAUDE.md:1'.length },
            ],
            message_thread_id: 10,
        })
    })

    it('decision callback data should be routable back to the semantic runtime', async () => {
        const bot = createBot()
        const port = new TelegramPort(bot, -100, 10)

        const response = port.requestDecision({
            type: 'question',
            title: 'Choose mode',
            options: [{ label: 'Plan', value: 'plan' }],
        })

        const markup = bot.api.sendMessage.mock.calls[0][2].reply_markup
        const callbackData = markup.inline_keyboard[0][0].callback_data
        expect(callbackData).toMatch(/^decision:[^:]+:plan$/)
        const [, decisionId, encodedValue] = callbackData.split(':')
        completePendingDecision(decisionId, decodeURIComponent(encodedValue))
        await expect(response).resolves.toEqual({ value: 'plan' })
    })
})
