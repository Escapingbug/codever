import type { TopicSession } from '@/bridge/channelPort'
import { makeTopicKey, type SessionManager } from '@/bridge/sessionManager'
import type { ScheduledTask } from '@/core/scheduler'

export function findTopicSessionForApiSession(sessionManager: SessionManager, sessionId: string): TopicSession | undefined {
    const byTopicKey = sessionManager.getTopicSession(sessionId)
    if (byTopicKey) return byTopicKey

    const byConversationId = sessionManager.getTopicSessionByConversationId(sessionId)
    if (byConversationId) return byConversationId

    const sessionRecord = sessionManager.getSession(sessionId)
    if (sessionRecord) {
        return sessionManager.getTopicSessionBySessionId(sessionRecord.id)
    }

    return undefined
}

export function getTopicKeyForTopicSession(topicSession: TopicSession): string {
    const { groupChatId, messageThreadId } = topicSession.sessionRecord
    if (groupChatId === null) {
        throw new Error(`Topic session ${topicSession.sessionRecord.id.slice(0, 8)} is not attached to a Telegram group`)
    }
    return makeTopicKey(groupChatId, messageThreadId ?? undefined)
}

export function getApiSessionTargetKeysForTopicSession(topicSession: TopicSession): Set<string> {
    const keys = new Set<string>([
        getTopicKeyForTopicSession(topicSession),
        topicSession.sessionRecord.id,
    ])
    if (topicSession.sessionRecord.conversationId) {
        keys.add(topicSession.sessionRecord.conversationId)
    }
    return keys
}

export function isScheduledTaskForTopicSession(task: ScheduledTask, topicSession: TopicSession): boolean {
    return getApiSessionTargetKeysForTopicSession(topicSession).has(task.topicKey)
}

export function resolveTopicSessionForApiSession(sessionManager: SessionManager, sessionId: string): TopicSession {
    const topicSession = findTopicSessionForApiSession(sessionManager, sessionId)
    if (!topicSession) {
        throw new Error(`No topic session found for ${sessionId.slice(0, 8)}`)
    }
    return topicSession
}
