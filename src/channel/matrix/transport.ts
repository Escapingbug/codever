import { CODEVER_MATRIX_APPLICATION_CONTROL_EVENT_TYPE } from '@codever/protocol'

/**
 * Narrow Matrix transport boundary.
 *
 * Implementations are responsible for Matrix login, sync, encryption, crypto
 * store persistence and media upload. Normal room messages use Matrix E2EE.
 * Application control events are already encrypted and signed by Codever and
 * have a separate, narrowly validated send path.
 */
export interface MatrixTransport {
    sendEncryptedRoomEvent(request: MatrixSendEventRequest): Promise<MatrixSendEventResult>
    sendApplicationControlEvent?(
        request: MatrixApplicationControlEventRequest,
    ): Promise<MatrixSendEventResult>
    setTyping?(roomId: string, typing: boolean, timeoutMs?: number): Promise<void>
    uploadEncryptedMedia?(request: MatrixUploadMediaRequest): Promise<MatrixUploadMediaResult>
    downloadEncryptedMedia?(request: MatrixDownloadMediaRequest): Promise<Uint8Array>
}

export interface MatrixApplicationControlEventRequest {
    roomId: string
    eventType: typeof CODEVER_MATRIX_APPLICATION_CONTROL_EVENT_TYPE
    content: MatrixRoomMessageContent
    /** Stable homeserver transaction ID for durable, idempotent retries. */
    transactionId: string
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

export interface MatrixUploadMediaRequest {
    ciphertext: Uint8Array
}

export interface MatrixUploadMediaResult {
    url: string
}

export interface MatrixDownloadMediaRequest {
    url: string
    maxBytes: number
}

export interface MatrixRoomMessageContent extends Record<string, unknown> {
    msgtype: string
    body: string
}

/**
 * Timeline event emitted by a transport. Normal room messages are decrypted
 * and verified with Matrix E2EE. Application control events intentionally
 * bypass Megolm and must contain a Codever secure envelope before use.
 * `senderDeviceId`, when present, must come from cryptographic sender
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
