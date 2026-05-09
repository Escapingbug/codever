import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentToolUseEvent } from '@/providers/types'
import type { ConversationEvent, SemanticMeta } from './semantic'

export interface ProviderAdapterContext {
    sessionId: string
    turnId: string
    provider: string
    sourcePhase?: SemanticMeta['sourcePhase']
}

export interface ProviderSemanticAdapter {
    readonly provider: string
    toConversationEvents(event: AgentEvent, context: ProviderAdapterContext): ConversationEvent[]
}

export function createProviderSemanticAdapter(provider: string): ProviderSemanticAdapter {
    const normalized = provider.toLowerCase()
    if (normalized.includes('acp') || normalized.includes('opencode') || normalized.includes('codebuddy') || normalized.includes('agent')) {
        return new AcpProviderSemanticAdapter(provider)
    }
    return new DefaultProviderSemanticAdapter(provider)
}

export class DefaultProviderSemanticAdapter implements ProviderSemanticAdapter {
    readonly provider: string
    private seq = 0

    constructor(provider: string) {
        this.provider = provider
    }

    toConversationEvents(event: AgentEvent, context: ProviderAdapterContext): ConversationEvent[] {
        const meta = this.meta(event, context)

        switch (event.kind) {
            case 'text':
                return [{ kind: 'assistant_text_delta', meta, text: event.text }]

            case 'tool_use':
                return [{
                    kind: 'tool',
                    meta,
                    phase: this.toolUsePhase(event),
                    toolCallId: event.toolUseId ?? meta.id,
                    toolName: event.toolName,
                    category: categorizeTool(event.toolName, event.toolKind),
                    input: event.input,
                }]

            case 'tool_result':
                return [{
                    kind: 'tool',
                    meta,
                    phase: event.isError ? 'failed' : 'completed',
                    toolCallId: event.toolUseId ?? meta.id,
                    toolName: event.toolName ?? 'tool',
                    category: categorizeTool(event.toolName),
                    output: event.output,
                    isError: event.isError,
                }]

            case 'result':
                return [{
                    kind: 'turn_finished',
                    meta,
                    status: event.status === 'max_turns' ? 'max_turns' : event.status,
                    summary: event.summary,
                }]

            case 'session_init':
                return [{
                    kind: 'provider_raw',
                    meta,
                    providerEvent: event,
                }]

            case 'commands_update':
                return [{
                    kind: 'command_result',
                    meta,
                    command: 'available_commands_update',
                    output: event.commands,
                }]

            case 'raw':
            default:
                return [{ kind: 'provider_raw', meta, providerEvent: event }]
        }
    }

    reset(): void {
        this.seq = 0
    }

    private meta(event: AgentEvent, context: ProviderAdapterContext): SemanticMeta {
        const seq = ++this.seq
        return {
            id: stableEventId(event, context, seq),
            sessionId: context.sessionId,
            turnId: context.turnId,
            provider: context.provider,
            seq,
            timestamp: Date.now(),
            sourcePhase: context.sourcePhase ?? 'live',
            raw: event,
        }
    }

    private toolUsePhase(event: AgentToolUseEvent): 'started' | 'updated' {
        return event.status === 'running' || event.isInputComplete ? 'updated' : 'started'
    }
}

export class AcpProviderSemanticAdapter extends DefaultProviderSemanticAdapter {
    toConversationEvents(event: AgentEvent, context: ProviderAdapterContext): ConversationEvent[] {
        if (event.kind !== 'raw') {
            return super.toConversationEvents(event, context)
        }

        const raw = asRecord(event.rawMessage)
        const sessionUpdate = typeof raw?.sessionUpdate === 'string' ? raw.sessionUpdate : undefined
        if (!sessionUpdate || !raw) {
            return super.toConversationEvents(event, context)
        }

        const rawRecord: Record<string, unknown> = raw
        const meta = this.rawMeta(event, context, sessionUpdate)

        switch (sessionUpdate) {
            case 'current_mode_update': {
                const mode = pickString(rawRecord, ['currentMode', 'mode', 'name', 'id']) ?? 'unknown'
                return [{ kind: 'mode_change', meta, mode }]
            }

            case 'plan': {
                const options = extractDecisionOptions(rawRecord)
                if (options.length > 0) {
                    return [{
                        kind: 'decision_request',
                        meta,
                        decisionId: pickString(rawRecord, ['planId', 'id']) ?? meta.id,
                        title: pickString(rawRecord, ['title', 'name']) ?? 'Plan approval',
                        body: pickString(rawRecord, ['content', 'text', 'description']),
                        options,
                        required: true,
                        source: 'provider',
                    }]
                }
                return [{ kind: 'command_result', meta, command: 'plan', output: rawRecord }]
            }

            case 'config_option_update':
            case 'session_info_update':
            case 'usage_update':
                return [{ kind: 'command_result', meta, command: sessionUpdate, output: rawRecord }]

            default:
                return super.toConversationEvents(event, context)
        }
    }

    private rawMeta(event: AgentEvent, context: ProviderAdapterContext, sessionUpdate: string): SemanticMeta {
        const baseEvents = super.toConversationEvents(event, context)
        const meta = baseEvents[0]?.meta
        return {
            ...(meta ?? {
                id: `${context.turnId}:raw:${sessionUpdate}:${randomUUID()}`,
                sessionId: context.sessionId,
                turnId: context.turnId,
                provider: context.provider,
                seq: 0,
                timestamp: Date.now(),
                sourcePhase: context.sourcePhase ?? 'live',
            }),
            id: `${context.turnId}:acp:${sessionUpdate}:${meta?.seq ?? randomUUID()}`,
        }
    }
}

function stableEventId(event: AgentEvent, context: ProviderAdapterContext, seq: number): string {
    if (event.kind === 'tool_use' && event.toolUseId) {
        return `${context.turnId}:tool:${event.toolUseId}:${event.status ?? 'pending'}:${seq}`
    }
    if (event.kind === 'tool_result' && event.toolUseId) {
        return `${context.turnId}:tool:${event.toolUseId}:result`
    }
    if (event.kind === 'result') {
        return `${context.turnId}:result`
    }
    return `${context.turnId}:${event.kind}:${seq}:${randomUUID()}`
}

type ToolCategory = NonNullable<Extract<ConversationEvent, { kind: 'tool' }>['category']>

function categorizeTool(toolName?: string, toolKind?: string): ToolCategory {
    const normalizedKind = toolKind?.toLowerCase()
    if (normalizedKind === 'read' || normalizedKind === 'edit' || normalizedKind === 'write' || normalizedKind === 'execute' || normalizedKind === 'search') {
        return normalizedKind
    }

    const normalizedName = toolName?.toLowerCase() ?? ''
    if (['read', 'glob'].includes(normalizedName)) return 'read'
    if (['edit'].includes(normalizedName)) return 'edit'
    if (['write'].includes(normalizedName)) return 'write'
    if (['bash', 'shell', 'terminal'].includes(normalizedName)) return 'execute'
    if (['grep', 'websearch', 'webfetch'].includes(normalizedName)) return 'search'
    if (['agent', 'task'].includes(normalizedName)) return 'agent'
    return 'unknown'
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = record[key]
        if (typeof value === 'string') return value
        if (value && typeof value === 'object') {
            const nested = value as Record<string, unknown>
            if (typeof nested.id === 'string') return nested.id
            if (typeof nested.name === 'string') return nested.name
        }
    }
    return undefined
}

function extractDecisionOptions(record: Record<string, unknown>): Array<{ id: string; label: string; value: unknown; style?: 'default' | 'primary' | 'danger' }> {
    const rawOptions = Array.isArray(record.options)
        ? record.options
        : Array.isArray(record.choices)
            ? record.choices
            : []

    return rawOptions.flatMap((option, index) => {
        if (typeof option === 'string') {
            return [{ id: option, label: option, value: option, style: index === 0 ? 'primary' as const : 'default' as const }]
        }
        const obj = asRecord(option)
        if (!obj) return []
        const id = pickString(obj, ['id', 'value', 'name']) ?? `option-${index}`
        const label = pickString(obj, ['label', 'title', 'name', 'value']) ?? id
        const styleValue = pickString(obj, ['style'])
        const style = styleValue === 'primary' || styleValue === 'danger' ? styleValue : 'default'
        return [{ id, label, value: obj.value ?? id, style }]
    })
}
