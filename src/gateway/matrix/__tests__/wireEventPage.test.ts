import type { SessionEventEnvelope } from '@codever/protocol'
import { describe, expect, it } from 'vitest'
import { MATRIX_EVENT_PAGE_BUDGET_BYTES, selectWireEventPage, serializedBytes } from '../wireEventPage'

describe('Matrix history response byte budget', () => {
    it('pages by serialized bytes instead of overflowing Matrix with a count-only page', () => {
        const events = Array.from({ length: 10 }, (_, index) => envelope(index + 1, 'x'.repeat(9_000)))

        const page = selectWireEventPage(events, { limit: 100 })

        expect(page.length).toBeGreaterThan(0)
        expect(page.length).toBeLessThan(events.length)
        expect(serializedBytes(page)).toBeLessThanOrEqual(MATRIX_EVENT_PAGE_BUDGET_BYTES)
        expect(page.at(-1)?.seq).toBe(10)
    })

    it('fails locally with an actionable response when one event cannot fit', () => {
        const events = [envelope(1, 'x'.repeat(MATRIX_EVENT_PAGE_BUDGET_BYTES + 1))]
        expect(() => selectWireEventPage(events, { limit: 100 })).toThrow('exceeds the Matrix response budget')
    })
})

function envelope(seq: number, text: string): SessionEventEnvelope {
    return {
        schemaVersion: 1, gatewayId: 'gateway-1', projectId: 'project-1', sessionId: 'session-1',
        seq, eventId: `event-${seq}`, timestamp: '2026-07-20T09:00:00.000Z',
        event: { kind: 'assistant_text_delta', text },
    }
}
