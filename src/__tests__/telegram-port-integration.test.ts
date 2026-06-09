import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TelegramPort } from '@/channel/telegram/telegramPort'
import { clearPendingDecisionsForTests, completePendingDecision } from '@/channel/telegram/decisionRegistry'

const renderMocks = vi.hoisted(() => ({
    tgmdConvert: vi.fn(),
    tgmdTableImage: vi.fn(),
}))

vi.mock('@/utils/tgmdrender', () => ({
    tgmdConvert: renderMocks.tgmdConvert,
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
        renderMocks.tgmdConvert.mockResolvedValue([
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

    it('clears old table history when a new user-message boundary begins', async () => {
        renderMocks.tgmdConvert.mockResolvedValue([
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
