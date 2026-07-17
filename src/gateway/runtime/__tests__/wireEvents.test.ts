import { describe, expect, it } from 'vitest'
import { parseConversationEvent } from '@codever/protocol'
import type { GatewayConversationEvent } from '../events'
import { toWireConversationEvent } from '../wireEvents'

describe('toWireConversationEvent', () => {
    it('converts user, state, and decision events into browser-safe protocol events', () => {
        const events: GatewayConversationEvent[] = [
            { kind: 'user_message', turnId: 'turn-1', input: 'Run tests' },
            { kind: 'state', previousState: 'idle', state: 'querying' },
            {
                kind: 'decision',
                phase: 'requested',
                decisionId: 'decision-1',
                request: {
                    type: 'permission',
                    title: 'Allow shell?',
                    options: [{ id: 'allow', label: 'Allow', value: 'allow' }],
                    turnId: 'turn-1',
                },
                expiresAt: '2026-07-16T10:00:00.000Z',
            },
        ]

        const wire = events.map((event) => parseConversationEvent(toWireConversationEvent(event)))
        expect(wire.map((event) => event.kind)).toEqual(['user_message', 'session_state', 'decision_request'])
    })

    it('drops provider_raw and sanitizes non-JSON command output', () => {
        const raw: GatewayConversationEvent = {
            kind: 'provider_raw',
            meta: {
                id: 'event-raw', sessionId: 'session-1', turnId: 'turn-1', provider: 'test',
                seq: 1, timestamp: 1, sourcePhase: 'live',
            },
            providerEvent: { kind: 'raw', providerName: 'test', rawMessage: { internal: true } },
        }
        const command: GatewayConversationEvent = {
            kind: 'command_result',
            meta: {
                id: 'event-command', sessionId: 'session-1', turnId: 'turn-1', provider: 'test',
                seq: 2, timestamp: 2, sourcePhase: 'live',
            },
            command: 'inspect',
            output: { count: 1n, callback: () => undefined },
        }

        expect(toWireConversationEvent(raw)).toBeNull()
        expect(parseConversationEvent(toWireConversationEvent(command))).toMatchObject({
            kind: 'command_result',
            output: { count: '1', callback: null },
        })
    })

    it('projects uploaded files as user-visible attachment metadata without duplicating filenames in text', () => {
        const wire = parseConversationEvent(toWireConversationEvent({
            kind: 'user_message',
            turnId: 'turn-attachment',
            input: {
                parts: [
                    { type: 'text', text: 'Inspect this file' },
                    {
                        type: 'file', path: 'D:/cache/attachment.bin', filename: 'report.pdf',
                        mimeType: 'application/pdf', sizeBytes: 2048, source: 'attachment:attachment-1',
                    },
                ],
            },
        }))
        expect(wire).toMatchObject({
            kind: 'user_message',
            text: 'Inspect this file',
            attachments: [{ id: 'attachment-1', filename: 'report.pdf', sizeBytes: 2048 }],
        })
    })
})
