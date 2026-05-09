import { describe, it, expect, vi } from 'vitest'
import { SessionManager, makeTopicKey, normalizeThreadId, TELEGRAM_GENERAL_TOPIC_ID, type GroupSettings } from '@/bridge/sessionManager'
import { QueryLoop } from '@/core/queryLoop'
import { DefaultEventBus } from '@/core/eventBus'
import type { AgentProvider, AgentQueryConfig, AgentQueryHandle } from '@/providers/provider'
import type { AgentEvent } from '@/providers/types'

function createMockProvider(events: AgentEvent[] = []): AgentProvider {
    return {
        name: 'mock-provider',
        startQuery: vi.fn().mockImplementation((_prompt: string, _config: AgentQueryConfig) => {
            const handle: AgentQueryHandle = {
                events: (async function* () {
                    for (const event of events) yield event
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

function createTestSession(provider?: AgentProvider): QueryLoop {
    const bus = new DefaultEventBus()
    return new QueryLoop({
        cwd: '/tmp/test',
        provider: provider ?? createMockProvider([{ kind: 'result', status: 'success' }]),
        bus,
        providerName: 'test',
    })
}

describe('makeTopicKey', () => {
    it('returns chatId:main when no threadId', () => {
        expect(makeTopicKey(123)).toBe('123:main')
    })

    it('returns chatId:threadId when threadId provided', () => {
        expect(makeTopicKey(123, 42)).toBe('123:42')
    })

    it('treats threadId=0 as main (falsy, no topic)', () => {
        expect(makeTopicKey(123, 0)).toBe('123:main')
    })

    it('normalizes threadId=1 (Telegram General topic) to main', () => {
        expect(makeTopicKey(123, 1)).toBe('123:main')
    })
})

describe('normalizeThreadId', () => {
    it('returns undefined for undefined input', () => {
        expect(normalizeThreadId()).toBeUndefined()
    })

    it('returns undefined for threadId=0 (falsy)', () => {
        expect(normalizeThreadId(0)).toBeUndefined()
    })

    it('returns undefined for threadId=1 (General topic)', () => {
        expect(normalizeThreadId(1)).toBeUndefined()
    })

    it('returns threadId for non-General topic IDs', () => {
        expect(normalizeThreadId(2)).toBe(2)
        expect(normalizeThreadId(42)).toBe(42)
        expect(normalizeThreadId(999)).toBe(999)
    })
})

describe('SessionManager', () => {
    describe('session registration and lookup', () => {
        it('registerSession stores session by id and group', () => {
            const sm = new SessionManager()
            const session = createTestSession()
            session.groupChatId = -100123
            session.messageThreadId = 42

            sm.registerSession(session, -100123, 42)

            expect(sm.getSession(session.id)).toBe(session)
            expect(sm.getSessionByGroup(-100123, 42)).toBe(session)
        })

        it('registerSession without threadId uses main topic', () => {
            const sm = new SessionManager()
            const session = createTestSession()
            session.groupChatId = -100456

            sm.registerSession(session, -100456)

            expect(sm.getSessionByGroup(-100456)).toBe(session)
            expect(sm.getSessionByGroup(-100456, undefined)).toBe(session)
        })

        it('getSession returns undefined for unknown id', () => {
            const sm = new SessionManager()
            expect(sm.getSession('unknown')).toBeUndefined()
        })

        it('getSessionByGroup returns undefined for unknown group', () => {
            const sm = new SessionManager()
            expect(sm.getSessionByGroup(-999)).toBeUndefined()
        })

        it('different threadIds in same group are separate sessions', () => {
            const sm = new SessionManager()
            const session1 = createTestSession()
            const session2 = createTestSession()

            sm.registerSession(session1, -100, 2)
            sm.registerSession(session2, -100, 3)

            expect(sm.getSessionByGroup(-100, 2)).toBe(session1)
            expect(sm.getSessionByGroup(-100, 3)).toBe(session2)
            expect(sm.getSessionByGroup(-100)).toBeUndefined()
        })

        it('threadId=1 (General topic) is normalized to main', () => {
            const sm = new SessionManager()
            const session = createTestSession()

            sm.registerSession(session, -100, 1)

            // threadId=1 is normalized to "main", so looking up without threadId should find it
            expect(sm.getSessionByGroup(-100, 1)).toBe(session)
            expect(sm.getSessionByGroup(-100)).toBe(session)
        })
    })

    describe('hasSessionInGroup', () => {
        it('returns true when session exists for any topic in group', () => {
            const sm = new SessionManager()
            const session = createTestSession()

            sm.registerSession(session, -100, 42)

            expect(sm.hasSessionInGroup(-100)).toBe(true)
        })

        it('returns true for main topic session', () => {
            const sm = new SessionManager()
            const session = createTestSession()

            sm.registerSession(session, -200)

            expect(sm.hasSessionInGroup(-200)).toBe(true)
        })

        it('returns false when no sessions for group', () => {
            const sm = new SessionManager()
            expect(sm.hasSessionInGroup(-999)).toBe(false)
        })
    })

    describe('removeSession', () => {
        it('removes session from both id and group maps', () => {
            const sm = new SessionManager()
            const session = createTestSession()
            session.groupChatId = -100
            session.messageThreadId = 42

            sm.registerSession(session, -100, 42)
            sm.removeSession(session.id)

            expect(sm.getSession(session.id)).toBeUndefined()
            expect(sm.getSessionByGroup(-100, 42)).toBeUndefined()
        })

        it('is no-op for unknown id', () => {
            const sm = new SessionManager()
            expect(() => sm.removeSession('unknown')).not.toThrow()
        })

        it('emits session.destroyed event when eventBus is set', () => {
            const sm = new SessionManager()
            const bus = new DefaultEventBus()
            sm.setEventBus(bus)

            const destroyedEvents: string[] = []
            bus.on('session.destroyed', (e) => {
                if (e.type === 'session.destroyed') destroyedEvents.push(e.sessionId)
            })

            const session = createTestSession()
            session.groupChatId = -100
            sm.registerSession(session, -100)
            sm.removeSession(session.id)

            expect(destroyedEvents).toContain(session.id)
        })
    })

    describe('permissions', () => {
        it('registerPermission and getSessionForPermission work', () => {
            const sm = new SessionManager()
            const session = createTestSession()

            sm.registerPermission('req-123', session)
            expect(sm.getSessionForPermission('req-123')).toBe(session)
        })

        it('getSessionForPermission returns undefined for unknown requestId', () => {
            const sm = new SessionManager()
            expect(sm.getSessionForPermission('unknown')).toBeUndefined()
        })

        it('removePermission deletes the mapping', () => {
            const sm = new SessionManager()
            const session = createTestSession()

            sm.registerPermission('req-123', session)
            sm.removePermission('req-123')

            expect(sm.getSessionForPermission('req-123')).toBeUndefined()
        })
    })

    describe('group cwd and settings', () => {
        it('setGroupCwd and getGroupCwd work', () => {
            const sm = new SessionManager()
            sm.setGroupCwd(-100, '/project/dir')
            expect(sm.getGroupCwd(-100)).toBe('/project/dir')
        })

        it('getGroupCwd returns undefined for unknown group', () => {
            const sm = new SessionManager()
            expect(sm.getGroupCwd(-999)).toBeUndefined()
        })

        it('setGroupSettings merges with existing settings', () => {
            const sm = new SessionManager()
            sm.setGroupSettings(-100, { model: 'gpt-4' })
            sm.setGroupSettings(-100, { verboseLevel: 2 })

            const settings = sm.getGroupSettings(-100)
            expect(settings).toEqual({ model: 'gpt-4', verboseLevel: 2 })
        })

        it('getGroupSettings returns undefined for unknown group', () => {
            const sm = new SessionManager()
            expect(sm.getGroupSettings(-999)).toBeUndefined()
        })
    })

    describe('group failure tracking', () => {
        it('recordGroupFailure increments count', () => {
            const sm = new SessionManager()
            sm.recordGroupFailure('100:42')

            expect(sm.isGroupInCooldown('100:42')).toBe(true)
        })

        it('isGroupInCooldown returns false when no failures', () => {
            const sm = new SessionManager()
            expect(sm.isGroupInCooldown('100:42')).toBe(false)
        })

        it('clearGroupFailures resets cooldown', () => {
            const sm = new SessionManager()
            sm.recordGroupFailure('100:42')
            sm.clearGroupFailures('100:42')

            expect(sm.isGroupInCooldown('100:42')).toBe(false)
        })
    })

    describe('group archiving', () => {
        it('archiveGroup and isGroupArchived work', () => {
            const sm = new SessionManager()
            sm.archiveGroup('100:42')
            expect(sm.isGroupArchived('100:42')).toBe(true)
            expect(sm.isGroupArchived('100:43')).toBe(false)
        })

        it('unarchiveGroup removes the archived status', () => {
            const sm = new SessionManager()
            sm.archiveGroup('100:42')
            sm.unarchiveGroup('100:42')
            expect(sm.isGroupArchived('100:42')).toBe(false)
        })
    })

    describe('creation lock', () => {
        it('tryAcquireCreationLock returns true on first call', () => {
            const sm = new SessionManager()
            expect(sm.tryAcquireCreationLock('100:42')).toBe(true)
        })

        it('tryAcquireCreationLock returns false on second call', () => {
            const sm = new SessionManager()
            sm.tryAcquireCreationLock('100:42')
            expect(sm.tryAcquireCreationLock('100:42')).toBe(false)
        })

        it('releaseCreationLock allows re-acquiring', () => {
            const sm = new SessionManager()
            sm.tryAcquireCreationLock('100:42')
            sm.releaseCreationLock('100:42')
            expect(sm.tryAcquireCreationLock('100:42')).toBe(true)
        })
    })

    describe('listActiveSessions', () => {
        it('returns all registered sessions', () => {
            const sm = new SessionManager()
            const s1 = createTestSession()
            const s2 = createTestSession()

            sm.registerSession(s1, -100)
            sm.registerSession(s2, -200, 1)

            expect(sm.listActiveSessions()).toEqual(expect.arrayContaining([s1, s2]))
        })

        it('returns empty array when no sessions', () => {
            const sm = new SessionManager()
            expect(sm.listActiveSessions()).toEqual([])
        })
    })

    describe('migrateTopicKey', () => {
        it('moves session from old topicKey to new topicKey', () => {
            const sm = new SessionManager()
            const session = createTestSession()
            session.groupChatId = -100
            session.messageThreadId = 42

            sm.registerSession(session, -100, 42)
            const result = sm.migrateTopicKey('-100:42', '-100:43')

            expect(result).toBe(session)
            expect(sm.getSessionByGroup(-100, 42)).toBeUndefined()
            expect(sm.getSessionByGroup(-100, 43)).toBe(session)
        })

        it('returns null when old topicKey not found', () => {
            const sm = new SessionManager()
            expect(sm.migrateTopicKey('nonexistent', 'new')).toBeNull()
        })
    })

    describe('deprecated aliases', () => {
        it('registerCoreSession delegates to registerSession', () => {
            const sm = new SessionManager()
            const session = createTestSession()
            session.groupChatId = -100

            sm.registerSession(session, -100)

            expect(sm.getSession(session.id)).toBe(session)
            expect(sm.getSessionByGroup(-100)).toBe(session)
        })

        it('getCoreSession delegates to getSession', () => {
            const sm = new SessionManager()
            const session = createTestSession()
            sm.registerSession(session, -100)

            expect(sm.getSession(session.id)).toBe(session)
        })

        it('getCoreSessionByGroup delegates to getSessionByGroup', () => {
            const sm = new SessionManager()
            const session = createTestSession()
            sm.registerSession(session, -100, 42)

            expect(sm.getSessionByGroup(-100, 42)).toBe(session)
        })

        it('hasCoreSessionInGroup delegates to hasSessionInGroup', () => {
            const sm = new SessionManager()
            const session = createTestSession()
            sm.registerSession(session, -100, 42)

            expect(sm.hasSessionInGroup(-100)).toBe(true)
        })

        it('registerCorePermission delegates to registerPermission', () => {
            const sm = new SessionManager()
            const session = createTestSession()
            sm.registerPermission('req-1', session)

            expect(sm.getSessionForPermission('req-1')).toBe(session)
        })

        it('getCoreSessionForPermission delegates to getSessionForPermission', () => {
            const sm = new SessionManager()
            const session = createTestSession()
            sm.registerPermission('req-1', session)

            expect(sm.getSessionForPermission('req-1')).toBe(session)
        })

        it('removeCoreSession delegates to removeSession', () => {
            const sm = new SessionManager()
            const session = createTestSession()
            session.groupChatId = -100
            sm.registerSession(session, -100)
            sm.removeSession(session.id)

            expect(sm.getSession(session.id)).toBeUndefined()
            expect(sm.getSessionByGroup(-100)).toBeUndefined()
        })

        it('listActiveCoreSessions delegates to listActiveSessions', () => {
            const sm = new SessionManager()
            const session = createTestSession()
            sm.registerSession(session, -100)

            expect(sm.listActiveSessions()).toEqual([session])
        })
    })
})
