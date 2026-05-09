import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerMessageRouter } from '@/transport/telegram/handlers/messageRouter'

const mocks = vi.hoisted(() => ({
    createQueryLoop: vi.fn(),
    createTopicSession: vi.fn(),
    getProvider: vi.fn(() => ({ name: 'mock-provider' })),
    createProviderInstance: vi.fn(() => ({ name: 'mock-provider' })),
    getDefaultProvider: vi.fn(() => 'mock-acp'),
    getTopicState: vi.fn((): any => undefined),
    clearTopicQueryInProgress: vi.fn(),
}))

vi.mock('@/channel/telegram/pairing', () => ({
    pairing: { isAuthorized: vi.fn(() => true) },
}))

vi.mock('@/config', () => ({
    config: {
        getDefaultProvider: mocks.getDefaultProvider,
        getTopicState: mocks.getTopicState,
        clearTopicQueryInProgress: mocks.clearTopicQueryInProgress,
    },
}))

vi.mock('@/providers/registry', () => ({
    getProvider: mocks.getProvider,
    createProviderInstance: mocks.createProviderInstance,
}))

vi.mock('@/bridge/topicSession', () => ({
    createQueryLoop: mocks.createQueryLoop,
    createTopicSession: mocks.createTopicSession,
}))

vi.mock('@/channel/telegram/telegramPort', () => ({
    TelegramPort: vi.fn(function TelegramPort() {
        return {
            sendChatAction: vi.fn(),
            send: vi.fn(),
            edit: vi.fn(),
        }
    }),
}))

vi.mock('@/middleware/pipeline', () => ({
    createMiddlewarePipeline: vi.fn(() => ({
        getTimeout: vi.fn(() => ({
            updateTimeoutSeconds: vi.fn(),
            stop: vi.fn(),
        })),
    })),
}))

vi.mock('@/middleware/formatting', () => ({
    createFormattingMiddleware: vi.fn(() => ({})),
}))

vi.mock('@/middleware/timeout', () => ({
    createTimeoutMiddleware: vi.fn(() => ({})),
}))

function createBot() {
    const handlers = new Map<string, (ctx: any) => Promise<void>>()
    return {
        api: {
            sendChatAction: vi.fn(async () => {}),
            sendMessage: vi.fn(async () => {}),
        },
        on(name: string, handler: (ctx: any) => Promise<void>) {
            handlers.set(name, handler)
        },
        async emitMessage(ctx: any) {
            const handler = handlers.get('message:text')
            if (!handler) throw new Error('message:text handler was not registered')
            await handler(ctx)
        },
        async emitMyChatMember(ctx: any) {
            const handler = handlers.get('my_chat_member')
            if (!handler) throw new Error('my_chat_member handler was not registered')
            await handler(ctx)
        },
    }
}

function createQueryLoop() {
    const listeners: Record<string, Array<(event: any) => void>> = {}
    return {
        id: 'query-loop-1',
        providerName: 'mock-acp',
        timeoutSeconds: 180,
        groupChatId: null,
        messageThreadId: null,
        bus: {
            on: vi.fn((eventName: string, handler: (event: any) => void) => {
                listeners[eventName] ??= []
                listeners[eventName].push(handler)
            }),
            emit: vi.fn((event: any) => {
                for (const handler of listeners[event.type] ?? []) handler(event)
            }),
        },
        onTimeoutSecondsChange: undefined as ((seconds: number) => void) | undefined,
        onLog: undefined as ((message: string) => void) | undefined,
    }
}

function createTopicSession() {
    return {
        receiveInput: vi.fn(),
        dispatch: vi.fn(async () => {}),
        destroy: vi.fn(async () => {}),
        state: 'idle',
        queryLoop: createQueryLoop(),
        channelPort: {},
        getProgress: vi.fn(() => null),
    }
}

function createSessionManager(overrides: Partial<any> = {}) {
    return {
        isGroupArchived: vi.fn(() => false),
        isGroupInCooldown: vi.fn(() => false),
        getGroupCwd: vi.fn(() => '/repo'),
        tryAcquireCreationLock: vi.fn(() => true),
        releaseCreationLock: vi.fn(),
        getGroupSettings: vi.fn(() => ({ providerName: 'mock-acp', model: 'sonnet', timeoutSeconds: 240 })),
        registerSession: vi.fn(),
        registerTopicSession: vi.fn(),
        removeTopicSession: vi.fn(),
        removeSession: vi.fn(),
        clearGroupFailures: vi.fn(),
        hasSessionInGroup: vi.fn(() => false),
        ...overrides,
    } as any
}

function createMessageContext(text = 'hello codever', threadId = 10) {
    const replies: Array<{ text: string; options?: unknown }> = []
    return {
        chat: { id: -100, type: 'supergroup', title: 'dev' },
        from: { id: 1, username: 'alice', first_name: 'Alice' },
        message: { text, message_thread_id: threadId },
        replies,
        reply: vi.fn(async (replyText: string, options?: unknown) => {
            replies.push({ text: replyText, options })
        }),
    }
}

describe('Telegram message router integration', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getDefaultProvider.mockReturnValue('mock-acp')
        mocks.getTopicState.mockReturnValue(undefined)
        mocks.getProvider.mockImplementation(() => ({ name: 'mock-provider' }))
        mocks.createProviderInstance.mockImplementation(() => ({ name: 'mock-provider' }))
        mocks.createQueryLoop.mockImplementation(createQueryLoop)
        mocks.createTopicSession.mockImplementation(() => createTopicSession())
    })

    it('creates a topic session on the first authorized group message and forwards user input', async () => {
        const bot = createBot()
        const topicSessions = new Map<string, any>()
        const sessionManager = createSessionManager({
            registerTopicSession: vi.fn((topicKey: string, session: any) => topicSessions.set(topicKey, session)),
        })
        registerMessageRouter(bot, { sessionManager, topicSessions, bot: bot as any })

        await bot.emitMessage(createMessageContext('please inspect tests'))

        expect(mocks.createQueryLoop).toHaveBeenCalledWith(expect.objectContaining({
            cwd: '/repo',
            providerName: 'mock-acp',
            groupChatId: -100,
            messageThreadId: 10,
            model: 'sonnet',
            timeoutSeconds: 240,
        }))
        expect(mocks.createTopicSession).toHaveBeenCalled()
        expect(sessionManager.registerTopicSession).toHaveBeenCalledWith('-100:10', expect.any(Object))
        expect(topicSessions.get('-100:10').receiveInput).toHaveBeenCalledWith({
            text: 'please inspect tests',
            username: 'alice',
        })
        expect(bot.api.sendChatAction).toHaveBeenCalledWith(-100, 'typing')
    })

    it('reuses an existing topic session for later messages in the same topic', async () => {
        const bot = createBot()
        const existing = createTopicSession()
        const topicSessions = new Map<string, any>([['-100:10', existing]])
        registerMessageRouter(bot, { sessionManager: createSessionManager(), topicSessions, bot: bot as any })

        await bot.emitMessage(createMessageContext('second message'))

        expect(mocks.createQueryLoop).not.toHaveBeenCalled()
        expect(existing.receiveInput).toHaveBeenCalledWith({ text: 'second message', username: 'alice' })
    })

    it('keeps different Telegram topics isolated in the same group', async () => {
        const bot = createBot()
        const topicSessions = new Map<string, any>()
        const firstProvider = { name: 'mock-acp', instanceId: 'provider-1' }
        const secondProvider = { name: 'mock-acp', instanceId: 'provider-2' }
        mocks.createProviderInstance
            .mockReturnValueOnce(firstProvider)
            .mockReturnValueOnce(secondProvider)
        const sessionManager = createSessionManager({
            registerTopicSession: vi.fn((topicKey: string, session: any) => topicSessions.set(topicKey, session)),
        })
        registerMessageRouter(bot, { sessionManager, topicSessions, bot: bot as any })

        await bot.emitMessage(createMessageContext('topic 10', 10))
        await bot.emitMessage(createMessageContext('topic 20', 20))

        expect(sessionManager.registerTopicSession).toHaveBeenCalledWith('-100:10', expect.any(Object))
        expect(sessionManager.registerTopicSession).toHaveBeenCalledWith('-100:20', expect.any(Object))
        expect(mocks.createTopicSession).toHaveBeenNthCalledWith(1, expect.objectContaining({ provider: firstProvider }))
        expect(mocks.createTopicSession).toHaveBeenNthCalledWith(2, expect.objectContaining({ provider: secondProvider }))
        expect(topicSessions.get('-100:10')).not.toBe(topicSessions.get('-100:20'))
        expect(topicSessions.get('-100:10').receiveInput).toHaveBeenCalledWith({ text: 'topic 10', username: 'alice' })
        expect(topicSessions.get('-100:20').receiveInput).toHaveBeenCalledWith({ text: 'topic 20', username: 'alice' })
    })

    it('surfaces creation-lock contention instead of creating duplicate sessions', async () => {
        const bot = createBot()
        const sessionManager = createSessionManager({ tryAcquireCreationLock: vi.fn(() => false) })
        registerMessageRouter(bot, { sessionManager, topicSessions: new Map(), bot: bot as any })
        const ctx = createMessageContext('race')

        await bot.emitMessage(ctx)

        expect(ctx.reply).toHaveBeenCalledWith('⚠️ Session creation in progress. Please wait a moment and try again.')
        expect(mocks.createQueryLoop).not.toHaveBeenCalled()
    })

    it('does not create a session when the group has no cwd', async () => {
        const bot = createBot()
        const sessionManager = createSessionManager({ getGroupCwd: vi.fn(() => undefined) })
        registerMessageRouter(bot, { sessionManager, topicSessions: new Map(), bot: bot as any })
        const ctx = createMessageContext()

        await bot.emitMessage(ctx)

        expect(ctx.reply).toHaveBeenCalledWith('Please set working directory first: /cwd &lt;path&gt;', { parse_mode: 'HTML' })
        expect(mocks.createQueryLoop).not.toHaveBeenCalled()
    })

    it('does not recreate an archived topic session until /cwd unarchives it', async () => {
        const bot = createBot()
        const sessionManager = createSessionManager({ isGroupArchived: vi.fn(() => true) })
        registerMessageRouter(bot, { sessionManager, topicSessions: new Map(), bot: bot as any })
        const ctx = createMessageContext()

        await bot.emitMessage(ctx)

        expect(ctx.reply).toHaveBeenCalledWith('📦 Session was archived. Use /cwd to set up a new session.')
        expect(mocks.createQueryLoop).not.toHaveBeenCalled()
    })

    it('preserves persisted provider conversation id when creating a session after daemon restart', async () => {
        mocks.getTopicState.mockReturnValue({ conversationId: 'provider-session-1', queryInProgress: true })
        const bot = createBot()
        const topicSessions = new Map<string, any>()
        const sessionManager = createSessionManager({
            registerTopicSession: vi.fn((topicKey: string, session: any) => topicSessions.set(topicKey, session)),
        })
        registerMessageRouter(bot, { sessionManager, topicSessions, bot: bot as any })

        await bot.emitMessage(createMessageContext('resume after restart'))

        expect(mocks.clearTopicQueryInProgress).toHaveBeenCalledWith('-100:10')
        expect(mocks.createQueryLoop).toHaveBeenCalledWith(expect.objectContaining({
            conversationId: 'provider-session-1',
        }))
    })

    it('cleans up session maps when the created runtime reaches dead state', async () => {
        const queryLoop = createQueryLoop()
        mocks.createQueryLoop.mockReturnValue(queryLoop)
        const bot = createBot()
        const topicSessions = new Map<string, any>()
        const sessionManager = createSessionManager({
            registerTopicSession: vi.fn((topicKey: string, session: any) => topicSessions.set(topicKey, session)),
        })
        registerMessageRouter(bot, { sessionManager, topicSessions, bot: bot as any })

        await bot.emitMessage(createMessageContext('start'))
        queryLoop.bus.emit({ type: 'session.state_changed', sessionId: queryLoop.id, from: 'querying', to: 'dead' })

        expect(sessionManager.removeTopicSession).toHaveBeenCalledWith('-100:10')
        expect(sessionManager.removeSession).toHaveBeenCalledWith(queryLoop.id)
        expect(sessionManager.releaseCreationLock).toHaveBeenCalledWith('-100:10')
    })

    it('sends setup guidance when the bot is added to an authorized group with no existing session', async () => {
        const bot = createBot()
        registerMessageRouter(bot, { sessionManager: createSessionManager(), topicSessions: new Map(), bot: bot as any })

        await bot.emitMyChatMember({
            myChatMember: {
                chat: { id: -100, type: 'supergroup', title: 'dev' },
                from: { id: 1 },
                new_chat_member: { status: 'member' },
            },
            api: bot.api,
        })

        expect(bot.api.sendMessage).toHaveBeenCalledWith(
            -100,
            expect.stringContaining('Use /cwd &lt;path&gt;'),
            { parse_mode: 'HTML' },
        )
    })
})
