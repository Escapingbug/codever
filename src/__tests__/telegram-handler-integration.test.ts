import { describe, expect, it, vi } from 'vitest'
import { registerGroupHandlers } from '@/transport/telegram/handlers/groupCommands'
import { registerSettingsHandlers } from '@/transport/telegram/handlers/settings'
import { registerCallbackHandlers } from '@/transport/telegram/handlers/callbacks'
import type { TopicSession } from '@/bridge/channelPort'

vi.mock('@/channel/telegram/pairing', () => ({
    pairing: { isAuthorized: vi.fn(() => true) },
}))

vi.mock('@/providers/registry', () => {
    const provider = {
        getAvailableModels: vi.fn(() => [{ id: 'sonnet', name: 'Sonnet' }]),
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
        queryLoop: {
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
            interrupt: vi.fn(async () => {}),
            resolvePermission: vi.fn(() => true),
            resetRequested: false,
            bus: { emit: vi.fn() },
        } as any,
        channelPort: {} as any,
        getProgress: vi.fn(() => ({ elapsedSeconds: 12, lastToolName: 'Bash' })),
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
        getSessionByGroup: vi.fn(() => undefined),
        getSessionForPermission: vi.fn(() => undefined),
        removePermission: vi.fn(),
    } as any
}

describe('Telegram handler integration with semantic runtime dispatch', () => {
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

    it('/archive should dispatch an archive command instead of destroying QueryLoop directly', async () => {
        const bot = createBot()
        const session = createSession('idle')
        const topicSessions = new Map([['-100:10', session]])
        registerGroupHandlers(bot, { sessionManager: createSessionManager(), topicSessions })

        await bot.runCommand('archive', createContext())

        expect(session.dispatch).toHaveBeenCalledWith({ kind: 'command', name: 'archive', source: 'channel' })
        expect(session.destroy).toHaveBeenCalled()
        expect(session.queryLoop.destroy).not.toHaveBeenCalled()
    })

    it('/progress should dispatch a runtime progress command instead of reading QueryLoop timeout state', async () => {
        const bot = createBot()
        const session = createSession('querying')
        const topicSessions = new Map([['-100:10', session]])
        registerGroupHandlers(bot, { sessionManager: createSessionManager(), topicSessions })

        await bot.runCommand('progress', createContext())

        expect(session.dispatch).toHaveBeenCalledWith({ kind: 'command', name: 'progress', source: 'channel' })
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
        expect(session.queryLoop.setTimeoutSeconds).not.toHaveBeenCalled()
    })

    it('/new should dispatch a runtime reset command instead of mutating QueryLoop directly', async () => {
        const bot = createBot()
        const session = createSession('idle')
        const topicSessions = new Map([['-100:10', session]])
        registerGroupHandlers(bot, { sessionManager: createSessionManager(), topicSessions })

        await bot.runCommand('new', createContext())

        expect(session.dispatch).toHaveBeenCalledWith({ kind: 'command', name: 'new', source: 'channel' })
        expect(session.queryLoop.setConversationId).not.toHaveBeenCalled()
    })

    it('/model explicit selection should dispatch runtime model command', async () => {
        const bot = createBot()
        const session = createSession('idle')
        const topicSessions = new Map([['-100:10', session]])
        registerSettingsHandlers(bot, { sessionManager: createSessionManager(), topicSessions })

        await bot.runCommand('model', createContext('sonnet'))

        expect(session.dispatch).toHaveBeenCalledWith({ kind: 'command', name: 'model', args: 'sonnet', source: 'channel' })
        expect(session.queryLoop.setModel).not.toHaveBeenCalled()
    })

    it('/resume should dispatch runtime resume command after resolving the provider session id', async () => {
        const bot = createBot()
        const session = createSession('idle')
        const topicSessions = new Map([['-100:10', session]])
        const sessionManager = createSessionManager()
        registerSettingsHandlers(bot, { sessionManager, topicSessions })

        await bot.runCommand('resume', createContext('abcdef12'))

        expect(session.dispatch).toHaveBeenCalledWith({ kind: 'command', name: 'resume', args: expect.any(String), source: 'channel' })
        expect(session.queryLoop.setConversationId).not.toHaveBeenCalled()
    })

    it('model callback should dispatch runtime model command', async () => {
        const bot = createBot()
        const session = createSession('idle')
        const topicSessions = new Map([['-100:10', session]])
        registerCallbackHandlers(bot, { sessionManager: createSessionManager(), topicSessions })

        await bot.runCallback('model:sonnet')

        expect(session.dispatch).toHaveBeenCalledWith({ kind: 'command', name: 'model', args: 'sonnet', source: 'channel' })
    })

    it('provider callback should dispatch runtime provider switch command', async () => {
        const bot = createBot()
        const session = createSession('idle')
        const topicSessions = new Map([['-100:10', session]])
        registerCallbackHandlers(bot, { sessionManager: createSessionManager(), topicSessions })

        await bot.runCallback('provider:mock-acp')

        expect(session.dispatch).toHaveBeenCalledWith({ kind: 'command', name: 'provider', args: 'mock-acp', source: 'channel' })
        expect(session.queryLoop.setProviderName).not.toHaveBeenCalled()
    })

    it('mode callback should dispatch runtime permission mode command', async () => {
        const bot = createBot()
        const session = createSession('idle')
        const topicSessions = new Map([['-100:10', session]])
        registerCallbackHandlers(bot, { sessionManager: createSessionManager(), topicSessions })

        await bot.runCallback('mode:approve-all')

        expect(session.dispatch).toHaveBeenCalledWith({ kind: 'command', name: 'mode', args: 'approve-all', source: 'channel' })
        expect(session.queryLoop.providerSettings.permissionMode).toBeUndefined()
    })

    it('timeout continue callback should dispatch a runtime timeout-continue command', async () => {
        const bot = createBot()
        const session = createSession('querying')
        const topicSessions = new Map([['-100:10', session]])
        registerCallbackHandlers(bot, { sessionManager: createSessionManager(), topicSessions })

        await bot.runCallback('timeout:continue')

        expect(session.dispatch).toHaveBeenCalledWith({ kind: 'command', name: 'timeout_continue', source: 'channel' })
        expect(session.queryLoop.bus.emit).not.toHaveBeenCalled()
    })

    it('permission callback should dispatch a semantic decision response', async () => {
        const bot = createBot()
        const session = createSession('querying')
        const sessionManager = createSessionManager()
        sessionManager.getSessionForPermission = vi.fn(() => session.queryLoop)
        registerCallbackHandlers(bot, { sessionManager, topicSessions: new Map([['-100:10', session]]) })

        await bot.runCallback('perm:allow:req-1')

        expect(session.dispatch).toHaveBeenCalledWith({ kind: 'decision_response', decisionId: 'req-1', value: 'allow', source: 'channel' })
        expect(session.queryLoop.resolvePermission).not.toHaveBeenCalled()
    })
})
