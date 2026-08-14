import type {
    MatrixDownloadMediaRequest,
    MatrixApplicationStateEventRequest,
    MatrixSendEventRequest,
    MatrixSendEventResult,
    MatrixTransport,
    MatrixUploadMediaRequest,
    MatrixUploadMediaResult,
} from './transport'

/**
 * Test/development transport. It models homeserver transaction-id
 * idempotency without implementing any Matrix network or crypto behavior.
 */
export class InMemoryMatrixTransport implements MatrixTransport {
    readonly attempts: MatrixSendEventRequest[] = []
    readonly delivered: Array<MatrixSendEventRequest & { eventId: string }> = []
    readonly typing: Array<{ roomId: string; typing: boolean; timeoutMs?: number }> = []
    readonly media = new Map<string, Uint8Array>()
    readonly state = new Map<string, MatrixApplicationStateEventRequest & { eventId: string }>()
    private readonly transactionResults = new Map<string, MatrixSendEventResult>()
    private nextEventId = 0
    private nextMediaId = 0

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

    async setApplicationRoomState(
        request: MatrixApplicationStateEventRequest,
    ): Promise<MatrixSendEventResult> {
        const eventId = `$memory-state-${++this.nextEventId}`
        this.state.set(
            JSON.stringify([request.roomId, request.eventType, request.stateKey]),
            { ...structuredClone(request), eventId },
        )
        return { eventId }
    }

    async uploadEncryptedMedia(request: MatrixUploadMediaRequest): Promise<MatrixUploadMediaResult> {
        const url = `mxc://memory.local/${++this.nextMediaId}`
        this.media.set(url, request.ciphertext.slice())
        return { url }
    }

    async downloadEncryptedMedia(request: MatrixDownloadMediaRequest): Promise<Uint8Array> {
        const ciphertext = this.media.get(request.url)
        if (!ciphertext) throw new Error(`Unknown in-memory Matrix media ${request.url}`)
        if (ciphertext.byteLength > request.maxBytes) {
            throw new Error(`Matrix media exceeds the ${request.maxBytes} byte download limit`)
        }
        return ciphertext.slice()
    }
}
