/**
 * Narrow Matrix transport boundary.
 *
 * Implementations are responsible for Matrix login, sync, encryption, crypto
 * store persistence and media upload. The gateway only ever asks this boundary
 * to send encrypted room events.
 */
export interface MatrixTransport {
    sendEncryptedRoomEvent(request: MatrixSendEventRequest): Promise<MatrixSendEventResult>
    setTyping?(roomId: string, typing: boolean, timeoutMs?: number): Promise<void>
}

export interface MatrixSendEventRequest {
    roomId: string
    eventType: 'm.room.message'
    content: MatrixRoomMessageContent
    /**
     * Stable Matrix transaction ID. A transport must pass this value unchanged
     * to the homeserver so retrying an HTTP request remains idempotent.
     */
    transactionId: string
}

export interface MatrixSendEventResult {
    eventId: string
}

export interface MatrixRoomMessageContent extends Record<string, unknown> {
    msgtype: string
    body: string
}

/**
 * Decrypted event emitted by a transport after successful Matrix E2EE
 * verification. `senderDeviceId` must come from the cryptographic sender
 * information, never an untrusted clear-text content field.
 */
export interface MatrixIncomingEvent {
    roomId: string
    eventId: string
    eventType: string
    sender: string
    senderDeviceId?: string
    encrypted: boolean
    /**
     * Hash/fingerprint computed by the transport from the original encrypted
     * payload. It must never be copied from event content. It deliberately does
     * not depend on eventId, because a malicious homeserver can rewrite IDs
     * while replaying the same ciphertext.
     */
    encryptedPayloadFingerprint?: string
    content: Record<string, unknown>
    originServerTs?: number
}
