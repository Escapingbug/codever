/**
 * TopicSession — Wires channel sessions to the semantic session runtime.
 */

import type { AgentProvider } from '@/providers/provider'
import type { SessionState } from '@/core/types'
import type { ChannelPort, TopicSession } from './channelPort'
import type { RichUserInput } from '@/runtime/semantic'
import { config } from '@/config'
import { makeTopicKey } from '@/bridge/sessionManager'
import { SemanticSessionRuntime } from '@/runtime/semanticSessionRuntime'
import { createSessionRecord, type SessionRecord, type SessionRecordOptions } from './sessionRecord'

// --- Session metadata factory ---

export type CreateSessionRecordOptions = SessionRecordOptions

export function createTopicSessionRecord(options: CreateSessionRecordOptions): SessionRecord {
    return createSessionRecord(options)
}

export interface TopicSessionConfig {
    sessionRecord: SessionRecord
    provider: AgentProvider
    channelPort: ChannelPort
    /** Optional group logger */
    logger?: { group(chatId: number, line: string): void }
}

export function createTopicSession(options: TopicSessionConfig): TopicSession {
    const { sessionRecord, provider, channelPort, logger } = options
    const chatId = sessionRecord.groupChatId!

    function glog(line: string): void {
        if (logger) logger.group(chatId, line)
    }

    const runtime = new SemanticSessionRuntime({
        sessionId: sessionRecord.id,
        cwd: sessionRecord.cwd,
        provider,
        providerName: sessionRecord.providerName,
        channelPort,
        model: sessionRecord.model,
        providerSessionId: sessionRecord.conversationId,
        providerSettings: sessionRecord.providerSettings,
        onLog: glog,
        onModelChanged: (model) => {
            sessionRecord.setModel(model)
        },
        onProviderSessionId: (sessionId) => {
            sessionRecord.setConversationId(sessionId)
            if (sessionRecord.groupChatId !== null) {
                const topicKey = makeTopicKey(sessionRecord.groupChatId, sessionRecord.messageThreadId ?? undefined)
                config.saveTopicState(topicKey, { conversationId: sessionId })
            }
        },
        onProviderChanged: (providerName, nextProvider) => {
            sessionRecord.setProvider(nextProvider)
            sessionRecord.setProviderName(providerName)
            sessionRecord.setModel(null)
            sessionRecord.setConversationId(null)
        },
        onAvailableCommands: (commands) => {
            sessionRecord.availableCommands = commands
        },
    })

    function receiveInput(input: { text: string; username?: string; richInput?: RichUserInput }): void {
        void runtime.dispatch({
            kind: 'user_message',
            text: input.text,
            ...(input.richInput ? { richInput: input.richInput } : {}),
            source: 'channel',
            user: { username: input.username, displayName: input.username },
        }).catch((e) => {
            glog(`[TopicSession] dispatch error: ${e instanceof Error ? e.message : e}`)
        })
    }

    async function destroy(): Promise<void> {
        await runtime.destroy()
        await provider.destroy?.()
        await sessionRecord.destroy()
    }

    return {
        receiveInput,
        dispatch(input) {
            return runtime.dispatch(input)
        },
        destroy,
        get state(): SessionState {
            const state = runtime.getState()
            if (state === 'querying' || state === 'finalizing') return 'querying'
            if (state === 'canceling') return 'canceling'
            if (state === 'dead') return 'dead'
            return 'idle'
        },
        get sessionRecord() {
            return sessionRecord
        },
        get channelPort() {
            return channelPort
        },
        getProgress() {
            return null
        },
    }
}
