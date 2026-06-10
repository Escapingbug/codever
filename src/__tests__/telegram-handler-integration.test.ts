import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerGroupHandlers } from '@/channel/telegram/handlers/groupCommands'
import { registerSettingsHandlers } from '@/channel/telegram/handlers/settings'
import { registerCallbackHandlers } from '@/channel/telegram/handlers/callbacks'
import type { TopicSession } from '@/bridge/channelPort'
import { clearPendingDecisionsForTests, registerPendingDecision } from '@/channel/telegram/decisionRegistry'

const { providerModels } = vi.hoisted(() => ({
    providerModels: [{ id: 'sonnet', name: 'Sonnet' }],
}))

vi.mock('@/channel/telegram/pairing', () => ({
    pairing: { isAuthorized: vi.fn(() => true) },
}))

vi.mock('@/providers/registry', () => {
    const provider = {
        getAvailableModels: vi.fn(() => providerModels),
        getAvailablePermissionModes: vi.fn(() => ['default']),
        isReady: vi.fn(() => true),
        listSessions: vi.fn(async () => [{ sessionId: 'abcdef123456', title: 'old chat', updated: Date.now() }]),
    }
    return {
        getProvider: vi.fn(() => provider),
        getDefaultProvider: vi.fn(() => provider),
        listProviders: vi.fn(() => ['mock-acp']),
    }
})

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
        async runCallback(data: string, ctxOverrides: Partial<any> = {}) {
            const handler = handlers.get('callback_query:data')
            if (!handler) throw new Error('No callback handler registered')
            await handler(createCallbackContext(data, ctxOverrides))
        },
    }
}

function createContext(match = '') {
    const replies: Array<{ text: string; options?: unknown }> = []
    return {
        chat: { id: -100, type: 'supergroup' },
        from: { id: 1 },
        message: { message_thread_id: 10, text: match ? `/cmd ${match}` : '/cmd' },
        match,
        replies,
        reply: vi.fn(async (text: string, options?: unknown) => {
            replies.push({ text, options })
            return { message_id: 123 }
        }),
    }
}

function createCallbackContext(data: string, overrides: Partial<any> = {}) {
    return {
        callbackQuery: {
            data,
            message: {
                chat: { id: -100, type: 'supergroup' },
                message_thread_id: 10,
            },
        },
        answerCallbackQuery: vi.fn(async () => {}),
        editMessageText: vi.fn(async () => {}),
        editMessageReplyMarkup: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        ...overrides,
    }
}

function createSession(state: TopicSession['state'] = 'querying'): TopicSession {
    return {
        receiveInput: vi.fn(),
        dispatch: vi.fn(async () => {}),
        destroy: vi.fn(async () => {}),
        get state() { return state },
        sessionRecord: {
            id: 'ql-1',
            state,
            conversationId: 'conv-1',
            cwd: '/repo',
            model: 'old-model',
            providerName: 'mock-acp',
            verboseLevel: 1,
            timeoutSeconds: 180,
            providerSettings: {},
            setConversationId: vi.fn(),
            setModel: vi.fn(),
            setVerboseLevel: vi.fn(),
            setTimeoutSeconds: vi.fn(),
            setTimeoutExtended: vi.fn(),
            setProviderName: vi.fn(),
            destroy: vi.fn(async () => {}),
            bus: { emit: vi.fn() },
        } as any,
        channelPort: {} as any,
        getProgress: vi.fn(() => ({ state, elapsedSeconds: 12, lastToolName: 'Bash' })),
    }
}

function createSessionManager() {
    return {
        getGroupCwd: vi.fn(() => '/repo'),
        setGroupCwd: vi.fn(),
        unarchiveGroup: vi.fn(),
        archiveGroup: vi.fn(),
        removeSession: vi.fn(),
        releaseCreationLock: vi.fn(),
        getGroupSettings: vi.fn(() => ({ providerName: 'mock-acp' })),
        setGroupSettings: vi.fn(),
        getTopicSettings: vi.fn(() => undefined),
        setTopicSettings: vi.fn(),
        getSessionByGroup: vi.fn(() => undefined),
    } as any
}

describe('Telegram handler integration with semantic runtime dispatch', () => {
    afterEach(() => {
        clearPendingDecisionsForTests()
        providerModels.splice(0, providerModels.length, { id: 'sonnet', name: 'Sonnet' })
    })

    it('/stop dispatches a semantic cancel input', async () => {
        const bot = createBot()
        const session = createSession('querying')
        const topicSessions = new Map([['-100:10', session]])
        registerGroupHandlers(bot, { sessionManager: createSessionManager(), topicSessions })

        await bot.runCommand('stop', createContext())

        expect(session.dispatch).toHaveBeenCalledWith({ kind: 'cancel', reason: 'user', source: 'channel' })
    })

    it('/cwd reactivates an archived topic before the next message creates a session', async () => {
        const bot = createBot()
        const sessionManager = createSessionManager()
        registerGroupHandlers(bot, { sessionManager, topicSessions: new Map() })

        await bot.runCommand('cwd', createContext('D:/codever-worktrees/session-actor-runtime'))

        expect(sessionManager.setGroupCwd).toHaveBeenCalledWith(-100, 'D:/codever-worktrees/session-actor-runtime')
        expect(sessionManager.unarchiveGroup).toHaveBeenCalledWith('-100:10')
    })

    it('/archive should dispatch an archive command before destroying the topic session', async () => {
        const bot = createBot()
        const session = createSession('idle')
        const topicSessions = new Map([['-100:10', session]])
        registerGroupHandlers(bot, { sessionManager: createSessionManager(), topicSessions })

        await bot.runCommand('archive', createContext())

        expect(session.dispatch).toHaveBeenCalledWith({ kind: 'command', name: 'archive', source: 'channel' })
        expect(session.destroy).toHaveBeenCalled()
        expect(session.sessionRecord.destroy).not.toHaveBeenCalled()
    })

    it('/progress should reply directly from runtime progress without entering the output queue', async () => {
        const bot = createBot()
        const session = createSession('querying')
        const topicSessions = new Map([['-100:10', session]])
        registerGroupHandlers(bot, { sessionManager: createSessionManager(), topicSessions })
        const ctx = createContext()

        await bot.runCommand('progress', ctx)

        expect(session.dispatch).not.toHaveBeenCalled()
        expect(ctx.replies[0].text).toContain('Task in progress')
        expect(ctx.replies[0].text).toContain('Bash')
    })

    it('/restart passes the topic thread and initial message to daemon restart progress reporting', async () => {
        const bot = createBot()
        const restart = vi.fn(async () => {})
        registerGroupHandlers(bot, { sessionManager: createSessionManager(), topicSessions: new Map(), restart })

        await bot.runCommand('restart', createContext())

        expect(restart).toHaveBeenCalledWith(-100, 10, 123)
    })

    it('/file should dispatch a runtime file read command', async () => {
        const bot = createBot()
        const session = createSession('idle')
        const topicSessions = new Map([['-100:10', session]])
        registerGroupHandlers(bot, { sessionManager: createSessionManager(), topicSessions })

        await bot.runCommand('file', createContext('f1'))

        expect(session.dispatch).toHaveBeenCalledWith({ kind: 'command', name: 'file', args: 'f1', source: 'channel' })
    })

    it('/config timeout should dispatch runtime timeout config command', async () => {
        const bot = createBot()
        const session = createSession('idle')
        const topicSessions = new Map([['-100:10', session]])
        registerGroupHandlers(bot, { sessionManager: createSessionManager(), topicSessions })
        const ctx = createContext('timeout=240')
        ctx.message.text = '/config timeout=240'

        await bot.runCommand('config', ctx)

        expect(session.dispatch).toHaveBeenCalledWith({ kind: 'command', name: 'timeout', args: '240', source: 'channel' })
        expect(session.sessionRecord.setTimeoutSeconds).not.toHaveBeenCalled()
    })

    it('/new should dispatch a runtime reset command instead of mutating metadata directly', async () => {
        const bot = createBot()
        const session = createSession('idle')
        const topicSessions = new Map([['-100:10', session]])
        registerGroupHandlers(bot, { sessionManager: createSessionManager(), topicSessions })

        await bot.runCommand('new', createContext())

        expect(session.dispatch).toHaveBeenCalledWith({ kind: 'command', name: 'new', source: 'channel' })
        expect(session.sessionRecord.setConversationId).not.toHaveBeenCalled()
    })

    it('/model explicit selection should dispatch runtime model command', async () => {
        const bot = createBot()
        const session = createSession('idle')
        const topicSessions = new Map([['-100:10', session]])
        registerSettingsHandlers(bot, { sessionManager: createSessionManager(), topicSessions })

        await bot.runCommand('model', createContext('sonnet'))

        expect(session.dispatch).toHaveBeenCalledWith({ kind: 'command', name: 'model', args: 'sonnet', source: 'channel' })
        expect(session.sessionRecord.setModel).not.toHaveBeenCalled()
    })

    it('/resume should dispatch runtime resume command after resolving the provider session id', async () => {
        const bot = createBot()
        const session = createSession('idle')
        const topicSessions = new Map([['-100:10', session]])
        const sessionManager = createSessionManager()
        registerSettingsHandlers(bot, { sessionManager, topicSessions })

        await bot.runCommand('resume', createContext('abcdef12'))

        expect(session.dispatch).toHaveBeenCalledWith({ kind: 'command', name: 'resume', args: expect.any(String), source: 'channel' })
        expect(session.sessionRecord.setConversationId).not.toHaveBeenCalled()
    })

    it('model callback should dispatch runtime model command', async () => {
        const bot = createBot()
        const session = createSession('idle')
        const topicSessions = new Map([['-100:10', session]])
        registerCallbackHandlers(bot, { sessionManager: createSessionManager(), topicSessions })

        await bot.runCallback('model:sonnet')

        expect(session.dispatch).toHaveBeenCalledWith({ kind: 'command', name: 'model', args: 'sonnet', source: 'channel' })
    })

    it('/model does not show a stale model when the provider has no model catalog', async () => {
        providerModels.splice(0, providerModels.length)
        const bot = createBot()
        const session = createSession('idle')
        const topicSessions = new Map([['-100:10', session]])
        registerSettingsHandlers(bot, { sessionManager: createSessionManager(), topicSessions })
        const ctx = createContext()

        await bot.runCommand('model', ctx)

        expect(ctx.replies[0].text).toContain('Current model: <b>default</b>')
        expect(ctx.replies[0].text).toContain('No models are available for provider <b>mock-acp</b>')
    })

    it('provider callback should dispatch runtime provider switch command', async () => {
        const bot = createBot()
        const session = createSession('idle')
        const sessionManager = createSessionManager()
        const topicSessions = new Map([['-100:10', session]])
        registerCallbackHandlers(bot, { sessionManager, topicSessions })

        await bot.runCallback('provider:mock-acp')

        expect(session.dispatch).toHaveBeenCalledWith({ kind: 'command', name: 'provider', args: 'mock-acp', source: 'channel' })
        expect(sessionManager.setGroupSettings).not.toHaveBeenCalled()
        expect(session.sessionRecord.setProviderName).not.toHaveBeenCalled()
    })

    it('provider callback in a new non-generic topic stores provider for the future session', async () => {
        const bot = createBot()
        const sessionManager = createSessionManager()
        registerCallbackHandlers(bot, { sessionManager, topicSessions: new Map() })

        await bot.runCallback('provider:mock-acp')

        expect(sessionManager.setTopicSettings).toHaveBeenCalledWith(-100, 10, { providerName: 'mock-acp', model: undefined })
        expect(sessionManager.setGroupSettings).not.toHaveBeenCalled()
    })

    it('model callback in a new non-generic topic stores model for the future session', async () => {
        const bot = createBot()
        const sessionManager = createSessionManager()
        registerCallbackHandlers(bot, { sessionManager, topicSessions: new Map() })

        await bot.runCallback('model:sonnet')

        expect(sessionManager.setTopicSettings).toHaveBeenCalledWith(-100, 10, { model: 'sonnet' })
        expect(sessionManager.setGroupSettings).not.toHaveBeenCalled()
    })

    it('file callback should dispatch a runtime file read command', async () => {
        const bot = createBot()
        const session = createSession('idle')
        const topicSessions = new Map([['-100:10', session]])
        registerCallbackHandlers(bot, { sessionManager: createSessionManager(), topicSessions })

        await bot.runCallback('file:f1')

        expect(session.dispatch).toHaveBeenCalledWith({ kind: 'command', name: 'file', args: 'f1', source: 'channel' })
    })

    it('decision callback resolves a pending TelegramPort request', async () => {
        const bot = createBot()
        registerCallbackHandlers(bot, { sessionManager: createSessionManager(), topicSessions: new Map() })
        const { decisionId, promise } = registerPendingDecision()

        await bot.runCallback(`decision:${decisionId}:deny`)

        await expect(promise).resolves.toEqual({ value: 'deny' })
    })

    it('decision callback dispatches semantic decision response when no pending port request exists', async () => {
        const bot = createBot()
        const session = createSession('idle')
        const topicSessions = new Map([['-100:10', session]])
        registerCallbackHandlers(bot, { sessionManager: createSessionManager(), topicSessions })

        await bot.runCallback('decision:plan-1:accept')

        expect(session.dispatch).toHaveBeenCalledWith({
            kind: 'decision_response',
            decisionId: 'plan-1',
            value: 'accept',
            source: 'channel',
        })
    })

    it('provider callback in the generic topic updates the default for new sessions', async () => {
        const bot = createBot()
        const session = createSession('idle')
        const sessionManager = createSessionManager()
        const topicSessions = new Map([['-100:main', session]])
        registerCallbackHandlers(bot, { sessionManager, topicSessions })

        await bot.runCallback('provider:mock-acp', {
            callbackQuery: {
                data: 'provider:mock-acp',
                message: {
                    chat: { id: -100, type: 'supergroup' },
                },
            },
        })

        expect(session.dispatch).not.toHaveBeenCalled()
        expect(sessionManager.setGroupSettings).toHaveBeenCalledWith(-100, { providerName: 'mock-acp', model: undefined })
    })

    it('mode callback should dispatch runtime permission mode command', async () => {
        const bot = createBot()
        const session = createSession('idle')
        const topicSessions = new Map([['-100:10', session]])
        registerCallbackHandlers(bot, { sessionManager: createSessionManager(), topicSessions })

        await bot.runCallback('mode:approve-all')

        expect(session.dispatch).toHaveBeenCalledWith({ kind: 'command', name: 'mode', args: 'approve-all', source: 'channel' })
        expect(session.sessionRecord.providerSettings.permissionMode).toBeUndefined()
    })

    it('timeout continue callback should dispatch a runtime timeout-continue command', async () => {
        const bot = createBot()
        const session = createSession('querying')
        const topicSessions = new Map([['-100:10', session]])
        registerCallbackHandlers(bot, { sessionManager: createSessionManager(), topicSessions })

        await bot.runCallback('timeout:continue')

        expect(session.dispatch).toHaveBeenCalledWith({ kind: 'command', name: 'timeout_continue', source: 'channel' })
        expect(session.sessionRecord.bus.emit).not.toHaveBeenCalled()
    })
})
