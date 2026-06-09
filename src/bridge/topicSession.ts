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

const TOPIC_PROVIDER_DESTROY_TIMEOUT_MS = 10_000

async function waitForShutdownStep(
    promise: Promise<unknown>,
    timeoutMs: number,
    onTimeoutOrError: (message: string) => void,
): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
        await Promise.race([
            promise,
            new Promise((resolve) => {
                timeout = setTimeout(() => resolve('timeout'), timeoutMs)
            }),
        ]).then((result) => {
            if (result === 'timeout') {
                onTimeoutOrError(`timed out after ${timeoutMs}ms`)
            }
        })
    } catch (e) {
        onTimeoutOrError(e instanceof Error ? e.message : String(e))
    } finally {
        if (timeout) clearTimeout(timeout)
    }
}

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
        if (provider.destroy) {
            await waitForShutdownStep(
                provider.destroy(),
                TOPIC_PROVIDER_DESTROY_TIMEOUT_MS,
                (message) => glog(`[TopicSession] provider destroy did not finish cleanly: ${message}`),
            )
        }
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
            const progress = runtime.getProgress()
            return {
                state: progress.state === 'querying' || progress.state === 'finalizing'
                    ? 'querying'
                    : progress.state === 'canceling'
                        ? 'canceling'
                        : progress.state === 'dead'
                            ? 'dead'
                            : 'idle',
                elapsedSeconds: progress.elapsedSeconds,
                lastToolName: progress.lastToolName,
                outbox: progress.outbox,
            }
        },
    }
}
