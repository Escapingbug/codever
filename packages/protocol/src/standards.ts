import type { TaskState, TaskStatus } from '@a2a-js/sdk'
import { EventType, type AGUIEvent } from '@ag-ui/core'
import type { ConversationEvent, SessionEventEnvelope } from './events'

export interface A2ATaskTransition {
    contextId: string
    taskId: string
    status: TaskStatus
}

export interface StandardConversationEvent {
    codever: SessionEventEnvelope
    a2a?: A2ATaskTransition
    agui: AGUIEvent[]
}

export function toStandardConversationEvent(envelope: SessionEventEnvelope): StandardConversationEvent {
    return {
        codever: envelope,
        ...(toA2ATaskTransition(envelope) ? { a2a: toA2ATaskTransition(envelope) } : {}),
        agui: toAgUiEvents(envelope),
    }
}

export function toA2ATaskTransition(envelope: SessionEventEnvelope): A2ATaskTransition | undefined {
    const state = a2aState(envelope.event)
    if (!state) return undefined
    return {
        contextId: envelope.sessionId,
        taskId: envelope.event.meta?.turnId ?? envelope.eventId,
        status: { state, timestamp: envelope.timestamp },
    }
}

export function toAgUiEvents(envelope: SessionEventEnvelope): AGUIEvent[] {
    const event = envelope.event
    const timestamp = Date.parse(envelope.timestamp)
    const runId = event.meta?.turnId ?? envelope.eventId
    const common = { timestamp, rawEvent: event }
    switch (event.kind) {
        case 'user_message':
            return [
                { ...common, type: EventType.TEXT_MESSAGE_START, messageId: envelope.eventId, role: 'user' },
                { ...common, type: EventType.TEXT_MESSAGE_CONTENT, messageId: envelope.eventId, delta: event.text },
                { ...common, type: EventType.TEXT_MESSAGE_END, messageId: envelope.eventId },
            ]
        case 'turn_started':
            return [{ ...common, type: EventType.RUN_STARTED, threadId: envelope.sessionId, runId }]
        case 'assistant_text_delta':
            return [{
                ...common,
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: `assistant-${runId}`,
                delta: event.text,
            }]
        case 'tool':
            return toolEvents(event, envelope.eventId, common)
        case 'turn_finished':
            if (event.status === 'error') {
                return [{
                    ...common,
                    type: EventType.RUN_ERROR,
                    message: event.summary ?? 'Agent run failed',
                    code: 'provider_run_failed',
                }]
            }
            return [{
                ...common,
                type: EventType.RUN_FINISHED,
                threadId: envelope.sessionId,
                runId,
                result: { status: event.status, summary: event.summary },
                outcome: event.status === 'success' ? { type: 'success' } : undefined,
            }]
        case 'decision_request':
            return [{ ...common, type: EventType.CUSTOM, name: 'codever.decision.required', value: event }]
        case 'decision_resolved':
            return [{ ...common, type: EventType.CUSTOM, name: 'codever.decision.resolved', value: event }]
        case 'session_state':
            return [{ ...common, type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '/session/state', value: event.state }] }]
        default:
            return [{ ...common, type: EventType.CUSTOM, name: `codever.${event.kind}`, value: event }]
    }
}

function a2aState(event: ConversationEvent): TaskState | undefined {
    switch (event.kind) {
        case 'user_message': return 'submitted'
        case 'turn_started': return 'working'
        case 'decision_request': return 'input-required'
        case 'turn_finished':
            if (event.status === 'success') return 'completed'
            if (event.status === 'cancelled') return 'canceled'
            return 'failed'
        default: return undefined
    }
}

function toolEvents(
    event: Extract<ConversationEvent, { kind: 'tool' }>,
    eventId: string,
    common: { timestamp: number; rawEvent: ConversationEvent },
): AGUIEvent[] {
    if (event.phase === 'started') {
        return [{ ...common, type: EventType.TOOL_CALL_START, toolCallId: event.toolCallId, toolCallName: event.toolName }]
    }
    if (event.phase === 'updated') {
        return [{ ...common, type: EventType.CUSTOM, name: 'codever.tool.updated', value: event }]
    }
    return [
        { ...common, type: EventType.TOOL_CALL_END, toolCallId: event.toolCallId },
        {
            ...common,
            type: EventType.TOOL_CALL_RESULT,
            messageId: eventId,
            toolCallId: event.toolCallId,
            content: JSON.stringify(event.outputRef ?? null),
            role: 'tool',
        },
    ]
}
