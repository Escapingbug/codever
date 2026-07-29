import { createHash, randomUUID } from 'node:crypto'
import type {
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
    onLog?: (message: string) => void
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
    private readonly pendingDecisions = new Map<string, PendingDecision>()
    private readonly messageOperationIds = new WeakMap<ChannelMessage, string>()

    constructor(private readonly options: MatrixPortOptions) {}

    async send(message: ChannelMessage): Promise<ChannelSendResult> {
        const messageOptions = readMatrixMessageOptions(message.replyMarkup)
        const operationId = messageOptions.idempotencyKey ?? this.operationIdFor(message)
        const content = buildMessageContent(message, {
            kind: 'message',
            operation_id: operationId,
            ...this.sessionMetadata(),
            format: message.format,
            ...(message.attachments?.length ? {
                attachments: message.attachments.map(attachment => ({
                    type: attachment.type,
                    filename: attachment.filename,
                    // Local paths are intentionally not placed in the standard
                    // Matrix fallback body. A real transport uploads them as
                    // encrypted media before materializing the final event.
                    local_path: attachment.path,
                })),
            } : {}),
            ...(messageOptions.ui === undefined ? {} : { ui: messageOptions.ui }),
        })
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
        const operationId = messageOptions.idempotencyKey ?? this.operationIdFor(message)
        const replacement = buildMessageContent(message, {
            kind: 'message',
            operation_id: operationId,
            ...this.sessionMetadata(),
            format: message.format,
            replaces_event_id: targetEventId,
            ...(messageOptions.ui === undefined ? {} : { ui: messageOptions.ui }),
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
            content: {
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
            },
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
        if (status.state !== 'querying') return

        const body = [
            'Agent started working...',
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
            state: status.state,
            provider: status.provider,
            cwd: status.cwd,
            model: status.model,
        }
        const content: MatrixRoomMessageContent = {
            msgtype: 'm.notice',
            body,
            [CODEVER_MATRIX_EXTENSION]: extension,
        }
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

    private sessionMetadata(): { session_id?: string } {
        const sessionId = this.options.sessionId
        return sessionId ? { session_id: sessionId } : {}
    }

    private operationIdFor(message: ChannelMessage): string {
        const existing = this.messageOperationIds.get(message)
        if (existing) return existing
        const operationId = randomUUID()
        this.messageOperationIds.set(message, operationId)
        return operationId
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


function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
