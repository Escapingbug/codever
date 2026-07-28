import type {
    MatrixSendEventRequest,
    MatrixSendEventResult,
    MatrixTransport,
} from './transport'

/**
 * Test/development transport. It models homeserver transaction-id
 * idempotency without implementing any Matrix network or crypto behavior.
 */
export class InMemoryMatrixTransport implements MatrixTransport {
    readonly attempts: MatrixSendEventRequest[] = []
    readonly delivered: Array<MatrixSendEventRequest & { eventId: string }> = []
    readonly typing: Array<{ roomId: string; typing: boolean; timeoutMs?: number }> = []
    private readonly transactionResults = new Map<string, MatrixSendEventResult>()
    private nextEventId = 0

    async sendEncryptedRoomEvent(request: MatrixSendEventRequest): Promise<MatrixSendEventResult> {
        this.attempts.push(structuredClone(request))
        const transactionKey = `${request.roomId}\u0000${request.transactionId}`
        const existing = this.transactionResults.get(transactionKey)
        if (existing) return existing

        const result = { eventId: `$memory-${++this.nextEventId}` }
        this.transactionResults.set(transactionKey, result)
        this.delivered.push({ ...structuredClone(request), eventId: result.eventId })
        return result
    }

    async setTyping(roomId: string, typing: boolean, timeoutMs?: number): Promise<void> {
        this.typing.push({ roomId, typing, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
    }
}
