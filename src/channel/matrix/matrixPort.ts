import { createHash, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import {
    MAX_CODEVER_ATTACHMENT_BYTES,
    attachmentSchema,
    type CodeverAttachment,
} from '@codever/protocol'
import { encryptMedia, sha256 } from '@codever/security'
import type {
    AgentActivityPhase,
    ChannelMessage,
    ChannelPort,
    ChannelSendResult,
    DecisionRequest,
    DecisionResponse,
    SessionStatus,
} from '@/bridge/channelPort'
import type { MatrixRoomMessageContent, MatrixTransport } from './transport'

export const CODEVER_MATRIX_EXTENSION = 'io.codever' as const
export const CODEVER_MATRIX_PROTOCOL_VERSION = 1 as const

export interface MatrixPortOptions {
    transport: MatrixTransport
    roomId: string
    gatewayId: string
    /**
     * Immutable first-party app-session identity for this port. A Matrix room
     * can carry several Codever sessions, but every TopicSession owns its own
     * port so delayed output can never be attributed to whichever session a
     * client happens to be viewing.
     */
    sessionId?: string
    /** Matrix event ID of the immutable session_root that owns this thread. */
    threadRootEventId?: string
    onLog?: (message: string) => void
    /** Observe every runtime status transition, including non-visible ones. */
    onStatusChange?: (status: SessionStatus) => void
}

export interface MatrixMessageOptions {
    /**
     * A durable semantic operation ID supplied by the caller. Reusing it
     * produces the same Matrix transaction ID and therefore the same event.
     */
    idempotencyKey?: string
    ui?: unknown
}

interface PendingDecision {
    allowedValues: Set<string>
    fallbackValue: string
    resolve(response: DecisionResponse): void
}

export class MatrixPort implements ChannelPort {
    readonly fileReferenceHints = false
    private readonly pendingDecisions = new Map<string, PendingDecision>()
    private readonly messageOperationIds = new WeakMap<ChannelMessage, string>()
    private readonly attachmentUploads = new Map<string, Promise<CodeverAttachment[]>>()

    constructor(private readonly options: MatrixPortOptions) {}

    setThreadRootEventId(eventId: string): void {
        if (!eventId) throw new Error('Matrix thread root event ID is required')
        if (
            this.options.threadRootEventId !== undefined
            && this.options.threadRootEventId !== eventId
        ) {
            throw new Error('Matrix thread root event ID is immutable')
        }
        this.options.threadRootEventId = eventId
    }

    async send(message: ChannelMessage): Promise<ChannelSendResult> {
        const messageOptions = readMatrixMessageOptions(message.replyMarkup)
        const presentation = message.presentation ?? messageOptions.ui
        const operationId = messageOptions.idempotencyKey ?? this.operationIdFor(message)
        const attachments = await this.uploadAttachments(operationId, message.attachments)
        const content = this.withThreadRelation(buildMessageContent(message, {
            kind: 'message',
            operation_id: operationId,
            ...this.sessionMetadata(),
            format: message.format,
            ...(attachments.length ? { attachments } : {}),
            ...(presentation === undefined ? {} : { ui: presentation }),
        }))
        const transactionId = this.transactionId('send', operationId)
        const result = await this.options.transport.sendEncryptedRoomEvent({
            roomId: this.options.roomId,
            eventType: 'm.room.message',
            content,
            transactionId,
        })
        return { messageId: result.eventId }
    }

    async edit(messageId: string | number, message: ChannelMessage): Promise<void> {
        const targetEventId = String(messageId)
        const messageOptions = readMatrixMessageOptions(message.replyMarkup)
        const presentation = message.presentation ?? messageOptions.ui
        const operationId = messageOptions.idempotencyKey ?? this.operationIdFor(message)
        const attachments = await this.uploadAttachments(operationId, message.attachments)
        const replacement = buildMessageContent(message, {
            kind: 'message',
            operation_id: operationId,
            ...this.sessionMetadata(),
            format: message.format,
            replaces_event_id: targetEventId,
            ...(attachments.length ? { attachments } : {}),
            ...(presentation === undefined ? {} : { ui: presentation }),
        })
        const content: MatrixRoomMessageContent = {
            ...replacement,
            body: `* ${replacement.body}`,
            'm.new_content': replacement,
            'm.relates_to': {
                rel_type: 'm.replace',
                event_id: targetEventId,
            },
        }

        await this.options.transport.sendEncryptedRoomEvent({
            roomId: this.options.roomId,
            eventType: 'm.room.message',
            content,
            transactionId: this.transactionId('edit', `${targetEventId}:${operationId}`),
        })
    }

    requestDecision(request: DecisionRequest): Promise<DecisionResponse> {
        const decisionId = randomUUID()
        const fallbackValue = request.type === 'permission' ? 'deny' : ''
        const allowedValues = new Set(request.options.map(option => option.value))
        const body = [
            request.title,
            request.details,
            request.options.map(option => `[${option.label}]`).join(' '),
        ].filter(Boolean).join('\n\n')

        const promise = new Promise<DecisionResponse>((resolve) => {
            this.pendingDecisions.set(decisionId, { allowedValues, fallbackValue, resolve })
        })

        void this.options.transport.sendEncryptedRoomEvent({
            roomId: this.options.roomId,
            eventType: 'm.room.message',
            content: this.withThreadRelation({
                msgtype: 'm.text',
                body,
                [CODEVER_MATRIX_EXTENSION]: {
                    version: CODEVER_MATRIX_PROTOCOL_VERSION,
                    kind: 'decision_request',
                    ...this.sessionMetadata(),
                    decision_id: decisionId,
                    decision_type: request.type,
                    title: request.title,
                    details: request.details,
                    options: request.options.map(option => ({ label: option.label, value: option.value })),
                },
            }),
            transactionId: this.transactionId('decision', decisionId),
        }).catch((error) => {
            this.options.onLog?.(`[matrix] decision delivery failed: ${formatError(error)}`)
            this.resolveDecision(decisionId, fallbackValue)
        })

        return promise
    }

    resolveDecision(decisionId: string, value: string): boolean {
        const pending = this.pendingDecisions.get(decisionId)
        if (!pending || !pending.allowedValues.has(value)) return false
        this.pendingDecisions.delete(decisionId)
        pending.resolve({ value })
        return true
    }

    notifyStatus(status: SessionStatus): void {
        try {
            this.options.onStatusChange?.(status)
        } catch (error) {
            this.options.onLog?.(`[matrix] status observer failed: ${formatError(error)}`)
        }

        const activity = status.activity ?? matrixActivityPhase(status.state)
        // Keep the established Matrix state vocabulary for older clients;
        // activity_phase carries the precise presentation lifecycle.
        const state = activity === 'starting' ? 'running' : matrixSessionStatus(status.state)
        const body = [
            matrixSessionStatusLabel(activity),
            `Provider: ${status.provider}`,
            `Cwd: ${status.cwd}`,
            ...(status.model ? [`Model: ${status.model}`] : []),
        ].join('\n')
        const operationId = randomUUID()
        const extension = {
            version: CODEVER_MATRIX_PROTOCOL_VERSION,
            kind: 'status',
            ...this.sessionMetadata(),
            operation_id: operationId,
            state,
            activity_phase: activity,
            provider: status.provider,
            cwd: status.cwd,
            model: status.model,
        }
        const content: MatrixRoomMessageContent = this.withThreadRelation({
            msgtype: 'm.notice',
            body,
            [CODEVER_MATRIX_EXTENSION]: extension,
        })
        if (status.editMessageId != null) {
            const targetEventId = String(status.editMessageId)
            content.body = `* ${body}`
            content['m.new_content'] = {
                msgtype: 'm.notice',
                body,
                [CODEVER_MATRIX_EXTENSION]: extension,
            }
            content['m.relates_to'] = { rel_type: 'm.replace', event_id: targetEventId }
        }

        void this.options.transport.sendEncryptedRoomEvent({
            roomId: this.options.roomId,
            eventType: 'm.room.message',
            content,
            transactionId: this.transactionId(
                'status',
                status.editMessageId == null ? operationId : `${status.editMessageId}:${operationId}`,
            ),
        }).catch(error => this.options.onLog?.(`[matrix] status delivery failed: ${formatError(error)}`))
    }

    sendChatAction(action: string): void {
        if (!this.options.transport.setTyping) return
        const typing = action === 'typing' || action === 'uploading'
        void this.options.transport.setTyping(this.options.roomId, typing, typing ? 30_000 : undefined)
            .catch(error => this.options.onLog?.(`[matrix] typing update failed: ${formatError(error)}`))
    }

    close(): void {
        for (const [decisionId, pending] of this.pendingDecisions) {
            this.pendingDecisions.delete(decisionId)
            pending.resolve({ value: pending.fallbackValue })
        }
    }

    private transactionId(kind: string, operationId: string): string {
        const digest = createHash('sha256')
            .update('codever-matrix-txn:v1\0')
            .update(this.options.gatewayId)
            .update('\0')
            .update(this.options.roomId)
            .update('\0')
            .update(kind)
            .update('\0')
            .update(operationId)
            .digest('hex')
        return `codever.${digest}`
    }

    private sessionMetadata(): { session_id?: string; thread_root_event_id?: string } {
        const sessionId = this.options.sessionId
        return sessionId ? {
            session_id: sessionId,
            ...(this.options.threadRootEventId
                ? { thread_root_event_id: this.options.threadRootEventId }
                : {}),
        } : {}
    }

    private withThreadRelation(content: MatrixRoomMessageContent): MatrixRoomMessageContent {
        const rootEventId = this.options.threadRootEventId
        if (!rootEventId || content['m.relates_to'] !== undefined) return content
        return {
            ...content,
            'm.relates_to': {
                rel_type: 'm.thread',
                event_id: rootEventId,
                is_falling_back: true,
                'm.in_reply_to': { event_id: rootEventId },
            },
        }
    }

    private operationIdFor(message: ChannelMessage): string {
        const existing = this.messageOperationIds.get(message)
        if (existing) return existing
        const operationId = randomUUID()
        this.messageOperationIds.set(message, operationId)
        return operationId
    }

    private uploadAttachments(
        operationId: string,
        attachments: ChannelMessage['attachments'],
    ): Promise<CodeverAttachment[]> {
        if (!attachments?.length) return Promise.resolve([])
        const existing = this.attachmentUploads.get(operationId)
        if (existing) return existing
        const upload = Promise.all(attachments.map(async attachment => {
            const uploadMedia = this.options.transport.uploadEncryptedMedia
            if (!uploadMedia) {
                throw new Error('Matrix transport does not support encrypted media upload')
            }
            const metadata = await stat(attachment.path)
            if (!metadata.isFile()) {
                throw new Error(`Attachment is not a regular file: ${attachment.path}`)
            }
            if (metadata.size > MAX_CODEVER_ATTACHMENT_BYTES) {
                throw new Error(
                    `Attachment exceeds the ${MAX_CODEVER_ATTACHMENT_BYTES} byte limit: ${attachment.path}`,
                )
            }
            const plaintext = new Uint8Array(await readFile(attachment.path))
            const encrypted = await encryptMedia(plaintext)
            const uploaded = await uploadMedia.call(this.options.transport, {
                ciphertext: encrypted.ciphertext,
            })
            return attachmentSchema.parse({
                id: randomUUID(),
                name: attachment.filename ?? attachment.path.split(/[\\/]/u).at(-1) ?? 'attachment',
                mimeType: attachmentMimeType(attachment.path),
                size: plaintext.byteLength,
                sha256: await sha256(plaintext),
                media: {
                    url: uploaded.url,
                    ...encrypted.descriptor,
                },
            })
        }))
        this.attachmentUploads.set(operationId, upload)
        void upload.catch(() => this.attachmentUploads.delete(operationId))
        return upload
    }
}

function matrixSessionStatus(
    state: SessionStatus['state'],
): 'idle' | 'running' | 'stopping' | 'failed' {
    switch (state) {
        case 'querying':
            return 'running'
        case 'canceling':
            return 'stopping'
        case 'dead':
            return 'failed'
        case 'idle':
            return 'idle'
    }
}

function matrixActivityPhase(state: SessionStatus['state']): AgentActivityPhase {
    switch (state) {
        case 'querying':
            return 'working'
        case 'canceling':
            return 'stopping'
        case 'dead':
            return 'failed'
        case 'idle':
            return 'idle'
    }
}

function matrixSessionStatusLabel(
    state: AgentActivityPhase,
): string {
    switch (state) {
        case 'starting':
            return 'Agent is starting...'
        case 'working':
            return 'Agent started working...'
        case 'stopping':
            return 'Stopping agent...'
        case 'failed':
            return 'Agent session stopped after an error.'
        case 'idle':
            return 'Agent is ready.'
    }
}

function buildMessageContent(
    message: ChannelMessage,
    extension: Record<string, unknown>,
): MatrixRoomMessageContent {
    const body = message.format === 'html' ? htmlToPlainText(message.text) : message.text
    return {
        msgtype: 'm.text',
        body,
        ...(message.format === 'html' ? {
            format: 'org.matrix.custom.html',
            formatted_body: message.text,
        } : {}),
        [CODEVER_MATRIX_EXTENSION]: {
            version: CODEVER_MATRIX_PROTOCOL_VERSION,
            ...extension,
        },
    }
}

function readMatrixMessageOptions(value: unknown): MatrixMessageOptions {
    if (!value || typeof value !== 'object') return {}
    const record = value as Record<string, unknown>
    return {
        ...(typeof record.idempotencyKey === 'string' ? { idempotencyKey: record.idempotencyKey } : {}),
        ...('ui' in record
            ? { ui: record.ui }
            : Object.keys(record).some(key => key !== 'idempotencyKey')
                ? { ui: value }
                : {}),
    }
}

function htmlToPlainText(value: string): string {
    return value
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p\s*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .trim()
}

function attachmentMimeType(path: string): string {
    switch (extname(path).toLowerCase()) {
        case '.png': return 'image/png'
        case '.jpg':
        case '.jpeg': return 'image/jpeg'
        case '.gif': return 'image/gif'
        case '.webp': return 'image/webp'
        case '.svg': return 'image/svg+xml'
        case '.pdf': return 'application/pdf'
        case '.json': return 'application/json'
        case '.md':
        case '.markdown': return 'text/markdown'
        case '.txt':
        case '.log': return 'text/plain'
        case '.csv': return 'text/csv'
        case '.mp3': return 'audio/mpeg'
        case '.wav': return 'audio/wav'
        case '.m4a': return 'audio/mp4'
        case '.mp4': return 'video/mp4'
        case '.zip': return 'application/zip'
        default: return 'application/octet-stream'
    }
}


function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
