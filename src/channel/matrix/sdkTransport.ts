import { createHash } from 'node:crypto'
import { canonicalJson } from '@codever/protocol'
import { toArrayBuffer } from '@codever/security'
import type { EventType, MatrixClient, MatrixEvent, Room, RoomEvent } from 'matrix-js-sdk'
import type { RoomMessageEventContent } from 'matrix-js-sdk/lib/@types/events.js'
import type {
    MatrixDownloadMediaRequest,
    MatrixIncomingEvent,
    MatrixSendEventRequest,
    MatrixSendEventResult,
    MatrixTransport,
    MatrixUploadMediaRequest,
    MatrixUploadMediaResult,
} from './transport'

const MATRIX_ROOM_TIMELINE = 'Room.timeline' as RoomEvent.Timeline
const MATRIX_ROOM_MESSAGE = 'm.room.message' as EventType.RoomMessage

export interface MatrixSdkTransportOptions {
    client: MatrixClient
    onIncomingEvent(event: MatrixIncomingEvent): Promise<void>
    onLog?: (message: string) => void
}

/**
 * Real matrix-js-sdk boundary used by the desktop/standalone gateway.
 *
 * The caller must create the MatrixClient with a stable userId/deviceId/access
 * token and call initRustCrypto with a persistent crypto store before start().
 * This class refuses clear-text rooms and never calls the raw homeserver send
 * endpoint, so matrix-js-sdk performs Megolm encryption before transport.
 */
export class MatrixSdkTransport implements MatrixTransport {
    private started = false

    constructor(private readonly options: MatrixSdkTransportOptions) {}

    async start(initialSyncLimit = 20): Promise<void> {
        if (this.started) return
        if (!this.options.client.getCrypto()) {
            throw new Error('Matrix Rust crypto must be initialized before the gateway starts')
        }
        this.started = true
        this.options.client.on(MATRIX_ROOM_TIMELINE, this.onTimeline)
        await this.options.client.startClient({ initialSyncLimit })
    }

    stop(): void {
        if (!this.started) return
        this.started = false
        this.options.client.off(MATRIX_ROOM_TIMELINE, this.onTimeline)
        this.options.client.stopClient()
    }

    async sendEncryptedRoomEvent(request: MatrixSendEventRequest): Promise<MatrixSendEventResult> {
        if (!this.options.client.isRoomEncrypted(request.roomId)) {
            throw new Error(`Refusing to send agent data to unencrypted Matrix room ${request.roomId}`)
        }
        const response = await this.options.client.sendEvent(
            request.roomId,
            MATRIX_ROOM_MESSAGE,
            request.content as RoomMessageEventContent,
            request.transactionId,
        )
        return { eventId: response.event_id }
    }

    async setTyping(roomId: string, typing: boolean, timeoutMs = 30_000): Promise<void> {
        await this.options.client.sendTyping(roomId, typing, timeoutMs)
    }

    async uploadEncryptedMedia(request: MatrixUploadMediaRequest): Promise<MatrixUploadMediaResult> {
        const response = await this.options.client.uploadContent(
            new Blob([toArrayBuffer(request.ciphertext)], { type: 'application/octet-stream' }),
            {
                type: 'application/octet-stream',
                includeFilename: false,
            },
        )
        return { url: response.content_uri }
    }

    async downloadEncryptedMedia(request: MatrixDownloadMediaRequest): Promise<Uint8Array> {
        return downloadMatrixMedia(this.options.client, request)
    }

    private readonly onTimeline = (
        event: MatrixEvent,
        room: Room | undefined,
        toStartOfTimeline: boolean | undefined,
        removed: boolean,
        data: { liveEvent?: boolean },
    ): void => {
        if (!this.started || !room || removed || toStartOfTimeline || !data.liveEvent) return
        void this.forwardTimelineEvent(event).catch(error => {
            this.options.onLog?.(`[matrix-sdk] incoming event rejected: ${formatError(error)}`)
        })
    }

    private async forwardTimelineEvent(event: MatrixEvent): Promise<void> {
        if (event.getType() !== 'm.room.message') return
        const roomId = event.getRoomId()
        const eventId = event.getId()
        const sender = event.getSender()
        if (!roomId || !eventId || !sender) return

        const encrypted = event.isEncrypted()
        if (encrypted && event.isDecryptionFailure()) {
            throw new Error(`Could not decrypt Matrix event ${eventId}`)
        }

        const senderKey = event.getSenderKey()
        const wireContent = asRecord(event.event.content)
        const clearContent = asRecord(event.getContent())
        await this.options.onIncomingEvent({
            roomId,
            eventId,
            eventType: event.getType(),
            sender,
            // The Curve25519 sender key is cryptographically bound to the
            // decryption session. It is a stronger local pin than an untrusted
            // clear-text Matrix device_id claim.
            ...(senderKey ? { senderDeviceId: `curve25519:${senderKey}` } : {}),
            encrypted,
            ...(encrypted && wireContent
                ? { encryptedPayloadFingerprint: fingerprintEncryptedContent(wireContent) }
                : {}),
            content: clearContent ?? {},
            originServerTs: event.getTs(),
        })
    }
}

export async function downloadMatrixMedia(
    client: MatrixClient,
    request: MatrixDownloadMediaRequest,
): Promise<Uint8Array> {
    if (!/^mxc:\/\/[^/\s]+\/[^/\s]+$/u.test(request.url)) {
        throw new Error('Refusing to download a non-Matrix media URL')
    }
    const url = client.mxcUrlToHttp(
        request.url,
        undefined,
        undefined,
        undefined,
        false,
        false,
        true,
    )
    if (!url) throw new Error('Matrix media URL could not be resolved')
    const accessToken = client.getAccessToken()
    if (!accessToken) throw new Error('Matrix access token is unavailable for media download')
    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        redirect: 'error',
    })
    if (!response.ok) {
        throw new Error(`Matrix media download failed with HTTP ${response.status}`)
    }
    const declaredSize = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredSize) && declaredSize > request.maxBytes) {
        throw new Error(`Matrix media exceeds the ${request.maxBytes} byte download limit`)
    }
    return readBoundedResponse(response, request.maxBytes)
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
    if (!response.body) {
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (bytes.byteLength > maxBytes) {
            throw new Error(`Matrix media exceeds the ${maxBytes} byte download limit`)
        }
        return bytes
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maxBytes) {
            await reader.cancel()
            throw new Error(`Matrix media exceeds the ${maxBytes} byte download limit`)
        }
        chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    return bytes
}

function fingerprintEncryptedContent(content: Record<string, unknown>): string {
    return createHash('sha256')
        .update('codever-matrix-wire:v1\0')
        .update(canonicalJson(content))
        .digest('hex')
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
