import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createListSessionsHandler, createSwitchSessionHandler, createGetStatusHandler, type SessionToolContext } from '@/mcp/tools/session'
import { SessionManager } from '@/bridge/sessionManager'
import { QueryLoop } from '@/core/queryLoop'
import { DefaultEventBus } from '@/core/eventBus'
import type { AgentProvider, AgentQueryConfig, AgentQueryHandle } from '@/providers/provider'
import type { AgentEvent } from '@/providers/types'

function createMockProvider(): AgentProvider {
    return {
        name: 'mock-provider',
        startQuery: vi.fn().mockImplementation(() => ({
            events: (async function* () { yield { kind: 'result', status: 'success' } as AgentEvent })(),
            interrupt: vi.fn().mockResolvedValue(undefined),
        })),
        isReady: vi.fn().mockReturnValue(true),
        getInitError: vi.fn().mockReturnValue(null),
        getAvailableModels: vi.fn().mockReturnValue([]),
        getAvailablePermissionModes: vi.fn().mockReturnValue([]),
        listSessions: vi.fn().mockResolvedValue([
            { sessionId: 'sess-001', title: 'Test Session', updated: Date.now() },
        ]),
    }
}

function createTestSession(provider?: AgentProvider): QueryLoop {
    const bus = new DefaultEventBus()
    return new QueryLoop({
        cwd: '/tmp/test',
        provider: provider ?? createMockProvider(),
        bus,
        providerName: 'test',
    })
}

describe('MCP Tools', () => {
    describe('list_sessions', () => {
        it('lists sessions from the provider', async () => {
            const provider = createMockProvider()
            const sessionManager = new SessionManager()

            const handler = createListSessionsHandler({
                sessionManager,
                getProvider: () => provider,
                getCwd: () => '/tmp/test',
            })
            const result = await handler({})

            expect(provider.listSessions).toHaveBeenCalledWith('/tmp/test')
        })

        it('returns message when no provider available', async () => {
            const sessionManager = new SessionManager()

            const handler = createListSessionsHandler({
                sessionManager,
                getProvider: () => null,
                getCwd: () => '/tmp/test',
            })
            const result = await handler({})

            expect(result.isError).toBeFalsy()
        })
    })

    describe('switch_session', () => {
        it('sets conversationId on the current session', async () => {
            const session = createTestSession()
            const sessionManager = new SessionManager()

            const handler = createSwitchSessionHandler({
                sessionManager,
                getProvider: () => createMockProvider(),
                getCwd: () => '/tmp/test',
                getSession: () => session,
            })
            const result = await handler({ sessionId: 'new-session-123' })

            expect(session.conversationId).toBe('new-session-123')
        })

        it('returns error when no active session', async () => {
            const sessionManager = new SessionManager()

            const handler = createSwitchSessionHandler({
                sessionManager,
                getProvider: () => createMockProvider(),
                getCwd: () => '/tmp/test',
                getSession: () => undefined,
            })
            const result = await handler({ sessionId: 'new-session-123' })

            expect(result.isError).toBe(true)
        })
    })

    describe('get_codever_status', () => {
        it('returns current session status', async () => {
            const session = createTestSession()
            session.groupChatId = -100123

            const handler = createGetStatusHandler({
                sessionManager: new SessionManager(),
                getProvider: () => createMockProvider(),
                getCwd: () => '/tmp/test',
                getSession: () => session,
            })
            const result = await handler({})

            expect(result.isError).toBeFalsy()
            const text = JSON.stringify(result.content)
            expect(text).toContain('idle')
            expect(text).toContain('test')
        })

        it('returns status without active session', async () => {
            const handler = createGetStatusHandler({
                sessionManager: new SessionManager(),
                getProvider: () => createMockProvider(),
                getCwd: () => '/tmp/test',
                getSession: () => undefined,
            })
            const result = await handler({})

            expect(result.isError).toBeFalsy()
        })
    })
})
