/**
 * TopicSession — Wires QueryLoop + Provider + ChannelPort + Pipeline.
 * Replaces the monolithic coreSessionLauncher.ts with a composable bridge pattern.
 */

import type { QueryLoop, QueryLoopInput } from '@/core/queryLoop'
import { QueryLoop as QueryLoopClass } from '@/core/queryLoop'
import type { AgentProvider } from '@/providers/provider'
import type { AgentEvent, AgentToolUseEvent, AgentToolResultEvent, AgentResultEvent, AgentSessionInitEvent } from '@/providers/types'
import type { QueryLoopEvent, QueryLoopState, PermissionDecision } from '@/core/types'
import type { ChannelPort, ChannelMessage, TopicSession } from './channelPort'
import type { MiddlewarePipeline, OutputMessage } from '@/middleware/pipeline'
import type { MiddlewareContext } from '@/middleware/types'
import { escapeHtml } from '@/utils/formatting'
import { config } from '@/config'
import { getProvider, getDefaultProvider } from '@/providers/registry'
import { DefaultEventBus } from '@/core/eventBus'
import { makeTopicKey, normalizeThreadId } from '@/bridge/sessionManager'
import { ToolMessageTracker } from '@/channel/telegram/toolBubble'

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
    const { queryLoop, provider, channelPort, pipeline, logger } = options
    let running = true

    const chatId = queryLoop.groupChatId!
    const threadId = normalizeThreadId(queryLoop.messageThreadId ?? undefined)

    function glog(line: string): void {
        if (logger) logger.group(chatId, line)
    }

    // --- Serial send queue ---
    // Ensures all channelPort.send() calls execute in order, preventing
    // out-of-order delivery to Telegram caused by concurrent HTTP requests.
    let sendChain: Promise<void> = Promise.resolve()

    function queuedSend(msg: ChannelMessage): void {
        sendChain = sendChain.then(async () => {
            try {
                await channelPort.send(msg)
            } catch (e) {
                glog(`[TopicSession] Failed to send message: ${e instanceof Error ? e.message : e}`)
            }
        })
    }

    function queuedSendAndTrack(msg: ChannelMessage, toolUseId?: string): void {
        sendChain = sendChain.then(async () => {
            try {
                const result = await channelPort.send(msg)
                if (toolUseId && result.messageId !== undefined) {
                    toolMessageTracker.set(toolUseId, Number(result.messageId))
                }
            } catch (e) {
                glog(`[TopicSession] Failed to send message: ${e instanceof Error ? e.message : e}`)
            }
        })
    }

    function queuedEdit(messageId: string | number, msg: ChannelMessage): void {
        sendChain = sendChain.then(async () => {
            try {
                if (channelPort.edit) {
                    await channelPort.edit(messageId, msg)
                }
            } catch (e) {
                glog(`[TopicSession] Failed to edit message: ${e instanceof Error ? e.message : e}`)
            }
        })
    }

    async function drainSendQueue(): Promise<void> {
        await sendChain
    }

    // --- Tool message tracker for progressive display ---
    const toolMessageTracker = new ToolMessageTracker()

    // Set provider on the session
    queryLoop.setProvider(provider)

    // --- EventBus Wiring ---

    queryLoop.bus.on('query.started', (e: QueryLoopEvent) => {
        if (e.type !== 'query.started' || e.sessionId !== queryLoop.id) return
        glog(`[query] Started: queryId=${e.queryId.slice(0, 8)} model=${queryLoop.model ?? 'default'}`)

        // Start timeout heartbeat on query start
        pipeline.getTimeout()?.start()

        // Clear tool message tracker from previous queries
        toolMessageTracker.finalizeAll()

        // Mark query in progress
        if (queryLoop.groupChatId !== null) {
            const topicKey = makeTopicKey(queryLoop.groupChatId, queryLoop.messageThreadId ?? undefined)
            config.setTopicQueryInProgress(topicKey)
        }

        const modelInfo = queryLoop.model ? `\nModel: <code>${escapeHtml(queryLoop.model)}</code>` : ''
        const cwdInfo = `\nCWD: <code>${escapeHtml(queryLoop.cwd)}</code>`
        queuedSend({ text: `🚀 <b>Session started</b>${modelInfo}${cwdInfo}`, format: 'html' })
        channelPort.notifyStatus({ state: 'querying', model: queryLoop.model ?? undefined, cwd: queryLoop.cwd, provider: queryLoop.providerName })
    })

    queryLoop.bus.on('query.event', (e: QueryLoopEvent) => {
        if (e.type !== 'query.event' || e.sessionId !== queryLoop.id) return

        if (e.event.kind === 'session_init' && e.event.sessionId) {
            if (queryLoop.groupChatId !== null) {
                const topicKey = makeTopicKey(queryLoop.groupChatId, queryLoop.messageThreadId ?? undefined)
                glog(`[TopicSession] Persisting conversationId=${e.event.sessionId.slice(0, 8)} for topicKey=${topicKey}`)
                config.saveTopicState(topicKey, { conversationId: e.event.sessionId })
            }
            glog(`[query] Session init: conversationId=${e.event.sessionId} model=${e.event.model ?? '?'}`)
            // Notify the user when a stale session could not be recovered and a
            // fresh one was created — they should know their previous context was lost.
            if (e.event.isNewSession) {
                queuedSend({
                    text: '⚠️ Previous session could not be recovered (agent was restarted). A new session has been created.',
                    format: 'html',
                })
            }
        }

        if (e.event.kind === 'text') {
            glog(`[query:text] ${e.event.text.slice(0, 200)}`)
        } else if (e.event.kind === 'tool_use') {
            const inputStr = typeof e.event.input === 'string' ? e.event.input : JSON.stringify(e.event.input)
            glog(`[query:tool_use] ${e.event.toolName} input=${inputStr.slice(0, 150)}`)
        } else if (e.event.kind === 'tool_result') {
            const outStr = typeof e.event.output === 'string' ? e.event.output : JSON.stringify(e.event.output)
            glog(`[query:tool_result] ${e.event.toolName ?? '?'} output=${outStr.slice(0, 150)}`)
        } else if (e.event.kind === 'result') {
            glog(`[query:result] status=${e.event.status} duration=${e.event.durationMs ?? '?'}ms cost=${e.event.costUsd ?? '?'}usd`)
        }

        // Process event through pipeline and send output to channel
        processQueryEvent(e.event, e.queryId)
    })

    queryLoop.bus.on('query.completed', (e: QueryLoopEvent) => {
        if (e.type !== 'query.completed' || e.sessionId !== queryLoop.id) return
        glog(`[query] Completed: status=${e.result.status}`)

        // Flush any remaining buffered text — the query is done, send what we have
        const remaining = pipeline.flushSync('query-completed')
        if (remaining) {
            const msgPreview = remaining.text.slice(0, 80).replace(/\n/g, '\\n')
            glog(`[TopicSession] query.completed flush: ${remaining.text.length}ch md=${remaining.isMarkdown} preview=${msgPreview}`)
            const channelMsg: ChannelMessage = remaining.isMarkdown
                ? { text: remaining.text, format: 'markdown' }
                : { text: remaining.text, format: 'html' }
            queuedSend(channelMsg)
            queryLoop.bus.emit({ type: 'message.outgoing', sessionId: queryLoop.id, text: remaining.text })
        } else {
            glog(`[TopicSession] query.completed flush empty`)
        }

        if (queryLoop.groupChatId !== null) {
            const topicKey = makeTopicKey(queryLoop.groupChatId, queryLoop.messageThreadId ?? undefined)
            config.clearTopicQueryInProgress(topicKey)
        }
        channelPort.notifyStatus({ state: 'idle', model: queryLoop.model ?? undefined, cwd: queryLoop.cwd, provider: queryLoop.providerName })
    })

    queryLoop.bus.on('query.error', async (e: QueryLoopEvent) => {
        if (e.type !== 'query.error' || e.sessionId !== queryLoop.id) return
        const errMsg = e.error instanceof Error ? e.error.message : String(e.error)
        glog(`[query] Error: ${errMsg}`)

        // Flush any remaining buffered text before showing the error
        const remaining = pipeline.flushSync('query-error')
        if (remaining) {
            const msgPreview = remaining.text.slice(0, 80).replace(/\n/g, '\\n')
            glog(`[TopicSession] query.error flush: ${remaining.text.length}ch md=${remaining.isMarkdown} preview=${msgPreview}`)
            const channelMsg: ChannelMessage = remaining.isMarkdown
                ? { text: remaining.text, format: 'markdown' }
                : { text: remaining.text, format: 'html' }
            queuedSend(channelMsg)
            queryLoop.bus.emit({ type: 'message.outgoing', sessionId: queryLoop.id, text: remaining.text })
        }

        if (queryLoop.groupChatId !== null) {
            const topicKey = makeTopicKey(queryLoop.groupChatId, queryLoop.messageThreadId ?? undefined)
            config.clearTopicQueryInProgress(topicKey)
        }
        queuedSend({ text: `❌ Error: ${errMsg}`, format: 'html' })
        channelPort.notifyStatus({ state: 'idle', model: queryLoop.model ?? undefined, cwd: queryLoop.cwd, provider: queryLoop.providerName })
    })

    queryLoop.bus.on('query.timeout', async (e: QueryLoopEvent) => {
        if (e.type !== 'query.timeout' || e.sessionId !== queryLoop.id) return
        const elapsedSec = Math.round(e.elapsed / 1000)
        glog(`[query] Timeout: ${elapsedSec}s`)

        // Probe agent liveness on timeout
        if (!provider.isReady()) {
            // Agent is dead — auto-interrupt and attempt reinit
            glog(`[query] Timeout probe: agent not ready, auto-interrupting`)
            queuedSend({ text: `💀 Agent has stopped responding after ${elapsedSec}s. Attempting to reconnect...`, format: 'html' })
                try {
                    await queryLoop.interrupt('stop')
            } catch (err) {
                glog(`[SessionBridge] Failed to interrupt on timeout: ${err instanceof Error ? err.message : err}`)
            }
            // Attempt provider reinit
            if (provider.wasReady?.() && provider.reinit) {
                try {
                    await provider.reinit()
                    if (provider.isReady()) {
                        queuedSend({ text: `✅ Agent reconnected. Send a message to continue.`, format: 'html' })
                    } else {
                        const err = provider.getInitError() ?? 'Reconnection failed'
                        queuedSend({ text: `❌ Agent could not restart: ${err}. Use /new to start a fresh session.`, format: 'html' })
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err)
                    queuedSend({ text: `❌ Agent could not restart: ${msg}. Use /new to start a fresh session.`, format: 'html' })
                }
            } else {
                queuedSend({ text: `❌ Agent process is no longer running. Use /new to start a fresh session.`, format: 'html' })
            }
        } else {
            // Agent is alive but slow — notify user
            const lastTool = pipeline.getTimeout()?.lastToolName
            const toolHint = lastTool ? ` (running ${lastTool})` : ''
            const timeoutMsg = `⚠️ No response for ${elapsedSec}s${toolHint}.\n\nAgent is still working. Use /progress to check status, /stop to abort.`
            queuedSend({ text: timeoutMsg, format: 'html' })
        }
    })

    queryLoop.bus.on('session.state_changed', (e: QueryLoopEvent) => {
        if (e.type !== 'session.state_changed' || e.sessionId !== queryLoop.id) return
        glog(`[session] State: ${e.from} → ${e.to}`)

        // Only flush on dead state as a safety net for buffer leaks.
        // Normal query completion flush is handled by query.completed / query.error handlers.
        if (e.to === 'dead') {
            const remaining = pipeline.flushSync('session-dead-cleanup')
            if (remaining) {
                const msgPreview = remaining.text.slice(0, 80).replace(/\n/g, '\\n')
                glog(`[TopicSession] Dead-state cleanup flush: ${remaining.text.length}ch md=${remaining.isMarkdown} preview=${msgPreview}`)
                const channelMsg: ChannelMessage = remaining.isMarkdown
                    ? { text: remaining.text, format: 'markdown' }
                    : { text: remaining.text, format: 'html' }
                queuedSend(channelMsg)
                queryLoop.bus.emit({ type: 'message.outgoing', sessionId: queryLoop.id, text: remaining.text })
            }
        }

        if (e.to === 'dead') running = false
    })

    queryLoop.bus.on('message.queued', (e: QueryLoopEvent) => {
        if (e.type !== 'message.queued' || e.sessionId !== queryLoop.id) return
        glog(`[query] Message queued: #${e.queueSize}`)
        queuedSend({
            text: `📨 Agent is working. Your message has been queued (#${e.queueSize}) and will be processed when the current task completes.\nUse /stop to interrupt.`,
            format: 'html',
        })
    })

    // --- Pipeline event processing ---

    function processQueryEvent(event: AgentEvent, queryId: string): void {
        const context: MiddlewareContext = {
            sessionId: queryLoop.id,
            queryId,
            verboseLevel: queryLoop.verboseLevel,
            providerSettings: queryLoop.providerSettings,
            timeoutSeconds: queryLoop.timeoutSeconds,
            bus: queryLoop.bus,
        }

        const result = pipeline.processEvent(event, context)

        for (const msg of result.messages) {
            const eventDesc = event.kind === 'text' ? `text(${(event.text ?? '').length}ch)` : event.kind === 'tool_use' ? `tool_use(${event.toolName})` : event.kind === 'tool_result' ? `tool_result` : event.kind
            const msgPreview = msg.text.slice(0, 80).replace(/\n/g, '\\n')
            glog(`[TopicSession] processQueryEvent send: src=${eventDesc} md=${msg.isMarkdown} tool=${msg.isToolEvent} done=${msg.isDone} ${msg.text.length}ch preview=${msgPreview}`)

            const channelMsg: ChannelMessage = msg.isMarkdown
                ? { text: msg.text, format: 'markdown' }
                : { text: msg.text, format: 'html', replyMarkup: msg.replyMarkup }

            // Progressive tool display: if this is a tool event and we already have
            // a message for this toolUseId, edit the existing message instead of sending new
            if (msg.isToolEvent && msg.toolUseId) {
                const existingMessageId = toolMessageTracker.get(msg.toolUseId)
                if (existingMessageId) {
                    queuedEdit(existingMessageId, channelMsg)
                    // Don't emit message.outgoing for edits (they're updates, not new messages)
                    continue
                }
            }

            queuedSendAndTrack(channelMsg, msg.toolUseId)
            queryLoop.bus.emit({ type: 'message.outgoing', sessionId: queryLoop.id, text: msg.text })
        }
    }

    // --- Input handling ---

    function receiveInput(input: { text: string; username?: string }): void {
        if (!running) return
        glog(`[msg:in] ${input.username ?? '?'}: ${input.text.slice(0, 100)}`)

        // Notify channelPort about user message (for table history tracking)
        if ('notifyUserMessage' in channelPort && typeof (channelPort as any).notifyUserMessage === 'function') {
            ;(channelPort as any).notifyUserMessage()
        }

        const loopInput: QueryLoopInput = {
            text: input.text,
            chatId,
            messageThreadId: threadId,
            username: input.username,
        }

        if (!provider.isReady()) {
            handleProviderNotReady(loopInput)
            return
        }

        queryLoop.processInput(loopInput).catch((e) => {
            glog(`[TopicSession] processInput error: ${e instanceof Error ? e.message : e}`)
        })
    }

    function handleProviderNotReady(input: QueryLoopInput): void {
        if (provider.wasReady?.() && provider.reinit) {
            glog(`[session] Provider crashed, attempting reinit...`)
            queuedSend({ text: `⚠️ Agent process crashed, reconnecting...`, format: 'html' })
            provider.reinit().then(() => {
                if (provider.isReady()) {
                    glog(`[session] Provider reinit succeeded`)
                    queuedSend({ text: `✅ Agent reconnected`, format: 'html' })
                    queryLoop.processInput(input).catch((e) => {
                        glog(`[TopicSession] processInput error after reinit: ${e instanceof Error ? e.message : e}`)
                    })
                } else {
                    const err = provider.getInitError() ?? 'Reconnection failed'
                    glog(`[session] Provider reinit failed: ${err}`)
                    queuedSend({ text: `❌ Agent could not restart: ${err}. Use /new to start a fresh session.`, format: 'html' })
                }
            }).catch((e) => {
                const err = e instanceof Error ? e.message : String(e)
                glog(`[session] Provider reinit error: ${err}`)
                queuedSend({ text: `❌ Agent could not restart: ${err}. Use /new to start a fresh session.`, format: 'html' })
            })
            return
        }

        if ('init' in provider && typeof (provider as any).init === 'function') {
            glog(`[session] Provider not yet initialized, waiting for init...`)
            queuedSend({ text: `⏳ Agent is starting up, please wait...`, format: 'html' })
            ;(provider as any).init().then(() => {
                if (provider.isReady()) {
                    glog(`[session] Provider init completed, processing message`)
                    queryLoop.processInput(input).catch((e) => {
                        glog(`[TopicSession] processInput error after init: ${e instanceof Error ? e.message : e}`)
                    })
                } else {
                    const err = provider.getInitError() ?? 'Initialization failed'
                    glog(`[session] Provider init failed: ${err}`)
                    queuedSend({ text: `❌ Provider "${provider.name}" is not available: ${err}`, format: 'html' })
                }
            }).catch((e: unknown) => {
                const err = e instanceof Error ? e.message : String(e)
                glog(`[session] Provider init error: ${err}`)
                queuedSend({ text: `❌ Provider "${provider.name}" is not available: ${err}`, format: 'html' })
            })
            return
        }

        const err = provider.getInitError() ?? 'Provider not available'
        glog(`[session] Provider not ready and no init method: ${err}`)
        queuedSend({ text: `❌ Provider "${provider.name}" is not available: ${err}`, format: 'html' })
    }

    async function destroy(): Promise<void> {
        await queryLoop.destroy()
        await drainSendQueue()
    }

    return {
        receiveInput,
        destroy,
        get state(): QueryLoopState {
            return queryLoop.state
        },
        get queryLoop() {
            return queryLoop
        },
        get channelPort() {
            return channelPort
        },
        getProgress() {
            const timeout = pipeline.getTimeout()
            if (!timeout) return null
            return timeout.getProgress()
        },
    }
}
