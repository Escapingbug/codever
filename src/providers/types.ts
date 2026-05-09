export interface AgentTextEvent {
    kind: 'text'
    text: string
}

export interface AgentToolUseEvent {
    kind: 'tool_use'
    toolName: string
    toolUseId?: string
    input: unknown
    /** Tool execution status: pending (queued), running (executing) */
    status?: 'pending' | 'running'
    /** Original raw input as received from the provider (stringified JSON or raw object) */
    rawInput?: string
    /** Whether the tool input has been fully received (false during progressive streaming) */
    isInputComplete?: boolean
    /** ACP tool kind classification: read, edit, execute, search, etc. */
    toolKind?: string
    /** File locations referenced by this tool call */
    locations?: Array<{ path: string; line?: number }>
    /** Extended thinking signature for tool use in reasoning mode */
    thoughtSignature?: string | null
}

export interface AgentToolResultEvent {
    kind: 'tool_result'
    toolUseId?: string
    output: string
    isError: boolean
    /** Tool name carried with the result (avoids needing a separate lookup map) */
    toolName?: string
    /** Preserved raw structured output (exitCode, stdout, etc.) before stringification */
    structuredOutput?: unknown
    /** Structured content blocks from ACP (text, diff, terminal) */
    content?: Array<ToolResultContentBlock>
}

export type ToolResultContentBlock =
    | { type: 'content'; contentType: string; text?: string }
    | { type: 'diff'; path?: string; oldText?: string; newText?: string }
    | { type: 'terminal'; terminalId?: string }

export interface AgentSessionInitEvent {
    kind: 'session_init'
    sessionId?: string
    model?: string
    cwd?: string
    /** True when a stale conversationId could not be recovered and a brand-new
     *  session was created instead of resuming the old one. */
    isNewSession?: boolean
}

export interface AgentResultEvent {
    kind: 'result'
    status: 'success' | 'error' | 'max_turns'
    summary?: string
    tokenCount?: number
    costUsd?: number
    durationMs?: number
}

export interface AgentRawEvent {
    kind: 'raw'
    providerName: string
    rawMessage: unknown
}

export interface ProviderCommand {
    name: string
    description: string
    inputHint: string | null
}

export interface AgentCommandsUpdateEvent {
    kind: 'commands_update'
    commands: ProviderCommand[]
}

export type AgentEvent =
    | AgentTextEvent
    | AgentToolUseEvent
    | AgentToolResultEvent
    | AgentSessionInitEvent
    | AgentResultEvent
    | AgentRawEvent
    | AgentCommandsUpdateEvent
