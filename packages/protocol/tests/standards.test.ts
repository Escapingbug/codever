import { EventType } from '@ag-ui/core'
import { describe, expect, it } from 'vitest'
import { toStandardConversationEvent, type SessionEventEnvelope } from '../src/index'

function envelope(event: SessionEventEnvelope['event']): SessionEventEnvelope {
    return {
        schemaVersion: 1,
        gatewayId: 'gateway_1',
        projectId: 'project_1',
        sessionId: 'session_1',
        seq: 1,
        eventId: 'event_1',
        timestamp: '2026-07-18T00:00:00.000Z',
        event,
    }
}

describe('standard event projection', () => {
    it('maps a turn to the A2A task lifecycle and AG-UI run lifecycle', () => {
        const started = toStandardConversationEvent(envelope({
            kind: 'turn_started', meta: { source: 'live', turnId: 'turn_1' },
        }))
        expect(started.a2a).toMatchObject({ contextId: 'session_1', taskId: 'turn_1', status: { state: 'working' } })
        expect(started.agui).toEqual([expect.objectContaining({
            type: EventType.RUN_STARTED, threadId: 'session_1', runId: 'turn_1',
        })])

        const finished = toStandardConversationEvent(envelope({
            kind: 'turn_finished', status: 'success', meta: { source: 'live', turnId: 'turn_1' },
        }))
        expect(finished.a2a?.status.state).toBe('completed')
        expect(finished.agui[0]).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: 'success' } })
    })

    it('projects user text as a complete AG-UI message without losing the Codever event', () => {
        const projected = toStandardConversationEvent(envelope({ kind: 'user_message', text: 'hello' }))
        expect(projected.codever.event).toMatchObject({ kind: 'user_message', text: 'hello' })
        expect(projected.agui.map(event => event.type)).toEqual([
            EventType.TEXT_MESSAGE_START,
            EventType.TEXT_MESSAGE_CONTENT,
            EventType.TEXT_MESSAGE_END,
        ])
    })
})
