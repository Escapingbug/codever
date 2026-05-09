/**
 * TopicSession — Wires channel sessions to the semantic session runtime.
 */

import type { QueryLoop } from '@/core/queryLoop'
import { QueryLoop as QueryLoopClass } from '@/core/queryLoop'
import type { AgentProvider } from '@/providers/provider'
import type { QueryLoopState } from '@/core/types'
import type { ChannelPort, TopicSession } from './channelPort'
import type { MiddlewarePipeline } from '@/middleware/pipeline'
import { config } from '@/config'
import { getProvider, getDefaultProvider } from '@/providers/registry'
import { DefaultEventBus } from '@/core/eventBus'
import { makeTopicKey } from '@/bridge/sessionManager'
import { SemanticSessionRuntime } from '@/runtime/semanticSessionRuntime'

// --- QueryLoop factory ---

export interface CreateQueryLoopOptions {
    cwd: string
    providerName: string
    groupChatId: number
    messageThreadId?: number
    model?: string
    verboseLevel?: 0 | 1 | 2
    timeoutSeconds?: number
    providerSettings?: Record<string, unknown>
    conversationId?: string | null
}

export function createQueryLoop(options: CreateQueryLoopOptions): QueryLoop {
    const provider = getProvider(options.providerName) ?? getDefaultProvider()
    const eventBus = new DefaultEventBus()
    const queryLoop = new QueryLoopClass({
        cwd: options.cwd,
        provider,
        bus: eventBus,
        model: options.model,
        providerName: options.providerName,
        verboseLevel: options.verboseLevel,
        timeoutSeconds: options.timeoutSeconds,
        providerSettings: options.providerSettings ?? {},
    })
    queryLoop.groupChatId = options.groupChatId
    queryLoop.messageThreadId = options.messageThreadId ?? null
    if (options.conversationId) {
        queryLoop.setConversationId(options.conversationId)
    }
    return queryLoop
}

export interface TopicSessionConfig {
    queryLoop: QueryLoop
    provider: AgentProvider
    channelPort: ChannelPort
    pipeline: MiddlewarePipeline
    /** Optional group logger */
    logger?: { group(chatId: number, line: string): void }
}

export function createTopicSession(options: TopicSessionConfig): TopicSession {
    const { queryLoop, provider, channelPort, logger } = options
    const chatId = queryLoop.groupChatId!

    function glog(line: string): void {
        if (logger) logger.group(chatId, line)
    }

    const runtime = new SemanticSessionRuntime({
        sessionId: queryLoop.id,
        cwd: queryLoop.cwd,
        provider,
        providerName: queryLoop.providerName,
        channelPort,
        model: queryLoop.model,
        providerSessionId: queryLoop.conversationId,
        providerSettings: queryLoop.providerSettings,
        onLog: glog,
        onProviderSessionId: (sessionId) => {
            queryLoop.setConversationId(sessionId)
            if (queryLoop.groupChatId !== null) {
                const topicKey = makeTopicKey(queryLoop.groupChatId, queryLoop.messageThreadId ?? undefined)
                config.saveTopicState(topicKey, { conversationId: sessionId })
            }
        }
    })

    function receiveInput(input: { text: string; username?: string }): void {
        void runtime.dispatch({
            kind: 'user_message',
            text: input.text,
            source: 'channel',
            user: { username: input.username, displayName: input.username },
        }).catch((e) => {
            glog(`[SessionActor] dispatch error: ${e instanceof Error ? e.message : e}`)
        })
    }

    async function destroy(): Promise<void> {
        await runtime.destroy()
        await queryLoop.destroy()
    }

    return {
        receiveInput,
        dispatch(input) {
            return runtime.dispatch(input)
        },
        destroy,
        get state(): QueryLoopState {
            const state = runtime.getState()
            if (state === 'querying' || state === 'finalizing') return 'querying'
            if (state === 'canceling') return 'canceling'
            if (state === 'dead') return 'dead'
            return 'idle'
        },
        get queryLoop() {
            return queryLoop
        },
        get channelPort() {
            return channelPort
        },
        getProgress() {
            return null
        },
    }
}
