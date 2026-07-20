import type { SessionEventEnvelope } from '@codever/protocol'

/** Leaves room for the response frame and Matrix encryption envelope. */
export const MATRIX_EVENT_PAGE_BUDGET_BYTES = 24 * 1024

export function selectWireEventPage(
    all: SessionEventEnvelope[],
    options: { after?: number; before?: number; limit: number; budgetBytes?: number },
): SessionEventEnvelope[] {
    const before = options.before
    const after = options.after
    const eligible = before !== undefined
        ? all.filter(event => event.seq < before)
        : after !== undefined
            ? all.filter(event => event.seq > after)
            : all
    const source = after !== undefined ? eligible : [...eligible].reverse()
    const selected: SessionEventEnvelope[] = []
    const budget = options.budgetBytes ?? MATRIX_EVENT_PAGE_BUDGET_BYTES
    for (const event of source) {
        if (selected.length >= options.limit) break
        const candidate = after !== undefined ? [...selected, event] : [event, ...selected]
        if (serializedBytes(candidate) > budget) {
            if (!selected.length) {
                throw new Error(`Conversation event ${event.eventId} exceeds the Matrix response budget`)
            }
            break
        }
        if (after !== undefined) selected.push(event)
        else selected.unshift(event)
    }
    return selected
}

export function serializedBytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
}
