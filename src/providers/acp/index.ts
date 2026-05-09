/**
 * AcpProvider — ACP-based agent provider implementation.
 *
 * Uses the Agent Client Protocol to communicate with an ACP-compliant
 * agent subprocess via stdio. Session management is explicit:
 * - session/new creates a session
 * - session/prompt sends a prompt and blocks until the turn completes
 * - session/cancel interrupts the current turn but preserves the session
 *
 * During a prompt, session/update notifications arrive via the Client
 * callback and are forwarded to the PushableAsyncIterable for consumption.
 */

import type { AgentProvider, AgentQueryConfig, AgentQueryHandle, ModelEntry } from '@/providers/provider'
import type { AgentEvent } from '@/providers/types'
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable'
import { AcpClientManager, type AcpClientManagerConfig } from './AcpClientManager'
import { adaptStopReason, mapSessionUpdate, parseRawInput as _parseRawInput } from './eventAdapter'
import { unwrapToolOutput } from '@/utils/unwrapToolOutput'
import type { SessionNotification, ContentBlock as AcpContentBlock } from '@agentclientprotocol/sdk'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Resolve the path to the codever MCP stdio server entry point.
 * In development, this is relative to the source. In production (tsup bundle),
 * it's relative to the dist directory.
 */
function getCodeverMcpServerPath(): string {
    try {
        const __filename = fileURLToPath(import.meta.url)
        const __dirname = dirname(__filename)
        // dist/daemon.js → dist/mcp/stdio.js
        return resolve(__dirname, 'mcp', 'stdio.js')
    } catch {
        // Fallback: assume cwd
        return resolve(process.cwd(), 'dist', 'mcp', 'stdio.js')
    }
}

/**
 * Build the codever MCP server config for ACP mcpServers.
 *
 * Two variants:
 * - Base config (no sessionId): used for session/new, where sessionId doesn't exist yet.
 *   Registers context resources/tools only — no notify tools that require session identity.
 * - Full config (with sessionId): used for session/load or session/resume, where sessionId is known.
 *   Injects CODEVER_CONVERSATION_ID into env so MCP subprocess can identify its session.
 *   Registers all tools including notify tools (schedule_reminder, cancel_reminder, send_message).
 *
 * Note: Some agents (e.g. Cursor's `agent` CLI) don't support session/resume, and their
 * session/load only works on persisted sessions (i.e. after at least one prompt completes).
 * For such agents, the flow is:
 *   1. newSession with base MCP config → get sessionId
 *   2. Skip Phase 2 (no resume/load) → prompt directly
 *   3. After prompt completes, attempt loadSession with full MCP config
 *   4. If loadSession succeeds, MCP tools with session identity become available on next turn
 *   If loadSession fails, the session continues without session-scoped MCP tools.
 */
function buildCodeverMcpBaseConfig(): Array<{
    type: 'stdio'
    name: string
    command: string
    args: string[]
    env: Array<{ name: string; value: string }>
}> {
    const mcpServerPath = getCodeverMcpServerPath()
    const nodePath = process.execPath

    return [{
        type: 'stdio' as const,
        name: 'codever',
        command: nodePath,
        args: [mcpServerPath],
        env: [],
    }]
}

function buildCodeverMcpFullConfig(sessionId: string): Array<{
    type: 'stdio'
    name: string
    command: string
    args: string[]
    env: Array<{ name: string; value: string }>
}> {
    const mcpServerPath = getCodeverMcpServerPath()
    const nodePath = process.execPath

    return [{
        type: 'stdio' as const,
        name: 'codever',
        command: nodePath,
        args: [mcpServerPath],
        env: [
            { name: 'CODEVER_CONVERSATION_ID', value: sessionId },
        ],
    }]
}

export function parseRawInput(rawInput: unknown): unknown {
    return _parseRawInput(rawInput)
}

export function extractOutputFromContent(content: Array<unknown>): string | null {
    if (!content || content.length === 0) return null
    const parts: string[] = []
    for (const item of content) {
        const c = item as Record<string, unknown>
        if (c.type === 'content') {
            const inner = c.content as Record<string, unknown> | undefined
            if (inner && inner.type === 'text') {
                parts.push((inner as { type: 'text'; text: string }).text)
            } else {
                parts.push(JSON.stringify(inner))
            }
        } else if (c.type === 'diff') {
            parts.push(JSON.stringify(c))
        } else {
            parts.push(JSON.stringify(c))
        }
    }
    return parts.join('\n')
}

export { mapSessionUpdate as mapUpdateToEvents }

export interface AcpProviderConfig {
    name: string
    command: string
    args: string[]
    env?: Record<string, string>
}

export class AcpProvider implements AgentProvider {
    readonly name: string
    private clientManager: AcpClientManager
    private _initError: string | null = null
    private initialized = false
    private initPromise: Promise<void> | null = null

    /** Track the active sessionId for the current query (for interrupt support) */
    private activeSessionId: string | null = null

    /** Abort signal for the current query */
    private activeAbortSignal: AbortSignal | null = null

    constructor(config: AcpProviderConfig) {
        this.name = config.name
        const managerConfig: AcpClientManagerConfig = {
            command: config.command,
            args: config.args,
            env: config.env,
        }
        this.clientManager = new AcpClientManager(managerConfig)
    }

    async init(): Promise<void> {
        if (this.initialized) return
        if (this.initPromise) return this.initPromise

        this.initPromise = this._doInit()
        return this.initPromise
    }

    private async _doInit(): Promise<void> {
        try {
            await this.clientManager.init()
            this.initialized = true
            console.error(`[acp:${this.name}] Provider initialized`)
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            console.error(`[acp:${this.name}] Init failed: ${msg}`)
            this._initError = msg
            this.initPromise = null // Allow retry
        }
    }

    isReady(): boolean {
        return this.initialized && this.clientManager.connected
    }

    /**
     * Returns true if the provider was previously initialized but is now
     * disconnected (e.g., agent subprocess crashed). Distinguishes from
     * "never initialized" state.
     */
    wasReady(): boolean {
        return this.initialized && !this.clientManager.connected
    }

    getInitError(): string | null {
        return this._initError
    }

    /**
     * Re-initialize the provider after a crash. Closes the dead connection,
     * resets internal state, and spawns a new agent subprocess.
     */
    async reinit(): Promise<void> {
        console.error(`[acp:${this.name}] Reinitializing provider after crash...`)
        try {
            await this.clientManager.close()
        } catch (e) {
            console.error(`[acp:${this.name}] close() during reinit failed: ${e instanceof Error ? e.message : String(e)}`)
        }
        this.initialized = false
        this.initPromise = null
        this._initError = null
        await this.init()
    }

    startQuery(prompt: string, config: AgentQueryConfig): AgentQueryHandle {
        const events = new PushableAsyncIterable<AgentEvent>()
        const clientManager = this.clientManager

        // Set permission handler on the client manager
        if (config.permissionHandler) {
            clientManager.setPermissionHandler(config.permissionHandler)
        }

        // Fire-and-forget the prompt sequence
        const runQuery = async () => {
            // Clear stderr buffer at the start of each query so we only
            // capture errors from the current turn.
            clientManager.clearStderrBuffer()

            try {
                let sessionId = config.sessionId

                let isResumingSession = false
                /** Whether the session was resumed via loadSession (which replays history).
                 *  resumeSession does NOT replay history, so drain logic is not needed. */
                let needsHistoryDrain = false

                console.error(`[acp:${this.name}] startQuery: config.sessionId=${config.sessionId?.slice(0, 8) ?? 'null'} → will ${config.sessionId ? 'resume/load' : 'newSession'}`)

                const supportsResume = clientManager.supportsResumeSession
                const supportsLoad = clientManager.agentCapabilities?.agentCapabilities?.loadSession

                // 1. Create or load session
                if (!sessionId) {
                    // Two-phase session creation:
                    // Phase 1: newSession with base MCP config (no session-dependent tools).
                    //   At this point sessionId doesn't exist yet, so we can't inject it into env.
                    const sessionResponse = await clientManager.newSession({
                        cwd: config.cwd,
                        mcpServers: buildCodeverMcpBaseConfig(),
                    })
                    sessionId = sessionResponse.sessionId
                    this.activeSessionId = sessionId
                    console.error(`[acp:${this.name}] Created session ${sessionId}`)

                    // Phase 2: Reconnect MCP servers with full config (including session env).
                    //   Now sessionId is known, we inject it via mcpServers.env so the MCP subprocess
                    //   can identify which ACP session it belongs to.
                    //
                    //   Prefer resumeSession over loadSession:
                    //   - resumeSession does NOT replay conversation history (correct for a fresh session)
                    //   - loadSession replays the ENTIRE history, which can cause the agent to
                    //     aggregate context from other sessions in the same cwd (cross-session leakage)
                    //
                    //   Some agents (e.g. Cursor's `agent` CLI) don't support resumeSession, and
                    //   their loadSession only works on persisted sessions (after a prompt completes).
                    //   For those, we skip Phase 2 and inject full MCP config after the first prompt.
                    if (supportsResume) {
                        try {
                            await clientManager.resumeSession({
                                sessionId,
                                cwd: config.cwd,
                                mcpServers: buildCodeverMcpFullConfig(sessionId),
                            })
                            console.error(`[acp:${this.name}] Resumed new session ${sessionId} with full MCP config (no history replay)`)
                        } catch (e) {
                            // resumeSession might not be supported by this agent version;
                            // fall back to loadSession
                            const msg = e instanceof Error ? e.message : String(e)
                            console.error(`[acp:${this.name}] resumeSession failed, falling back to loadSession: ${msg}`)
                            if (supportsLoad) {
                                try {
                                    await clientManager.loadSession({
                                        sessionId,
                                        cwd: config.cwd,
                                        mcpServers: buildCodeverMcpFullConfig(sessionId),
                                    })
                                    console.error(`[acp:${this.name}] Reloaded session ${sessionId} with full MCP config (fallback)`)
                                } catch (loadErr) {
                                    // loadSession may fail if the agent doesn't support loading
                                    // a freshly created session (e.g. Cursor agent requires at
                                    // least one prompt to persist the session). We'll try again
                                    // after the first prompt completes.
                                    const loadMsg = loadErr instanceof Error ? loadErr.message : String(loadErr)
                                    console.error(`[acp:${this.name}] loadSession also failed for new session: ${loadMsg}. Will inject full MCP config after first prompt.`)
                                }
                            }
                        }
                    } else if (supportsLoad) {
                        // No resumeSession support — try loadSession.
                        // This may fail for agents that only persist sessions after a prompt
                        // (e.g. Cursor agent). If it fails, we proceed without full MCP config
                        // and retry after the first prompt.
                        try {
                            await clientManager.loadSession({
                                sessionId,
                                cwd: config.cwd,
                                mcpServers: buildCodeverMcpFullConfig(sessionId),
                            })
                            console.error(`[acp:${this.name}] Reloaded session ${sessionId} with full MCP config (legacy, no resume support)`)
                        } catch (loadErr) {
                            const loadMsg = loadErr instanceof Error ? loadErr.message : String(loadErr)
                            console.error(`[acp:${this.name}] loadSession failed for new session: ${loadMsg}. Will inject full MCP config after first prompt.`)
                        }
                    }

                    // Set model if specified
                    if (config.model) {
                        try {
                            await clientManager.setSessionModel({
                                sessionId: sessionId!,
                                modelId: config.model,
                            })
                            console.error(`[acp:${this.name}] Set model to ${config.model}`)
                        } catch (e) {
                            const msg = e instanceof Error ? e.message : String(e)
                            console.error(`[acp:${this.name}] Failed to set model: ${msg}`)
                        }
                        // Also set via config option as fallback
                        try {
                            await clientManager.setSessionConfigOption({
                                sessionId: sessionId!,
                                configId: 'model',
                                value: config.model,
                            })
                            console.error(`[acp:${this.name}] Set config model to ${config.model}`)
                        } catch (e) {
                            const msg = e instanceof Error ? e.message : String(e)
                            console.error(`[acp:${this.name}] Failed to set config model: ${msg}`)
                        }
                    }
                } else {
                    // Attempt to resume or load an existing session (conversationId from
                    // a previous gateway run). If the agent can't find the session (e.g.
                    // its session data was lost after a subprocess restart), fall back to
                    // creating a fresh session so the user isn't stuck with a broken one.
                    let sessionRecovered = false

                    if (supportsResume) {
                        try {
                            await clientManager.resumeSession({
                                sessionId,
                                cwd: config.cwd,
                                mcpServers: buildCodeverMcpFullConfig(sessionId),
                            })
                            this.activeSessionId = sessionId
                            isResumingSession = true
                            sessionRecovered = true
                            console.error(`[acp:${this.name}] Resumed session ${sessionId} (no history replay)`)
                        } catch (e) {
                            const msg = e instanceof Error ? e.message : String(e)
                            console.error(`[acp:${this.name}] resumeSession failed, falling back to loadSession: ${msg}`)
                        }
                    }

                    if (!sessionRecovered && supportsLoad) {
                        try {
                            await clientManager.loadSession({
                                sessionId,
                                cwd: config.cwd,
                                mcpServers: buildCodeverMcpFullConfig(sessionId),
                            })
                            this.activeSessionId = sessionId
                            isResumingSession = true
                            needsHistoryDrain = true
                            sessionRecovered = true
                            console.error(`[acp:${this.name}] Loaded session ${sessionId} (will drain history)`)
                        } catch (loadErr) {
                            const loadMsg = loadErr instanceof Error ? loadErr.message : String(loadErr)
                            console.error(`[acp:${this.name}] loadSession failed for existing session: ${loadMsg}`)
                        }
                    }

                    if (!sessionRecovered) {
                        // Neither resumeSession nor loadSession could recover the old session.
                        // The agent may have been restarted or the session data was lost.
                        // Create a new session so the user can continue working.
                        console.error(`[acp:${this.name}] Could not recover session ${sessionId}. Creating a new session.`)
                        try {
                            const sessionResponse = await clientManager.newSession({
                                cwd: config.cwd,
                                mcpServers: buildCodeverMcpBaseConfig(),
                            })
                            sessionId = sessionResponse.sessionId
                            this.activeSessionId = sessionId
                            isResumingSession = false

                            // Try to inject full MCP config for the new session
                            if (supportsResume) {
                                try {
                                    await clientManager.resumeSession({
                                        sessionId,
                                        cwd: config.cwd,
                                        mcpServers: buildCodeverMcpFullConfig(sessionId),
                                    })
                                    console.error(`[acp:${this.name}] Resumed new session ${sessionId} with full MCP config (after recovery failure)`)
                                } catch (e) {
                                    const msg = e instanceof Error ? e.message : String(e)
                                    console.error(`[acp:${this.name}] resumeSession for new fallback session failed: ${msg}`)
                                }
                            } else if (supportsLoad) {
                                try {
                                    await clientManager.loadSession({
                                        sessionId,
                                        cwd: config.cwd,
                                        mcpServers: buildCodeverMcpFullConfig(sessionId),
                                    })
                                    console.error(`[acp:${this.name}] Loaded new fallback session ${sessionId} with full MCP config`)
                                } catch (loadErr) {
                                    const loadMsg = loadErr instanceof Error ? loadErr.message : String(loadErr)
                                    console.error(`[acp:${this.name}] loadSession for new fallback session failed: ${loadMsg}. Will inject after first prompt.`)
                                }
                            }
                        } catch (newErr) {
                            // Even new session creation failed — fall through to prompt
                            // the stale sessionId as a last resort. The prompt will likely
                            // fail with "No conversation found" and QueryLoop's retry logic
                            // will handle it.
                            const newMsg = newErr instanceof Error ? newErr.message : String(newErr)
                            console.error(`[acp:${this.name}] newSession also failed after recovery failure: ${newMsg}. Attempting prompt with stale sessionId.`)
                            this.activeSessionId = sessionId
                            isResumingSession = true
                        }
                    }

                    // Set model if specified (user may have changed model mid-session)
                    if (config.model) {
                        try {
                            await clientManager.setSessionModel({
                                sessionId: sessionId!,
                                modelId: config.model,
                            })
                            console.error(`[acp:${this.name}] Set model to ${config.model}`)
                        } catch (e) {
                            const msg = e instanceof Error ? e.message : String(e)
                            console.error(`[acp:${this.name}] Failed to set model: ${msg}`)
                        }
                        try {
                            await clientManager.setSessionConfigOption({
                                sessionId: sessionId!,
                                configId: 'model',
                                value: config.model,
                            })
                            console.error(`[acp:${this.name}] Set config model to ${config.model}`)
                        } catch (e) {
                            const msg = e instanceof Error ? e.message : String(e)
                            console.error(`[acp:${this.name}] Failed to set config model: ${msg}`)
                        }
                    }
                }

                // 2. Push session_init event
                if (!events.done) {
                    events.push({
                        kind: 'session_init',
                        sessionId,
                        cwd: config.cwd,
                        // Flag: true when a stale conversationId could not be recovered
                        // and a brand-new session was created instead. The bridge can
                        // use this to notify the user that previous context was lost.
                        isNewSession: !isResumingSession && !!config.sessionId,
                    })
                }

                // 3. Start consuming session updates in background.
                // For loadSession-based resumes, historical updates are filtered by
                // sequence number boundary in AcpClientManager — no need for promptSent flag.

                if (needsHistoryDrain) {
                    const drained = clientManager.drainSessionUpdates(sessionId!)
                    console.error(`[acp] Drained ${drained} historical updates from resumed session (loadSession path)`)
                }

                const updateConsumer = async () => {
                    while (!events.done) {
                        try {
                            const notification = await clientManager.waitForSessionUpdate(sessionId!)
                            if (events.done) break
                            const agentEvents = mapSessionUpdate(notification.update)
                            for (const event of agentEvents) {
                                if (events.done) break
                                const eventSummary = event.kind === 'text' ? `text(${(event.text ?? '').length}ch)` : event.kind === 'tool_use' ? `tool_use(${event.toolName} id=${(event.toolUseId ?? '').slice(0,8)})` : event.kind === 'tool_result' ? `tool_result(id=${(event.toolUseId ?? '').slice(0,8)})` : event.kind
                                console.error(`[acp] updateConsumer → events.push: ${eventSummary}`)
                                events.push(event)
                            }
                        } catch (e) {
                            const msg = e instanceof Error ? e.message : String(e)
                            console.error(`[acp:${this.name}] updateConsumer error: ${msg}`)
                            if (!events.done) {
                                events.push({ kind: 'result', status: 'error', summary: `Session update stream interrupted: ${msg}`.substring(0, 200) })
                                events.end()
                            }
                            break
                        }
                    }
                }

                const updatePromise = updateConsumer()

                // 5. Send the prompt (blocks until turn completes)
                const promptResponse = await clientManager.prompt({
                    sessionId: sessionId!,
                    prompt: [{ type: 'text', text: prompt } as AcpContentBlock],
                })
                console.error(`[acp:${this.name}] Prompt returned: stopReason=${promptResponse.stopReason}, sessionId=${sessionId}`)



                // 5b. Drain any remaining queued session updates that arrived
                //     before or concurrently with the prompt response. The update
                //     consumer may not have processed them yet because it awaits
                //     waitForSessionUpdate() which yields one at a time.
                if (!events.done) {
                    let remaining = clientManager.dequeueSessionUpdate(sessionId!)
                    while (remaining) {
                        const updateType = (remaining.update as any)?.sessionUpdate ?? '?'
                        console.error(`[acp] dequeueSessionUpdate: updateType=${updateType}`)
                        const agentEvents = mapSessionUpdate(remaining.update)
                        for (const event of agentEvents) {
                            if (events.done) break
                            const eventSummary = event.kind === 'text' ? `text(${(event.text ?? '').length}ch)` : event.kind === 'tool_use' ? `tool_use(${event.toolName} id=${(event.toolUseId ?? '').slice(0,8)})` : event.kind === 'tool_result' ? `tool_result(id=${(event.toolUseId ?? '').slice(0,8)})` : event.kind
                            console.error(`[acp] dequeueSessionUpdate → events.push: ${eventSummary}`)
                            events.push(event)
                        }
                        remaining = clientManager.dequeueSessionUpdate(sessionId!)
                    }
                }

                // 6. Push final result event based on stopReason
                // Also check stderr for fatal errors that the agent may have
                // emitted without reflecting in the ACP protocol response.
                const stderrError = clientManager.getStderrError()
                if (!events.done) {
                    const resultEvent = adaptStopReason(promptResponse.stopReason)
                    if (stderrError && resultEvent.status === 'success') {
                        // Agent wrote a fatal error to stderr but still returned
                        // a successful stop reason — override to error so the
                        // user actually sees what went wrong.
                        resultEvent.status = 'error'
                        resultEvent.summary = stderrError.substring(0, 200)
                    }
                    events.push(resultEvent)
                    events.end()
                }
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e)
                console.error(`[acp:${this.name}] Query failed: ${msg}`)
                if (!events.done) {
                    events.push({ kind: 'result', status: 'error', summary: msg.substring(0, 200) })
                    events.end()
                }
            }
        }

        void runQuery()

        // Handle abort signal
        if (config.signal) {
            this.activeAbortSignal = config.signal
            const onAbort = () => {
                this.forceCancelActivePrompt()
            }
            config.signal.addEventListener('abort', onAbort, { once: true })
        }

        const handle: AgentQueryHandle = {
            events,
            interrupt: async () => {
                await this.forceCancelActivePrompt()
            },
        }

        return handle
    }

    getAvailableModels(): ModelEntry[] {
        // Models are configured at the agent side, not exposed via ACP
        return []
    }

    getAvailablePermissionModes(): string[] {
        return ['default', 'acceptEdits', 'bypassPermissions']
    }

    clearSessionId(): void {
        // ACP manages session identity internally — no-op
    }

    /**
     * Cancel the active prompt with grace period.
     * 1. Send session/cancel and wait up to 2.5s for prompt to return
     * 2. If agent doesn't respond, log a warning but DO NOT kill the subprocess.
     *    cancel() must never kill the subprocess — only destroy() does.
     * 3. End the event stream so the consumer loop breaks out
     */
    private async forceCancelActivePrompt(): Promise<void> {
        const clientManager = this.clientManager
        const sid = this.activeSessionId

        if (sid) {
            console.error(`[acp:${this.name}] Cancelling active prompt for session ${sid}`)
            try {
                const response = await clientManager.cancelActivePrompt(2_500)
                if (response) {
                    console.error(`[acp:${this.name}] Prompt cancelled gracefully, stopReason=${response.stopReason}`)
                    return
                }
            } catch (e) {
                console.error(`[acp:${this.name}] cancelActivePrompt error: ${e instanceof Error ? e.message : String(e)}`)
            }

            // Agent didn't respond to cancel within grace period.
            // We intentionally do NOT close the client here — cancel() must never
            // kill the subprocess. The agent may still be processing, and the
            // next prompt can reuse the same session. If the agent is truly
            // stuck, the user can /archive to destroy the session.
            console.error(`[acp:${this.name}] Agent did not respond to cancel within grace period, leaving connection open`)
        }
    }
}
