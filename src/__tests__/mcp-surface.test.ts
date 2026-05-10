import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerCodeverMcpSurface } from '@/mcp/register'
import { SessionManager } from '@/bridge/sessionManager'
import { createTopicSessionRecord } from '@/bridge/topicSession'
import type { AgentProvider } from '@/providers/provider'

const existsSync = vi.fn()
const readFileSync = vi.fn()

vi.mock('node:os', () => ({ homedir: () => '/home/tester' }))
vi.mock('node:fs', () => ({
    existsSync: (...args: unknown[]) => existsSync(...args),
    readFileSync: (...args: unknown[]) => readFileSync(...args),
}))

function createServerRecorder() {
    const tools = new Map<string, (args: any) => Promise<any>>()
    const resources = new Map<string, unknown>()
    return {
        tools,
        resources,
        server: {
            tool: vi.fn((name: string, _description: string, _schema: unknown, handler: (args: any) => Promise<any>) => {
                tools.set(name, handler)
            }),
            resource: vi.fn((name: string, uri: string, description: string, handler: unknown) => {
                resources.set(name, { uri, description, handler })
            }),
        },
    }
}

function createProvider(): AgentProvider {
    return {
        name: 'mock-provider',
        startQuery: vi.fn(),
        isReady: vi.fn(() => true),
        getInitError: vi.fn(() => null),
        getAvailableModels: vi.fn(() => []),
        getAvailablePermissionModes: vi.fn(() => []),
        listSessions: vi.fn(async () => []),
    }
}

describe('MCP active surface registration', () => {
    beforeEach(() => {
        existsSync.mockReturnValue(true)
        readFileSync.mockReturnValue('3737')
        process.env.CODEVER_CONVERSATION_ID = 'provider-session-1'
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({ taskId: 'task-1' }),
            text: async () => '',
        })))
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
        delete process.env.CODEVER_CONVERSATION_ID
    })

    it('registers active stdio resources and tools through one surface', async () => {
        const { server, tools, resources } = createServerRecorder()

        registerCodeverMcpSurface(server)

        expect(resources.has('Codever Environment')).toBe(true)
        expect(tools.has('get_codever_context')).toBe(true)
        expect(tools.has('schedule_reminder')).toBe(true)
        expect(tools.has('cancel_reminder')).toBe(true)
        expect(tools.has('send_message')).toBe(true)
        expect(tools.has('list_sessions')).toBe(false)

        const context = await tools.get('get_codever_context')!({ topic: 'channel' })
        expect(context.content[0].text).toContain('Channel: Telegram')

        await tools.get('schedule_reminder')!({ delayMs: 1000, message: 'later' })
        expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:3737/api/schedule', expect.objectContaining({
            method: 'POST',
        }))

        await tools.get('send_message')!({ message: 'now' })
        expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:3737/api/send', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ sessionId: 'provider-session-1', message: 'now' }),
        }))
    })

    it('adds session tools only when daemon session context is supplied', () => {
        const { server, tools } = createServerRecorder()
        const provider = createProvider()
        const session = createTopicSessionRecord({
            cwd: '/repo',
            providerName: provider.name,
            groupChatId: -100,
            conversationId: 'provider-session-1',
        })

        registerCodeverMcpSurface(server, {
            sessionTools: {
                sessionManager: new SessionManager(),
                getProvider: () => provider,
                getCwd: () => session.cwd,
                getSession: () => session,
            },
        })

        expect(tools.has('list_sessions')).toBe(true)
        expect(tools.has('switch_session')).toBe(true)
        expect(tools.has('get_codever_status')).toBe(true)
    })
})
