import type { ConversationEvent as WireConversationEvent, JsonValue, ToolContent } from '@codever/protocol'
import type { ToolResultContentBlock } from '@/providers/types'
import type { ConversationEvent } from '@/runtime/semantic'
import type { GatewayConversationEvent, GatewayUserMessageEvent } from './events'

export function toWireConversationEvent(event: GatewayConversationEvent): WireConversationEvent | null {
    if (event.kind === 'user_message') {
        const attachments = inputAttachments(event.input)
        return {
            kind: 'user_message',
            text: inputText(event.input),
            ...(attachments.length ? { attachments } : {}),
            meta: { turnId: event.turnId, source: event.source ?? 'live' },
        }
    }
    if (event.kind === 'turn') {
        return event.phase === 'started'
            ? { kind: 'turn_started', meta: { turnId: event.turnId, source: 'live' } }
            : {
                kind: 'turn_finished',
                status: event.status ?? 'success',
                ...(event.summary ? { summary: event.summary } : {}),
                meta: { turnId: event.turnId, source: 'live' },
            }
    }
    if (event.kind === 'state') {
        return {
            kind: 'session_state',
            state: event.state,
            ...(event.reason ? { reason: event.reason } : {}),
            meta: { source: 'synthetic' },
        }
    }
    if (event.kind === 'error') {
        return {
            kind: 'status',
            level: 'error',
            message: `${event.code}: ${event.message}`,
            meta: { ...(event.turnId ? { turnId: event.turnId } : {}), source: 'synthetic' },
        }
    }
    if (event.kind === 'provider_session') {
        return {
            kind: 'provider_session',
            provider: event.provider,
            providerSessionId: event.providerSessionId,
            ...(event.isNewSession !== undefined ? { isNewSession: event.isNewSession } : {}),
            meta: { source: 'synthetic' },
        }
    }
    if (event.kind === 'settings') {
        return {
            kind: 'settings',
            ...(event.model ? { model: event.model } : {}),
            providerSettings: jsonObject(event.providerSettings),
            meta: { source: 'synthetic' },
        }
    }
    if (event.kind === 'decision') {
        if (event.phase === 'requested') {
            return {
                kind: 'decision_request',
                decisionId: event.decisionId,
                title: event.request.title,
                ...(event.request.details ? { body: event.request.details } : {}),
                options: event.request.options.map((option) => ({
                    id: option.id,
                    label: option.label,
                    value: jsonValue(option.value),
                })),
                required: true,
                source: event.request.type === 'permission' ? 'agent' : 'gateway',
                expiresAt: event.expiresAt,
                meta: {
                    ...(event.request.turnId ? { turnId: event.request.turnId } : {}),
                    source: 'live',
                },
            }
        }
        return {
            kind: 'decision_resolved',
            decisionId: event.decisionId,
            ...(event.optionId ? { optionId: event.optionId } : {}),
            value: jsonValue(event.value ?? event.phase),
            ...(event.responderId ? { resolvedBy: event.responderId } : {}),
            meta: {
                ...(event.request.turnId ? { turnId: event.request.turnId } : {}),
                source: 'live',
            },
        }
    }

    return providerEventToWire(event)
}

function providerEventToWire(event: ConversationEvent): WireConversationEvent | null {
    const meta = {
        turnId: event.meta.turnId,
        source: event.meta.sourcePhase === 'replay' ? 'replay' as const : 'live' as const,
    }
    switch (event.kind) {
        case 'turn_started':
            return { kind: 'turn_started', meta }
        case 'assistant_text_delta':
            return { kind: 'assistant_text_delta', text: event.text, meta }
        case 'tool':
            return {
                kind: 'tool',
                phase: event.phase,
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                ...(event.category ? { category: event.category } : {}),
                ...(event.input !== undefined ? { input: jsonValue(event.input) } : {}),
                ...(event.output !== undefined ? { output: jsonValue(event.output) } : {}),
                ...(event.isError !== undefined ? { isError: event.isError } : {}),
                ...(event.displayTitle !== undefined ? { displayTitle: event.displayTitle } : {}),
                ...(event.content ? { content: event.content.map((content) => wireToolContent(content, event.toolCallId)) } : {}),
                meta,
            }
        case 'decision_request':
            return {
                kind: 'decision_request',
                decisionId: event.decisionId,
                title: event.title,
                ...(event.body ? { body: event.body } : {}),
                options: event.options.map((option) => ({
                    id: option.id,
                    label: option.label,
                    value: jsonValue(option.value),
                    ...(option.style ? { style: option.style } : {}),
                })),
                required: event.required,
                source: event.source === 'provider' ? 'agent' : 'gateway',
                meta,
            }
        case 'mode_change':
            return { kind: 'mode_change', mode: event.mode, meta }
        case 'command_result':
            return { kind: 'command_result', command: event.command, output: jsonValue(event.output), meta }
        case 'turn_finished':
            return {
                kind: 'turn_finished',
                status: event.status,
                ...(event.summary ? { summary: event.summary } : {}),
                meta,
            }
        case 'provider_raw':
            return null
    }
}

function inputText(input: GatewayUserMessageEvent['input']): string {
    if (typeof input === 'string') return input
    return input.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
}

function inputAttachments(input: GatewayUserMessageEvent['input']) {
    if (typeof input === 'string') return []
    return input.parts.flatMap(part => {
        if (part.type === 'text' || !part.source?.startsWith('attachment:')) return []
        return [{
            id: part.source.slice('attachment:'.length),
            filename: part.filename ?? 'attachment',
            mimeType: part.mimeType,
            sizeBytes: part.sizeBytes ?? 0,
        }]
    }).filter(attachment => attachment.sizeBytes > 0)
}

function wireToolContent(content: ToolResultContentBlock, fallbackTerminalId: string): ToolContent {
    if (content.type === 'content') {
        return { type: 'text', text: content.text ?? '', mimeType: content.contentType }
    }
    if (content.type === 'diff') {
        return {
            type: 'diff',
            path: content.path ?? '',
            oldText: content.oldText ?? '',
            newText: content.newText ?? '',
        }
    }
    return { type: 'terminal', terminalId: content.terminalId ?? fallbackTerminalId }
}

function jsonObject(value: Record<string, unknown>): Record<string, JsonValue> {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]))
}

function jsonValue(value: unknown, seen = new WeakSet<object>()): JsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
    if (typeof value === 'bigint') return value.toString()
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return null
    if (value instanceof Date) return value.toISOString()
    if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
    if (typeof value !== 'object') return String(value)
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    if (Array.isArray(value)) return value.map((item) => jsonValue(item, seen))
    const result: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) result[key] = jsonValue(item, seen)
    return result
}
