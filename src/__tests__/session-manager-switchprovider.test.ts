import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionManager, makeTopicKey } from '@/bridge/sessionManager'
import { DefaultEventBus } from '@/core/eventBus'
import { createTopicSessionRecord } from '@/bridge/topicSession'
import type { SessionRecord } from '@/bridge/sessionRecord'
import { registerProvider, getProvider } from '@/providers/registry'
import type { AgentProvider, AgentQueryConfig, AgentQueryHandle } from '@/providers/provider'
import type { AgentEvent } from '@/providers/types'

function createMockProvider(name: string = 'mock-provider'): AgentProvider {
    return {
        name,
        startQuery: vi.fn().mockImplementation((_prompt: string, _config: AgentQueryConfig) => {
            const handle: AgentQueryHandle = {
                events: (async function* () {
                    yield { kind: 'result', status: 'success' } as AgentEvent
                })(),
                interrupt: vi.fn().mockResolvedValue(undefined),
            }
            return handle
        }),
        isReady: vi.fn().mockReturnValue(true),
        getInitError: vi.fn().mockReturnValue(null),
        getAvailableModels: vi.fn().mockReturnValue([]),
        getAvailablePermissionModes: vi.fn().mockReturnValue([]),
    }
}

function createTestSession(provider?: AgentProvider): SessionRecord {
    void provider
    return createTopicSessionRecord({
        cwd: '/tmp/test',
        providerName: 'test',
        groupChatId: -100123,
    })
}

describe('SessionManager: switchProvider', () => {
    it('destroy+recreate: removes old session and creates new one with different provider', async () => {
        const sm = new SessionManager()
        const bus = new DefaultEventBus()
        sm.setEventBus(bus)

        const oldSession = createTestSession()
        oldSession.groupChatId = -100123
        oldSession.messageThreadId = 42
        sm.registerSession(oldSession, -100123, 42)

        // Verify old session exists
        expect(sm.getSession(oldSession.id)).toBe(oldSession)
        expect(sm.getSessionByGroup(-100123, 42)).toBe(oldSession)

        // Switch provider: destroy old, create new
            const newProvider = createMockProvider('new-provider')
            const newSession = createTopicSessionRecord({
                cwd: '/tmp/test',
                providerName: 'new-provider',
                groupChatId: -100123,
                messageThreadId: 42,
            })
        newSession.setProvider(newProvider)

        // Destroy old session
        await oldSession.destroy()
        sm.removeSession(oldSession.id)

        // Register new session
        sm.registerSession(newSession, -100123, 42)

        // Verify new session replaced old
        expect(sm.getSession(oldSession.id)).toBeUndefined()
        expect(sm.getSession(newSession.id)).toBe(newSession)
        expect(sm.getSessionByGroup(-100123, 42)).toBe(newSession)
        expect(newSession.providerName).toBe('new-provider')
    })

    it('preserves group settings across provider switch', () => {
        const sm = new SessionManager()
        sm.setGroupCwd(-100123, '/project/dir')
        sm.setGroupSettings(-100123, { verboseLevel: 2, timeoutSeconds: 120 })

        // Simulate provider switch
        const oldSession = createTestSession()
        sm.registerSession(oldSession, -100123, 42)

        // Settings should survive
        expect(sm.getGroupCwd(-100123)).toBe('/project/dir')
        const settings = sm.getGroupSettings(-100123)
        expect(settings?.verboseLevel).toBe(2)
        expect(settings?.timeoutSeconds).toBe(120)
    })

    it('preserves archived status across provider switch', () => {
        const sm = new SessionManager()
        sm.archiveGroup('-100123:42')

        // Archive status should survive
        expect(sm.isGroupArchived('-100123:42')).toBe(true)
    })

    describe('switchProvider convenience method', () => {
        it('destroy+recreate via switchProvider method', async () => {
            // Register a provider for the registry
            const provider1 = createMockProvider('provider-1')
            const provider2 = createMockProvider('provider-2')
            registerProvider(provider1)
            registerProvider(provider2)

            const sm = new SessionManager()
            const bus = new DefaultEventBus()
            sm.setEventBus(bus)
            sm.setGroupCwd(-100123, '/project/path')

            const oldSession = createTopicSessionRecord({
                cwd: '/project/path',
                providerName: 'provider-1',
                groupChatId: -100123,
                messageThreadId: 42,
            })
            oldSession.setProvider(provider1)
            sm.registerSession(oldSession, -100123, 42)

            // Switch provider
            const newSession = await sm.switchProvider(-100123, 42, 'provider-2')

            expect(newSession).not.toBeNull()
            expect(newSession!.providerName).toBe('provider-2')
            expect(newSession!.groupChatId).toBe(-100123)
            expect(newSession!.messageThreadId).toBe(42)
            expect(newSession!.cwd).toBe('/project/path')
            expect(sm.getSessionByGroup(-100123, 42)).toBe(newSession)
            expect(sm.getSession(oldSession.id)).toBeUndefined()
        })

        it('returns null when no session exists for the topicKey', async () => {
            const result = await new SessionManager().switchProvider(-999, undefined, 'provider')
            expect(result).toBeNull()
        })
    })
})
