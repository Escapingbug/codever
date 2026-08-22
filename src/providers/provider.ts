import type { AgentEvent } from './types'
import type { DecisionRequest, DecisionResponse } from '@/bridge/channelPort'
import type { RichUserInput } from '@/runtime/semantic'

export class ProviderNotReadyError extends Error {
    constructor(providerName: string, reason: string) {
        super(`Provider "${providerName}" is not available: ${reason}`)
        this.name = 'ProviderNotReadyError'
    }
}

export interface AgentPermissionResult {
    behavior: 'allow' | 'deny'
    updatedInput?: Record<string, unknown>
    message?: string
    permanent?: boolean
}

export interface ToolCallRecord {
    name: string
    input: unknown
}

export interface AgentPermissionHandler {
    handleToolCall(toolName: string, input: unknown, options: { signal: AbortSignal; recentToolCalls?: ToolCallRecord[] }): Promise<AgentPermissionResult>
    onEvent?(event: AgentEvent): void
    reset(): void
}

export interface AgentDecisionHandler {
    requestDecision(request: DecisionRequest): Promise<DecisionResponse>
}

export interface AgentQueryHandle {
    events: AsyncIterable<AgentEvent>
    interrupt(): Promise<void>
    setPermissionMode?(mode: string): Promise<void>
    onActivity?: () => void
}

export interface AgentQueryConfig {
    cwd: string
    /** Codever runtime session identity, distinct from the provider's session ID. */
    codeverSessionId?: string
    sessionId?: string
    signal: AbortSignal
    model?: string
    permissionHandler?: AgentPermissionHandler
    decisionHandler?: AgentDecisionHandler
    providerSettings?: Record<string, unknown>
    debugLog?: (line: string) => void
}

export type AgentQueryInput = string | RichUserInput

export interface ModelEntry {
    id: string
    name: string
    provider?: string
    defaultReasoningLevel?: string
    supportedReasoningLevels?: Array<{
        effort: string
        description?: string
    }>
}

export interface SessionEntry {
    sessionId: string
    title: string
    updated: number
    cwd?: string
    firstMessage?: string
}

export interface ProviderHistoryMessage {
    id: string
    role: 'user' | 'assistant'
    text: string
}

export interface ProviderSessionHistory {
    sessionId: string
    title: string
    messages: ProviderHistoryMessage[]
}

export interface AgentProvider {
    readonly name: string

    startQuery(prompt: AgentQueryInput, config: AgentQueryConfig): AgentQueryHandle

    isReady(): boolean
    getInitError(): string | null

    /** Returns true if provider was initialized but is now disconnected (crash) */
    wasReady?(): boolean

    /** Re-initialize provider after a crash (close dead connection, spawn new subprocess) */
    reinit?(): Promise<void>

    getAvailableModels(): ModelEntry[]
    /**
     * Validate or normalize a model selected for this provider.
     *
     * The runtime treats model ids as provider-owned opaque strings. Providers
     * with custom model semantics can return the value to pass through, return a
     * normalized id, or return undefined to suppress a stale incompatible model.
     */
    resolveModel?(model: string): string | undefined
    getAvailablePermissionModes(): string[]

    /** List available sessions for a given cwd */
    listSessions?(cwd: string): Promise<SessionEntry[]>

    /** Get the first user message for a specific session (lazy, on-demand) */
    getSessionFirstMessage?(sessionId: string): Promise<string>

    /** Load a provider-owned session without adopting it into Codever. */
    getSessionHistory?(sessionId: string, cwd: string): Promise<ProviderSessionHistory>

    /** Clear provider-specific session state (e.g., opencode session ID) */
    clearSessionId?(): void

    /** Release provider-owned resources such as ACP subprocesses. */
    destroy?(): Promise<void>
}
