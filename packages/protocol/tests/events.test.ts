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
        outputRef: {
            outputId: 'output-1', sizeBytes: 14,
            sha256: 'a'.repeat(64), mediaType: 'application/json',
        },
    },
} as const

describe('event wire schemas', () => {
    it('parses visible user messages', () => {
        expect(parseConversationEvent({
            kind: 'user_message',
            text: 'continue',
            actorId: 'user-1',
            attachments: [{
                id: 'attachment-1', filename: 'notes.txt', mimeType: 'text/plain', sizeBytes: 12,
            }],
            meta: { source: 'live' },
        })).toMatchObject({ kind: 'user_message', text: 'continue', attachments: [{ filename: 'notes.txt' }] })
    })

    it('parses a versioned structured event and narrows its variant', () => {
        const parsed = parseSessionEventEnvelope(envelope)
        expect(parsed.event.kind).toBe('tool')
        if (parsed.event.kind === 'tool') expect(parsed.event.toolCallId).toBe('tool-1')
    })

    it('rejects unsupported versions and eager tool output bodies', () => {
        expect(() => parseSessionEventEnvelope({ ...envelope, schemaVersion: 2 })).toThrow()
        expect(() => parseSessionEventEnvelope({
            ...envelope,
            event: { ...envelope.event, output: { exitCode: 0 } },
        })).toThrow()
    })
})
