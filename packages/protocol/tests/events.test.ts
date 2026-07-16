import { describe, expect, it } from 'vitest'
import { parseConversationEvent, parseSessionEventEnvelope } from '../src/index'

const envelope = {
    schemaVersion: 1,
    gatewayId: 'gateway-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    seq: 9,
    eventId: 'event-9',
    timestamp: '2026-07-16T10:00:00.000Z',
    event: {
        kind: 'tool',
        meta: { turnId: 'turn-1', source: 'live' },
        phase: 'completed',
        toolCallId: 'tool-1',
        toolName: 'shell',
        category: 'execute',
        input: { command: 'npm test' },
        output: { exitCode: 0 },
        content: [{ type: 'terminal', terminalId: 'terminal-1', text: 'ok' }],
    },
} as const

describe('event wire schemas', () => {
    it('parses visible user messages', () => {
        expect(parseConversationEvent({
            kind: 'user_message',
            text: 'continue',
            actorId: 'user-1',
            attachmentIds: ['attachment-1'],
            meta: { source: 'live' },
        })).toMatchObject({ kind: 'user_message', text: 'continue' })
    })

    it('parses a versioned structured event and narrows its variant', () => {
        const parsed = parseSessionEventEnvelope(envelope)
        expect(parsed.event.kind).toBe('tool')
        if (parsed.event.kind === 'tool') expect(parsed.event.toolCallId).toBe('tool-1')
    })

    it('rejects unsupported versions and non-JSON provider objects', () => {
        expect(() => parseSessionEventEnvelope({ ...envelope, schemaVersion: 2 })).toThrow()
        expect(() => parseSessionEventEnvelope({
            ...envelope,
            event: { ...envelope.event, output: { callback: () => undefined } },
        })).toThrow()
    })
})
