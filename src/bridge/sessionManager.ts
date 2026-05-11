import { config } from '@/config'
import type { EventBus } from '@/core/eventBus'
import { DefaultEventBus } from '@/core/eventBus'
import { createProviderInstance, getProvider, getDefaultProvider } from '@/providers/registry'
import type { TopicSession } from './channelPort'
import { createSessionRecord, type SessionRecord } from './sessionRecord'

/** Telegram General topic thread ID — sendMessage rejects this, so we normalize it to "main". */
export const TELEGRAM_GENERAL_TOPIC_ID = 1

/**
 * Normalize a Telegram message_thread_id.
 * General topic (threadId=1) is treated as "no topic" because:
 * - sendMessage with message_thread_id=1 returns "message thread not found"
 * - Some clients/updates may set it to 1 while others omit it for General
 * This normalization ensures consistent session keys regardless of how
 * Telegram reports the General topic's thread ID.
 */
export function normalizeThreadId(threadId?: number): number | undefined {
    if (!threadId || threadId === TELEGRAM_GENERAL_TOPIC_ID) return undefined
    return threadId
}

export function isGenericTopic(threadId?: number): boolean {
    return normalizeThreadId(threadId) === undefined
}

export function makeTopicKey(chatId: number, threadId?: number): string {
    const normalized = normalizeThreadId(threadId)
    return normalized ? `${chatId}:${normalized}` : `${chatId}:main`
}

/**
 * Build thread params for sendMessage / editMessageText / sendPhoto.
 * General topic (threadId=1) must NOT include message_thread_id —
 * Telegram API rejects "message thread not found" otherwise.
 * Omitting message_thread_id routes the message to the General topic automatically.
 */
export function buildMessageThreadParams(threadId?: number): Record<string, number> {
    if (!threadId || threadId === TELEGRAM_GENERAL_TOPIC_ID) return {}
    return { message_thread_id: threadId }
}

/**
 * Build thread params for sendChatAction (typing indicators).
 * Unlike sendMessage, sendChatAction REQUIRES message_thread_id=1
 * for typing to appear in the General topic.
 */
export function buildChatActionThreadParams(threadId?: number): Record<string, number> {
    if (!threadId) return {}
    return { message_thread_id: threadId }
}

export interface GroupSettings {
    model?: string
    permissionMode?: string
    verboseLevel?: 0 | 1 | 2
    providerName?: string
    timeoutSeconds?: number
}

export class SessionManager {
    private sessions = new Map<string, SessionRecord>()
    private groupSessions = new Map<string, SessionRecord>()
    private groupCwds = new Map<number, string>()
    private groupSettings = new Map<number, GroupSettings>()
    private archivedGroups = new Set<string>()
    private groupFailures = new Map<string, { count: number; lastFailure: number }>()
    private creatingSessions = new Set<string>()
    private _eventBus: EventBus | null = null
    private topicSessions = new Map<string, TopicSession>()

    setEventBus(bus: EventBus): void {
        this._eventBus = bus
    }

    loadPersistedState(): void {
        const states = config.getAllGroupStates()
        for (const [chatIdStr, state] of Object.entries(states)) {
            const chatId = Number(chatIdStr)
            if (state.cwd) {
                this.groupCwds.set(chatId, state.cwd)
            }
            if (state.settings) {
                this.groupSettings.set(chatId, { ...state.settings })
            }
        }
        console.error(`[codever] Loaded persisted state for ${Object.keys(states).length} groups`)
    }

    tryAcquireCreationLock(topicKey: string): boolean {
        if (this.creatingSessions.has(topicKey)) {
            return false
        }
        this.creatingSessions.add(topicKey)
        return true
    }

    releaseCreationLock(topicKey: string): void {
        this.creatingSessions.delete(topicKey)
    }

    registerSession(session: SessionRecord, groupChatId: number, messageThreadId?: number): void {
        const topicKey = makeTopicKey(groupChatId, messageThreadId)
        this.sessions.set(session.id, session)
        this.groupSessions.set(topicKey, session)
    }

    getSession(id: string): SessionRecord | undefined {
        return this.sessions.get(id)
    }

    getSessionByGroup(chatId: number, messageThreadId?: number): SessionRecord | undefined {
        const topicKey = makeTopicKey(chatId, messageThreadId)
        return this.groupSessions.get(topicKey)
    }

    /** Find a session by its provider-assigned conversation ID */
    getSessionByConversationId(conversationId: string): SessionRecord | undefined {
        for (const session of this.sessions.values()) {
            if (session.conversationId === conversationId) return session
        }
        return undefined
    }

    /** Check if any topic in the given group has an active session */
    hasSessionInGroup(chatId: number): boolean {
        const prefix = `${chatId}:`
        for (const key of this.groupSessions.keys()) {
            if (key.startsWith(prefix)) return true
        }
        return false
    }

    setGroupCwd(chatId: number, cwd: string): void {
        this.groupCwds.set(chatId, cwd)
        config.saveGroupState(chatId, { cwd })
    }

    getGroupCwd(chatId: number): string | undefined {
        return this.groupCwds.get(chatId)
    }

    setGroupSettings(chatId: number, settings: Partial<GroupSettings>): void {
        const existing = this.groupSettings.get(chatId) || {}
        const merged = { ...existing, ...settings }
        for (const [key, value] of Object.entries(settings)) {
            if (value === undefined) {
                delete (merged as Record<string, unknown>)[key]
            }
        }
        this.groupSettings.set(chatId, merged)
        config.saveGroupState(chatId, { settings: merged })
    }

    getGroupSettings(chatId: number): GroupSettings | undefined {
        return this.groupSettings.get(chatId)
    }

    removeSession(id: string): void {
        const session = this.sessions.get(id)
        if (!session) return
        this._eventBus?.emit({ type: 'session.destroyed', sessionId: id })
        if (session.groupChatId !== null) {
            const topicKey = makeTopicKey(session.groupChatId, session.messageThreadId ?? undefined)
            this.groupSessions.delete(topicKey)
        }
        this.sessions.delete(id)
    }

    recordGroupFailure(topicKey: string): void {
        const existing = this.groupFailures.get(topicKey) || { count: 0, lastFailure: 0 }
        existing.count++
        existing.lastFailure = Date.now()
        this.groupFailures.set(topicKey, existing)
    }

    isGroupInCooldown(topicKey: string): boolean {
        const failure = this.groupFailures.get(topicKey)
        if (!failure) return false
        const cooldownMs = Math.min(5000 * Math.pow(2, failure.count - 1), 60000)
        return (Date.now() - failure.lastFailure) < cooldownMs
    }

    clearGroupFailures(topicKey: string): void {
        this.groupFailures.delete(topicKey)
    }

    migrateTopicKey(oldTopicKey: string, newTopicKey: string): SessionRecord | null {
        const session = this.groupSessions.get(oldTopicKey)
        if (!session) return null
        this.groupSessions.delete(oldTopicKey)
        this.groupSessions.set(newTopicKey, session)
        const failure = this.groupFailures.get(oldTopicKey)
        if (failure) {
            this.groupFailures.set(newTopicKey, failure)
            this.groupFailures.delete(oldTopicKey)
        }
        console.error(`[codever] migrateTopicKey: ${oldTopicKey} → ${newTopicKey}, session=${session.id.slice(0, 8)}`)
        return session
    }

    archiveGroup(topicKey: string): void {
        this.archivedGroups.add(topicKey)
    }

    isGroupArchived(topicKey: string): boolean {
        return this.archivedGroups.has(topicKey)
    }

    unarchiveGroup(topicKey: string): void {
        this.archivedGroups.delete(topicKey)
    }

    listActiveSessions(): SessionRecord[] {
        return Array.from(this.sessions.values())
    }

    /**
     * Switch the provider for a session by destroying the old one and creating a new one.
     * The new session inherits groupChatId, messageThreadId, and group-level settings.
     * Returns the new session metadata record, or null if no session found at the given topicKey.
     */
    async switchProvider(chatId: number, messageThreadId: number | undefined, newProviderName: string): Promise<SessionRecord | null> {
        const topicKey = makeTopicKey(chatId, messageThreadId)
        const oldSession = this.groupSessions.get(topicKey)
        if (!oldSession) return null

        // Destroy the old session
        await oldSession.destroy()
        this.removeSession(oldSession.id)

        // Get the new provider
        const provider = createProviderInstance(newProviderName) ?? getProvider(newProviderName) ?? getDefaultProvider()

        // Create a new session with the same channel info
        const bus = this._eventBus ?? new DefaultEventBus()
        const settings = this.getGroupSettings(chatId)
        const newSession = createSessionRecord({
            cwd: this.getGroupCwd(chatId) ?? process.cwd(),
            providerName: newProviderName,
            groupChatId: chatId,
            messageThreadId,
            verboseLevel: settings?.verboseLevel,
            timeoutSeconds: settings?.timeoutSeconds,
            providerSettings: settings?.permissionMode ? { permissionMode: settings.permissionMode } : {},
            bus,
        })
        newSession.setProvider(provider)

        this.registerSession(newSession, chatId, messageThreadId)
        return newSession
    }

    // --- Topic session management ---

    registerTopicSession(topicKey: string, topicSession: TopicSession): void {
        this.topicSessions.set(topicKey, topicSession)
    }

    getTopicSession(topicKey: string): TopicSession | undefined {
        return this.topicSessions.get(topicKey)
    }

    getTopicSessionBySessionId(sessionId: string): TopicSession | undefined {
        for (const topicSession of this.topicSessions.values()) {
            if (topicSession.sessionRecord.id === sessionId) return topicSession
        }
        return undefined
    }

    getTopicSessionByConversationId(conversationId: string): TopicSession | undefined {
        for (const topicSession of this.topicSessions.values()) {
            if (topicSession.sessionRecord.conversationId === conversationId) return topicSession
        }
        return undefined
    }

    removeTopicSession(topicKey: string): void {
        this.topicSessions.delete(topicKey)
    }

    getTopicSessionsMap(): Map<string, TopicSession> {
        return this.topicSessions
    }
}
