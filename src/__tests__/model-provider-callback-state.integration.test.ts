import { describe, expect, it, vi } from 'vitest'
import { registerSettingsHandlers } from '@/channel/telegram/handlers/settings'
import { registerCallbackHandlers } from '@/channel/telegram/handlers/callbacks'
import type { TopicSession } from '@/bridge/channelPort'

const providers = vi.hoisted(() => {
    const opencode = {
        name: 'opencode',
        getAvailableModels: vi.fn(() => [
            { id: 'opencode/big-pickle', name: 'big-pickle', provider: 'opencode' },
            { id: 'codebuddy/claude-sonnet-4.6', name: 'claude-sonnet-4.6', provider: 'codebuddy' },
        ]),
        getAvailablePermissionModes: vi.fn(() => ['default']),
        isReady: vi.fn(() => true),
        getInitError: vi.fn(() => null),
        startQuery: vi.fn(),
    }
    const agent = {
        name: 'agent',
        getAvailableModels: vi.fn(() => [
            { id: 'composer-2.5-fast', name: 'Composer 2.5 Fast', provider: 'cursor' },
        ]),
        getAvailablePermissionModes: vi.fn(() => ['default']),
        isReady: vi.fn(() => true),
        getInitError: vi.fn(() => null),
        startQuery: vi.fn(),
    }
    return { opencode, agent }
})

vi.mock('@/config', () => ({
    config: {
        getDefaultProvider: vi.fn(() => 'agent'),
    },
}))

vi.mock('@/providers/registry', () => ({
    getProvider: vi.fn((name: string) => providers[name as 'opencode' | 'agent']),
    getDefaultProvider: vi.fn(() => providers.agent),
    listProviders: vi.fn(() => ['opencode', 'agent']),
}))

function createBot() {
    const commands = new Map<string, (ctx: any) => Promise<void>>()
    const handlers = new Map<string, (ctx: any) => Promise<void>>()
    return {
        command(name: string | string[], handler: (ctx: any) => Promise<void>) {
            for (const n of Array.isArray(name) ? name : [name]) {
                commands.set(n, handler)
            }
        },
        on(name: string, handler: (ctx: any) => Promise<void>) {
            handlers.set(name, handler)
        },
        async runCommand(name: string, ctx: any) {
            const handler = commands.get(name)
            if (!handler) throw new Error(`No command registered: ${name}`)
            await handler(ctx)
        },
        async runCallback(data: string) {
            const handler = handlers.get('callback_query:data')
            if (!handler) throw new Error('No callback handler registered')
            const ctx = createCallbackContext(data)
            await handler(ctx)
            return ctx
        },
    }
}

function createCommandContext() {
    const replies: Array<{ text: string; options?: any }> = []
    return {
        chat: { id: -100, type: 'supergroup' },
        message: { message_thread_id: 10, text: '/model' },
        match: '',
        replies,
        reply: vi.fn(async (text: string, options?: any) => {
            replies.push({ text, options })
        }),
    }
}

function createCallbackContext(data: string) {
    return {
        callbackQuery: {
            data,
            message: {
                chat: { id: -100, type: 'supergroup' },
                message_thread_id: 10,
            },
        },
        answerCallbackQuery: vi.fn(async () => {}),
        editMessageText: vi.fn(async (_text: string, _options?: any) => {}),
    }
}

function createSessionManager() {
    return {
        getGroupSettings: vi.fn(() => ({ providerName: 'agent' })),
        setGroupSettings: vi.fn(),
        getTopicSettings: vi.fn(() => undefined),
        setTopicSettings: vi.fn(),
    } as any
}

function createTopicSession(): TopicSession {
    return {
        receiveInput: vi.fn(),
        dispatch: vi.fn(async () => {}),
        destroy: vi.fn(async () => {}),
        get state() { return 'idle' as const },
        sessionRecord: {
            id: 'session-1',
            state: 'idle',
            conversationId: 'conv-1',
            cwd: '/repo',
            model: null,
            providerName: 'opencode',
            verboseLevel: 1,
            timeoutSeconds: 180,
            providerSettings: {},
            availableCommands: [],
            groupChatId: -100,
            messageThreadId: 10,
            setProvider: vi.fn(),
            setProviderName: vi.fn(),
            setConversationId: vi.fn(),
            setModel: vi.fn(),
            setVerboseLevel: vi.fn(),
            setTimeoutSeconds: vi.fn(),
            setTimeoutExtended: vi.fn(),
            destroy: vi.fn(async () => {}),
            bus: { emit: vi.fn(), on: vi.fn() },
        } as any,
        channelPort: {} as any,
        getProgress: vi.fn(() => null),
        getDeliveryStatus: vi.fn(() => ({ deliveries: [] })),
    }
}

function flattenButtonTexts(keyboard: unknown): string[] {
    const rows = (keyboard as { inline_keyboard?: Array<Array<{ text: string }>> }).inline_keyboard ?? []
    return rows.flat().map(button => button.text)
}

describe('model provider callback state integration', () => {
    it('keeps model-provider drilldown on the current session provider after /model', async () => {
        const bot = createBot()
        const sessionManager = createSessionManager()
        const topicSessions = new Map<string, TopicSession>([['-100:10', createTopicSession()]])
        registerSettingsHandlers(bot, { sessionManager, topicSessions })
        registerCallbackHandlers(bot, { sessionManager, topicSessions })

        const commandCtx = createCommandContext()
        await bot.runCommand('model', commandCtx)
        const providerButtons = flattenButtonTexts(commandCtx.replies[0].options.reply_markup)
        expect(providerButtons).toContain('codebuddy (1)')
        expect(providerButtons).not.toContain('cursor (1)')

        const callbackCtx = await bot.runCallback('mprov:codebuddy')
        const detailMarkup = callbackCtx.editMessageText.mock.calls[0]![1]!.reply_markup
        expect(flattenButtonTexts(detailMarkup)).toContain('claude-sonnet-4.6')

        const backCtx = await bot.runCallback('mprov:back')
        const backMarkup = backCtx.editMessageText.mock.calls[0]![1]!.reply_markup
        expect(flattenButtonTexts(backMarkup)).toContain('codebuddy (1)')
        expect(flattenButtonTexts(backMarkup)).not.toContain('cursor (1)')
    })
})
