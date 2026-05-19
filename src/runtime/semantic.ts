import type { AgentEvent, ToolResultContentBlock } from '@/providers/types'

export type SessionInputSource = 'channel' | 'scheduler' | 'mcp' | 'system'

export interface RichTextPart {
    type: 'text'
    text: string
}

export interface RichMediaPart {
    type: 'image' | 'audio'
    mimeType: string
    data: string
    source?: string
    filename?: string
    sizeBytes?: number
}

export interface RichFilePart {
    type: 'file'
    path: string
    filename: string
    mimeType: string
    sizeBytes: number
    source?: string
}

export type RichUserInputPart = RichTextPart | RichMediaPart | RichFilePart

export interface RichUserInput {
    parts: RichUserInputPart[]
}

export function textUserInput(text: string): RichUserInput {
    return text.trim().length > 0 ? { parts: [{ type: 'text', text }] } : { parts: [] }
}

export function normalizeUserInput(input: string | RichUserInput): RichUserInput {
    return typeof input === 'string' ? textUserInput(input) : input
}

export interface SemanticMeta {
    id: string
    sessionId: string
    turnId: string
    provider: string
    seq: number
    timestamp: number
    sourcePhase: 'live' | 'replay' | 'tailDrain' | 'synthetic'
    raw?: unknown
}

export interface UserRef {
    id?: string
    username?: string
    displayName?: string
}

export type SessionInput =
    | {
        kind: 'user_message'
        text: string
        richInput?: RichUserInput
        source: SessionInputSource
        user?: UserRef
    }
    | {
        kind: 'command'
        name: string
        args?: string
        source: SessionInputSource
        user?: UserRef
    }
    | {
        kind: 'decision_response'
        decisionId: string
        value: unknown
        source: SessionInputSource
        user?: UserRef
    }
    | {
        kind: 'cancel'
        reason: 'user' | 'timeout' | 'replace' | 'new'
        source: SessionInputSource
        user?: UserRef
    }
    | {
        kind: 'scheduled_message'
        text: string
        context?: string
        source: 'scheduler'
    }

export interface DecisionOption {
    id: string
    label: string
    value: unknown
    style?: 'default' | 'primary' | 'danger'
}

export type ConversationEvent =
    | {
        kind: 'turn_started'
        meta: SemanticMeta
    }
    | {
        kind: 'assistant_text_delta'
        meta: SemanticMeta
        text: string
    }
    | {
        kind: 'tool'
        meta: SemanticMeta
        phase: 'started' | 'updated' | 'completed' | 'failed'
        toolCallId: string
        toolName: string
        category?: 'read' | 'edit' | 'write' | 'execute' | 'search' | 'agent' | 'unknown'
        input?: unknown
        output?: unknown
        isError?: boolean
        /** Display title for the tool call (e.g. file path, descriptive title).
         *  Separate from canonical toolName to avoid confusing path-like titles with tool names. */
        displayTitle?: string
        /** Structured content blocks from ACP (text, diff, terminal) */
        content?: Array<ToolResultContentBlock>
    }
    | {
        kind: 'decision_request'
        meta: SemanticMeta
        decisionId: string
        title: string
        body?: string
        options: DecisionOption[]
        required: boolean
        source: 'provider' | 'codever'
    }
    | {
        kind: 'mode_change'
        meta: SemanticMeta
        mode: string
        options?: DecisionOption[]
    }
    | {
        kind: 'command_result'
        meta: SemanticMeta
        command: string
        output: unknown
    }
    | {
        kind: 'turn_finished'
        meta: SemanticMeta
        status: 'success' | 'error' | 'cancelled' | 'max_turns'
        summary?: string
    }
    | {
        kind: 'provider_raw'
        meta: SemanticMeta
        providerEvent: AgentEvent
    }

export class ConversationJournal {
    private events: ConversationEvent[] = []
    private ids = new Set<string>()

    append(event: ConversationEvent): boolean {
        if (this.ids.has(event.meta.id)) return false
        this.ids.add(event.meta.id)
        this.events.push(event)
        return true
    }

    list(): ConversationEvent[] {
        return [...this.events]
    }

    clear(): void {
        this.events = []
        this.ids.clear()
    }
}
