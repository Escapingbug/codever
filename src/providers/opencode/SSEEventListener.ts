/**
 * SSEEventListener — persistent SSE event listener with exponential backoff reconnect.
 *
 * Follows the kimaki pattern:
 * - One long-lived SSE connection for all sessions
 * - Automatic reconnect with exponential backoff on stream break
 * - Event filtering (drop session.diff, message.part.delta from buffer)
 * - Routes events through the EventRouter to per-query streams
 */

import type { OpencodeClient } from '@opencode-ai/sdk'
import { EventRouter } from './EventRouter'
import type { AgentEvent } from '@/providers/types'
import { unwrapToolOutput } from '@/utils/unwrapToolOutput'

export class SSEEventListener {
    private clientFactory: () => OpencodeClient
    private eventRouter: EventRouter
    private abortController = new AbortController()
    private backoffMs = 500
    private readonly maxBackoffMs = 30_000
    private running = false
    private connected = false

    /** Called when a new session is discovered from SSE events */
    private onSessionDiscovered?: (sessionId: string) => void

    /** Directory to filter SSE events (required for receiving session events) */
    private directory: string

    constructor(clientFactory: () => OpencodeClient, eventRouter: EventRouter, directory: string, onSessionDiscovered?: (sessionId: string) => void) {
        this.clientFactory = clientFactory
        this.eventRouter = eventRouter
        this.directory = directory
        this.onSessionDiscovered = onSessionDiscovered
    }

    get isConnected(): boolean { return this.connected }

    start(): void {
        if (this.running) return
        this.running = true
        void this.listenerLoop()
    }

    stop(): void {
        this.running = false
        this.abortController.abort()
    }

    /**
     * Force a reconnect (used after server restart).
     */
    reconnect(): void {
        this.abortController.abort()
        this.abortController = new AbortController()
        this.backoffMs = 500
        // If the loop is still running, it will detect the abort
        // and loop back with the fresh controller.
        // If not, restart it.
        if (!this.running) {
            this.running = true
            void this.listenerLoop()
        }
    }

    private async listenerLoop(): Promise<void> {
        while (this.running) {
            const signal = this.abortController.signal
            if (signal.aborted) {
                // Check if this was a reconnect() request
                if (this.running && !this.abortController.signal.aborted) {
                    continue // Fresh signal, try again
                }
                return
            }

            const client = this.clientFactory()

            try {
                const sseResult = await client.event.subscribe({
                    query: { directory: this.directory },
                    signal,
                })

                // Reset backoff on successful connection
                this.backoffMs = 500
                this.connected = true
                console.error(`[opencode-sse] Connected to event stream`)

                for await (const event of sseResult.stream) {
                    if (signal.aborted) break
                    if (!this.running) return

                    const raw = event as Record<string, unknown>
                    this.handleRawEvent(raw)
                }

                this.connected = false
                console.error(`[opencode-sse] Stream ended`)
            } catch (e: unknown) {
                this.connected = false
                if (!this.running) return

                const isAbort = (e instanceof DOMException && e.name === 'AbortError')
                    || (e instanceof Error && (e.message?.includes('abort') || e.message?.includes('Abort')))
                if (isAbort) {
                    // Reconnect was requested — loop with fresh signal
                    if (this.running) continue
                    return
                }

                console.error(`[opencode-sse] Subscribe error: ${e instanceof Error ? e.message : String(e).substring(0, 80)}`)
            }

            // Exponential backoff before reconnect
            if (this.running) {
                console.error(`[opencode-sse] Reconnecting in ${this.backoffMs}ms...`)
                await this.delay(this.backoffMs)
                this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs)
            }
        }
    }

    /**
     * Handle a raw SSE event: filter, adapt, route.
     */
    private handleRawEvent(raw: Record<string, unknown>): void {
        const type = raw.type as string

        // Filter out high-volume/unused events (kimaki pattern)
        if (type === 'session.diff') return

        // Extract sessionId from event
        const sessionId = this.extractSessionId(raw)
        if (!sessionId) return

        // Track busy/idle state in router
        if (type === 'session.status') {
            const status = (raw as any).properties?.status
            if (status?.type === 'busy') {
                this.eventRouter.markBusy(sessionId)
            } else if (status?.type === 'idle') {
                this.eventRouter.markIdle(sessionId)
            }
        }

        // Adapt and route the event
        const agentEvents = this.adaptEvent(raw, sessionId)

        for (const agentEvent of agentEvents) {
            // Route to the correct query stream
            const routed = this.eventRouter.pushEvent(sessionId, agentEvent)

            // Handle terminal events
            if (agentEvent.kind === 'result') {
                this.eventRouter.endQuery(sessionId)
            }
        }

        // Handle session.idle — end the query
        if (type === 'session.idle') {
            const pushable = this.eventRouter.getPushable(sessionId)
            if (pushable && !pushable.done) {
                // Only push result if not already pushed by adaptEvent
                // (session.idle adapts to result:success)
                if (!this.eventRouter.hasRoute(sessionId)) return
                // Already handled above via adaptEvent
            }
            this.eventRouter.markIdle(sessionId)
        }

        // Handle session.error — inject synthetic idle if no session.idle follows
        if (type === 'session.error') {
            this.eventRouter.markIdle(sessionId)
            // The error event adapts to result:error which ends the query
        }
    }

    /**
     * Extract sessionId from an SSE event.
     */
    private extractSessionId(raw: Record<string, unknown>): string | undefined {
        const type = raw.type as string
        const props = (raw as any).properties

        // Most events have properties.sessionID
        if (props?.sessionID) return props.sessionID as string

        // session.created has properties.info.id
        if (type === 'session.created' && props?.info?.id) {
            return props.info.id as string
        }

        // message.updated / message.part.updated have properties.info.sessionID or properties.part.sessionID
        if (props?.info?.sessionID) return props.info.sessionID as string
        if (props?.part?.sessionID) return props.part.sessionID as string

        // session.updated has properties.info.id
        if (type === 'session.updated' && props?.info?.id) {
            return props.info.id as string
        }

        return undefined
    }

    /**
     * Adapt a raw SSE event to AgentEvent(s).
     */
    private adaptEvent(raw: Record<string, unknown>, sessionId: string): AgentEvent[] {
        const type = raw.type as string
        const results: AgentEvent[] = []
        const props = (raw as any).properties

        switch (type) {
            case 'session.created': {
                const id = props?.info?.id as string | undefined
                if (id) {
                    // Notify provider that a new session was discovered
                    // so it can bind the queryId to this sessionId.
                    // Do NOT push session_init here — the provider pushes it
                    // explicitly after session.create() to avoid duplicates.
                    this.onSessionDiscovered?.(id)
                }
                break
            }

            case 'session.status': {
                results.push({
                    kind: 'raw',
                    providerName: 'opencode',
                    rawMessage: raw,
                })
                break
            }

            case 'session.idle': {
                results.push({
                    kind: 'result',
                    status: 'success',
                })
                break
            }

            case 'session.error': {
                const err = props?.error
                const summary = err
                    ? (err.data as Record<string, unknown>)?.message
                        ? String((err.data as Record<string, unknown>).message)
                        : err.name
                    : 'Unknown session error'
                results.push({
                    kind: 'result',
                    status: 'error',
                    summary,
                })
                break
            }

            case 'message.updated': {
                const msg = props?.info
                if (msg?.role === 'assistant' && msg.error) {
                    const summary = (msg.error.data as Record<string, unknown>)?.message
                        ? String((msg.error.data as Record<string, unknown>).message)
                        : msg.error.name
                    results.push({
                        kind: 'result',
                        status: 'error',
                        summary,
                    })
                }
                if (msg?.role === 'assistant' && msg.time?.completed && msg.finish) {
                    results.push({
                        kind: 'raw',
                        providerName: 'opencode',
                        rawMessage: { type: 'assistant.completed', info: msg },
                    })
                }
                results.push({
                    kind: 'raw',
                    providerName: 'opencode',
                    rawMessage: raw,
                })
                break
            }

            case 'message.part.updated': {
                const part = props?.part
                if (part) {
                    results.push(...this.adaptPart(part))
                }
                break
            }

            case 'message.part.delta': {
                const delta = props?.delta as string | undefined
                const field = props?.field as string | undefined
                if (field === 'text' && delta) {
                    results.push({ kind: 'text', text: delta })
                } else if (delta) {
                    results.push({
                        kind: 'raw',
                        providerName: 'opencode',
                        rawMessage: raw,
                    })
                }
                break
            }

            case 'permission.updated': {
                results.push({
                    kind: 'raw',
                    providerName: 'opencode',
                    rawMessage: raw,
                })
                break
            }

            case 'permission.replied': {
                results.push({
                    kind: 'raw',
                    providerName: 'opencode',
                    rawMessage: raw,
                })
                break
            }

            case 'session.updated': {
                // Title change, etc. — not actionable
                break
            }

            default: {
                results.push({
                    kind: 'raw',
                    providerName: 'opencode',
                    rawMessage: raw,
                })
                break
            }
        }

        return results
    }

    /**
     * Adapt a Part from message.part.updated.
     */
    private adaptPart(part: Record<string, unknown>): AgentEvent[] {
        const results: AgentEvent[] = []
        const type = part.type as string

        switch (type) {
            case 'text': {
                const text = part.text as string | undefined
                const timeEnd = (part.time as Record<string, unknown>)?.end
                const timeStart = (part.time as Record<string, unknown>)?.start
                // Non-streamed text (e.g. user message) — emit as-is
                if (text && !timeStart) {
                    results.push({ kind: 'text', text })
                }
                // Streaming text with time.end = completed, skip (deltas already sent)
                break
            }

            case 'tool': {
                const toolName = part.tool as string
                const callID = part.callID as string | undefined
                const state = part.state as Record<string, unknown> | undefined
                const status = state?.status as string | undefined

                console.error('[DEBUG SSEEventListener] tool event:', JSON.stringify({ toolName, callID, status, input: state?.input }).substring(0, 300))

                switch (status) {
                    case 'pending':
                    case 'running': {
                        const rawInput = state?.input
                        let parsedInput = rawInput
                        if (typeof rawInput === 'string') {
                            try { parsedInput = JSON.parse(rawInput) } catch { /* use raw string */ }
                        }
                        const rawInputStr = typeof rawInput === 'string' ? rawInput : (rawInput != null ? JSON.stringify(rawInput) : undefined)
                        results.push({
                            kind: 'tool_use',
                            toolName,
                            toolUseId: callID,
                            input: parsedInput,
                            status: status as 'pending' | 'running',
                            ...(rawInputStr ? { rawInput: rawInputStr } : {}),
                            isInputComplete: false,
                        })
                        break
                    }
                    case 'completed': {
                        const rawOutput = state?.output
                        let output = ''
                        let structuredOutput: unknown = undefined
                        if (typeof rawOutput === 'string') {
                            output = unwrapToolOutput(rawOutput)
                            structuredOutput = rawOutput
                        } else if (typeof rawOutput === 'object' && rawOutput !== null) {
                            output = unwrapToolOutput(rawOutput as Record<string, unknown>)
                            structuredOutput = rawOutput
                        } else if (rawOutput != null) {
                            output = String(rawOutput)
                            structuredOutput = rawOutput
                        }
                        results.push({
                            kind: 'tool_result',
                            toolUseId: callID,
                            output,
                            isError: false,
                            toolName,
                            ...(structuredOutput !== undefined ? { structuredOutput } : {}),
                        })
                        break
                    }
                    case 'error': {
                        const rawError = state?.error
                        let errorOutput = 'Tool error'
                        if (typeof rawError === 'string') {
                            errorOutput = unwrapToolOutput(rawError)
                        } else if (typeof rawError === 'object' && rawError !== null) {
                            errorOutput = unwrapToolOutput(rawError as Record<string, unknown>)
                        } else if (rawError != null) {
                            errorOutput = String(rawError)
                        }
                        results.push({
                            kind: 'tool_result',
                            toolUseId: callID,
                            output: errorOutput,
                            isError: true,
                            toolName,
                        })
                        break
                    }
                }
                break
            }

            case 'step-start':
            case 'step-finish': {
                results.push({
                    kind: 'raw',
                    providerName: 'opencode',
                    rawMessage: part,
                })
                break
            }

            case 'reasoning': {
                results.push({
                    kind: 'raw',
                    providerName: 'opencode',
                    rawMessage: part,
                })
                break
            }

            default: {
                results.push({
                    kind: 'raw',
                    providerName: 'opencode',
                    rawMessage: part,
                })
                break
            }
        }

        return results
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
}
