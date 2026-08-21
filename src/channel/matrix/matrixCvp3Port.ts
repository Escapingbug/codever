import { createHash, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import {
  MAX_CODEVER_ATTACHMENT_BYTES,
  attachmentSchema,
  type CodeverAttachment,
  type Cvp3Event,
  type Cvp3SessionProjection,
  type JsonValue,
} from '@codever/protocol'
import { encryptMedia, sha256 } from '@codever/security'
import type {
  ChannelEditContext,
  ChannelMessage,
  ChannelPort,
  ChannelSendResult,
  DecisionRequest,
  DecisionResponse,
  SessionStatus,
} from '@/bridge/channelPort'
import type { MatrixGatewayRoomConfig } from '@/gateway/matrix/config'
import type { GatewayCvp3ContentLayer } from '@/gateway/matrix/cvp3Content'
import type { MatrixTransport } from './transport'

export interface MatrixCvp3PortOptions {
  contentLayer: GatewayCvp3ContentLayer
  transport: MatrixTransport
  room: MatrixGatewayRoomConfig
  workspaceId: string
  projectId: string
  sessionId: string
  threadRootEventId: string
  projection(): Cvp3SessionProjection
  now?: () => number
  onLog?: (message: string) => void
  onStatusChange?: (status: SessionStatus) => void
}

interface PendingDecision {
  allowedValues: Set<string>
  fallbackValue: string
  resolve(value: DecisionResponse): void
}

/**
 * CVP/3 Matrix projection for one Codever session thread.
 *
 * Logical IDs and versions are authoritative. Matrix relations are emitted as
 * indexing hints, but a missing or rewritten physical relation cannot change
 * the Codever projection.
 */
export class MatrixCvp3Port implements ChannelPort {
  readonly fileReferenceHints = false
  private readonly pendingDecisions = new Map<string, PendingDecision>()
  private readonly operationIds = new WeakMap<ChannelMessage, string>()
  private readonly attachmentUploads = new Map<string, Promise<CodeverAttachment[]>>()
  private readonly physicalEventIds = new Map<string, string>()
  private readonly messageVersions = new Map<string, number>()
  private causationCommandId: string | null = null

  constructor(private readonly options: MatrixCvp3PortOptions) {}

  setCausationCommandId(commandId: string | null): void {
    this.causationCommandId = commandId
  }

  async send(message: ChannelMessage): Promise<ChannelSendResult> {
    const messageOptions = readMessageOptions(message.replyMarkup)
    const messageId = messageOptions.idempotencyKey ?? this.operationIdFor(message)
    const presentation = message.presentation ?? messageOptions.ui
    const attachments = await this.uploadAttachments(messageId, message.attachments)
    const parts = splitMessage(message)
    for (const [index, part] of parts.entries()) {
      const logicalPartId = partId(messageId, index, parts.length)
      const result = await this.sendAssistantEvent({
        eventId: eventId('assistant', logicalPartId, 1),
        messageId,
        messageVersion: this.nextMessageVersion(logicalPartId),
        body: normalizedBody(part),
        format: part.format === 'markdown' ? 'markdown' : 'plain',
        final: true,
        ...(parts.length > 1 ? { partIndex: index, partCount: parts.length } : {}),
        ...(index === 0 && presentation !== undefined
          ? { ui: presentation as JsonValue }
          : {}),
        ...(index === 0 && attachments.length > 0 ? { attachments } : {}),
      })
      this.physicalEventIds.set(logicalPartId, result.eventId)
      if (index === 0) this.physicalEventIds.set(messageId, result.eventId)
      this.options.onLog?.(
        `[cvp3/matrix] assistant ${logicalPartId} v${this.messageVersions.get(logicalPartId)} delivered`,
      )
    }
    return { messageId }
  }

  async edit(
    messageIdInput: string | number,
    message: ChannelMessage,
    context: ChannelEditContext = {},
  ): Promise<void> {
    const messageId = String(messageIdInput)
    const messageOptions = readMessageOptions(message.replyMarkup)
    const presentation = message.presentation ?? messageOptions.ui
    const attachments = await this.uploadAttachments(messageId, message.attachments)
    const parts = splitMessage(message)
    if (parts.length > 1 && context.progressive && !context.terminal) return

    for (const [index, part] of parts.entries()) {
      const logicalPartId = partId(messageId, index, parts.length)
      const version = this.nextMessageVersion(logicalPartId)
      const physicalTarget = this.physicalEventIds.get(logicalPartId)
        ?? (index === 0 ? this.physicalEventIds.get(messageId) : undefined)
      const result = await this.sendAssistantEvent({
        eventId: eventId('assistant', logicalPartId, version),
        messageId,
        messageVersion: version,
        body: normalizedBody(part),
        format: part.format === 'markdown' ? 'markdown' : 'plain',
        final: context.terminal ?? !context.progressive,
        ...(parts.length > 1 ? { partIndex: index, partCount: parts.length } : {}),
        ...(index === 0 && presentation !== undefined
          ? { ui: presentation as JsonValue }
          : {}),
        ...(index === 0 && attachments.length > 0 ? { attachments } : {}),
      }, physicalTarget ? {
        rel_type: 'm.replace',
        event_id: physicalTarget,
      } : undefined)
      this.physicalEventIds.set(logicalPartId, result.eventId)
      if (index === 0) this.physicalEventIds.set(messageId, result.eventId)
      this.options.onLog?.(`[cvp3/matrix] assistant ${logicalPartId} v${version} delivered`)
    }
  }

  requestDecision(request: DecisionRequest): Promise<DecisionResponse> {
    const requestId = randomUUID()
    const fallbackValue = request.type === 'permission' ? 'deny' : ''
    const promise = new Promise<DecisionResponse>(resolve => {
      this.pendingDecisions.set(requestId, {
        allowedValues: new Set(request.options.map(option => option.value)),
        fallbackValue,
        resolve,
      })
    })
    const event: Cvp3Event = {
      ...this.baseEvent(eventId('decision', requestId, 1)),
      payload: {
        type: 'decision.requested',
        requestId,
        title: request.title,
        ...(request.details ? { details: request.details } : {}),
        options: request.options,
        projection: this.options.projection(),
      },
    }
    void this.options.contentLayer.sendEvent(
      this.options.room,
      event,
      this.options.transport,
      { relation: threadRelation(this.options.threadRootEventId) },
    ).catch(error => {
      this.options.onLog?.(`[cvp3/matrix] decision delivery failed: ${formatError(error)}`)
      this.resolveDecision(requestId, fallbackValue)
    })
    return promise
  }

  resolveDecision(requestId: string, value: string): boolean {
    const pending = this.pendingDecisions.get(requestId)
    if (!pending || !pending.allowedValues.has(value)) return false
    this.pendingDecisions.delete(requestId)
    pending.resolve({ value })
    return true
  }

  notifyStatus(status: SessionStatus): void {
    try {
      this.options.onStatusChange?.(status)
    } catch (error) {
      this.options.onLog?.(`[cvp3/matrix] status observer failed: ${formatError(error)}`)
    }
  }

  sendChatAction(action: string): void {
    if (!this.options.transport.setTyping) return
    const typing = action === 'typing' || action === 'uploading'
    void this.options.transport.setTyping(
      this.options.room.roomId,
      typing,
      typing ? 30_000 : undefined,
    ).catch(error => {
      this.options.onLog?.(`[cvp3/matrix] typing update failed: ${formatError(error)}`)
    })
  }

  close(): void {
    for (const [requestId, pending] of this.pendingDecisions) {
      this.pendingDecisions.delete(requestId)
      pending.resolve({ value: pending.fallbackValue })
    }
  }

  private sendAssistantEvent(
    payload: Omit<
      Extract<Cvp3Event['payload'], { type: 'assistant.message' }>,
      'type' | 'projection'
    > & { eventId: string },
    relation?: Record<string, unknown>,
  ) {
    const { eventId: logicalEventId, ...eventPayload } = payload
    return this.options.contentLayer.sendEvent(
      this.options.room,
      {
        ...this.baseEvent(logicalEventId),
        payload: {
          type: 'assistant.message',
          ...eventPayload,
          projection: this.options.projection(),
        },
      },
      this.options.transport,
      { relation: relation ?? threadRelation(this.options.threadRootEventId) },
    )
  }

  private baseEvent(logicalEventId: string): Omit<Cvp3Event, 'payload'> {
    return {
      kind: 'codever.event',
      version: 3,
      eventId: logicalEventId,
      workspaceId: this.options.workspaceId,
      projectId: this.options.projectId,
      sessionId: this.options.sessionId,
      occurredAt: (this.options.now ?? Date.now)(),
      ...(this.causationCommandId
        ? { causationCommandId: this.causationCommandId }
        : {}),
    }
  }

  private nextMessageVersion(messageId: string): number {
    const next = (this.messageVersions.get(messageId) ?? 0) + 1
    this.messageVersions.set(messageId, next)
    return next
  }

  private operationIdFor(message: ChannelMessage): string {
    const current = this.operationIds.get(message)
    if (current) return current
    const created = randomUUID()
    this.operationIds.set(message, created)
    return created
  }

  private uploadAttachments(
    operationId: string,
    attachments: ChannelMessage['attachments'],
  ): Promise<CodeverAttachment[]> {
    if (!attachments?.length) return Promise.resolve([])
    const current = this.attachmentUploads.get(operationId)
    if (current) return current
    const upload = Promise.all(attachments.map(async attachment => {
      const uploadMedia = this.options.transport.uploadEncryptedMedia
      if (!uploadMedia) throw new Error('Matrix transport does not support encrypted media upload')
      const metadata = await stat(attachment.path)
      if (!metadata.isFile()) throw new Error(`Attachment is not a regular file: ${attachment.path}`)
      if (metadata.size > MAX_CODEVER_ATTACHMENT_BYTES) {
        throw new Error(`Attachment exceeds the ${MAX_CODEVER_ATTACHMENT_BYTES} byte limit`)
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
        media: { url: uploaded.url, ...encrypted.descriptor },
      })
    }))
    this.attachmentUploads.set(operationId, upload)
    void upload.catch(() => this.attachmentUploads.delete(operationId))
    return upload
  }
}

function splitMessage(message: ChannelMessage): ChannelMessage[] {
  const body = normalizedBody(message)
  if (new TextEncoder().encode(body).byteLength <= MESSAGE_PART_BYTES) return [message]
  const chunks: string[] = []
  let current = ''
  let bytes = 0
  for (const character of body) {
    const size = new TextEncoder().encode(character).byteLength
    if (bytes > 0 && bytes + size > MESSAGE_PART_BYTES) {
      chunks.push(current)
      current = ''
      bytes = 0
    }
    current += character
    bytes += size
  }
  if (current || chunks.length === 0) chunks.push(current)
  return chunks.map(text => ({
    text,
    format: message.format === 'html' ? 'plain' : message.format,
  }))
}

const MESSAGE_PART_BYTES = 8 * 1024

function normalizedBody(message: ChannelMessage): string {
  return message.format === 'html' ? htmlToPlainText(message.text) : message.text
}

function readMessageOptions(value: unknown): { idempotencyKey?: string; ui?: unknown } {
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

function threadRelation(rootEventId: string): Record<string, unknown> {
  return {
    rel_type: 'm.thread',
    event_id: rootEventId,
    is_falling_back: true,
    'm.in_reply_to': { event_id: rootEventId },
  }
}

function partId(messageId: string, index: number, count: number): string {
  return count === 1 ? messageId : `${messageId}.part.${index}`
}

function eventId(kind: string, logicalId: string, version: number): string {
  return createHash('sha256')
    .update(`codever-v3:${kind}\0${logicalId}\0${version}`)
    .digest('base64url')
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
