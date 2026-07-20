import type {
  AttachmentDownloadChunkDto, AttachmentUploadDto, CancelSessionDto, CodeverSession,
  ClientGatewayRequestPayload, ClientGatewayResponseFrame, CreateProjectDto, CreateSessionDto,
  Gateway, InventorySnapshot, JsonValue, MutationReceiptDto, PatchSessionConfigDto, Project,
  ProviderSessionListDto, RenameSessionDto, SendMessageDto, SessionAttachmentDto, SessionAttachmentListDto,
  SessionEventEnvelope,
  ToolOutputDownloadChunkDto, ToolOutputListDto, ToolOutputListItemDto,
} from '@codever/protocol'
import type { InjectionKey } from 'vue'
import {
  MatrixGatewayClient, type ExecutionRootApprovalRequest,
} from './matrixGatewayClient'
import { NativeMatrixClient, type MatrixPublicSession } from './nativeMatrixClient'

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

export class CodeverApiError extends Error {
  constructor(message: string, public readonly code?: string) { super(message); this.name = 'CodeverApiError' }
}

export class CodeverApi {
  private matrix?: MatrixGatewayClient
  private readonly projectGateways = new Map<string, string>()
  private readonly sessionGateways = new Map<string, string>()
  private readonly inventories = new Map<string, InventorySnapshot>()
  private readonly mediaUploads = new Map<string, AttachmentUploadDto>()
  private readonly connectionSubscribers = new Set<(state: ConnectionState) => void>()
  private connectionStateValue: ConnectionState = 'disconnected'

  constructor(private readonly native: NativeMatrixClient) {}
  get connectionState(): ConnectionState { return this.connectionStateValue }

  connect(input: {
    session: MatrixPublicSession
    controlRoomId: string
    executionAccount: string
    executionKeyId: string
  }): void {
    this.matrix ??= new MatrixGatewayClient({
      transport: this.native, ...input,
      onSecurityError: message => console.error(`[matrix-security] ${message}`),
    })
    this.matrix.start()
    this.setConnectionState('connected')
  }

  async suspendTransport(): Promise<void> {
    await this.native.close()
    this.setConnectionState('disconnected')
  }

  async disconnect(): Promise<void> {
    this.matrix?.close()
    this.matrix = undefined
    await this.native.close()
    this.setConnectionState('disconnected')
  }
  markSuspended(): void { if (this.connectionStateValue === 'connected') this.setConnectionState('reconnecting') }
  resume(): void { if (this.matrix) this.setConnectionState('connected') }
  subscribeConnection(subscriber: (state: ConnectionState) => void): () => void {
    this.connectionSubscribers.add(subscriber); subscriber(this.connectionStateValue)
    return () => this.connectionSubscribers.delete(subscriber)
  }
  rememberRoute(gatewayId: string, projectId?: string, sessionId?: string): void {
    if (projectId) this.projectGateways.set(projectId, gatewayId)
    if (sessionId) this.sessionGateways.set(sessionId, gatewayId)
  }

  async listGateways(): Promise<Gateway[]> { return this.requireMatrix().listGateways() }
  async listProjects(gatewayId: string): Promise<Project[]> { return (await this.inventory(gatewayId)).projects }
  async createProject(gatewayId: string, input: CreateProjectDto): Promise<Project> {
    const payload = this.completed(await this.request(gatewayId, { kind: 'project.create', input })) as { project: Project }
    await this.inventory(gatewayId)
    return payload.project
  }
  async listSessions(projectId: string): Promise<CodeverSession[]> {
    const inventory = await this.inventory(this.requireProjectGateway(projectId))
    return inventory.sessions.filter(session => session.projectId === projectId)
  }
  async discoverProviderSessions(projectId: string, provider: string): Promise<ProviderSessionListDto> {
    return this.completed(await this.request(this.requireProjectGateway(projectId), {
      kind: 'provider.sessions.list', projectId, provider,
    })) as ProviderSessionListDto
  }
  async getSession(sessionId: string): Promise<CodeverSession> {
    const inventory = await this.inventory(this.requireSessionGateway(sessionId))
    const session = inventory.sessions.find(value => value.id === sessionId)
    if (!session) throw new CodeverApiError(`Unknown session ${sessionId}`, 'session_not_found')
    return session
  }
  async getSessionEvents(sessionId: string, options: { after?: number; before?: number; limit?: number } = {}) {
    return this.completed(await this.request(this.requireSessionGateway(sessionId), {
      kind: 'events.list', sessionId, ...options,
    })) as { events: SessionEventEnvelope[]; nextAfter: number | null; previousBefore: number | null }
  }
  async createSession(projectId: string, input: CreateSessionDto): Promise<CodeverSession> {
    const gatewayId = this.requireProjectGateway(projectId)
    const payload = this.completed(await this.request(gatewayId, { kind: 'session.create', projectId, input })) as { session: CodeverSession }
    await this.inventory(gatewayId)
    return payload.session
  }
  async sendMessage(sessionId: string, input: SendMessageDto): Promise<MutationReceiptDto> {
    return this.completed(await this.request(this.requireSessionGateway(sessionId), {
      kind: 'session.message', sessionId, input,
    })) as MutationReceiptDto
  }
  async cancelSession(sessionId: string, input: CancelSessionDto = {}): Promise<MutationReceiptDto> {
    return this.completed(await this.request(this.requireSessionGateway(sessionId), {
      kind: 'session.cancel', sessionId, input,
    })) as MutationReceiptDto
  }
  async setSessionArchived(sessionId: string, archived: boolean): Promise<MutationReceiptDto> {
    return this.completed(await this.request(this.requireSessionGateway(sessionId), {
      kind: 'session.archive.set', sessionId, archived,
    })) as MutationReceiptDto
  }
  async renameSession(sessionId: string, input: RenameSessionDto): Promise<MutationReceiptDto> {
    return this.completed(await this.request(this.requireSessionGateway(sessionId), {
      kind: 'session.rename', sessionId, input,
    })) as MutationReceiptDto
  }
  async patchSessionConfig(sessionId: string, input: PatchSessionConfigDto): Promise<MutationReceiptDto> {
    return this.completed(await this.request(this.requireSessionGateway(sessionId), {
      kind: 'session.config.patch', sessionId, input,
    })) as MutationReceiptDto
  }
  async resolveDecision(sessionId: string, decisionId: string, value: JsonValue): Promise<MutationReceiptDto> {
    return this.completed(await this.request(this.requireSessionGateway(sessionId), {
      kind: 'decision.respond', sessionId, decisionId, input: { value },
    })) as MutationReceiptDto
  }
  async trustExecutionRoot(gatewayId: string, input: {
    ownerId: string
    label: string
    publicKey: { kty: 'EC'; crv: 'P-256'; alg: 'ES256'; use: 'sig'; kid: string; x: string; y: string }
  }): Promise<MutationReceiptDto> {
    return this.completed(await this.request(gatewayId, { kind: 'execution.root.trust', ...input })) as MutationReceiptDto
  }
  async revokeExecutionRoot(gatewayId: string, keyId: string): Promise<MutationReceiptDto> {
    return this.completed(await this.request(gatewayId, { kind: 'execution.root.revoke', keyId })) as MutationReceiptDto
  }
  requestExecutionApproval(input: Omit<ExecutionRootApprovalRequest, 'requestId' | 'senderDevice'>): Promise<string> {
    return this.requireMatrix().requestExecutionApproval(input)
  }
  subscribeExecutionApprovals(subscriber: (requests: ExecutionRootApprovalRequest[]) => void): () => void {
    return this.requireMatrix().subscribeExecutionApprovals(subscriber)
  }
  async approveExecutionRoot(input: ExecutionRootApprovalRequest): Promise<MutationReceiptDto> {
    return this.completed(await this.requireMatrix().approveExecutionRoot(input)) as MutationReceiptDto
  }
  subscribeSession(sessionId: string, subscriber: (event: SessionEventEnvelope) => void): () => void {
    return this.requireMatrix().subscribeSession(sessionId, subscriber)
  }

  async uploadAttachment(sessionId: string, file: File, options: {
    signal?: AbortSignal; onProgress?: (received: number, size: number) => void
    onStage?: (stage: 'uploading' | 'storing') => void; onUpload?: (upload: AttachmentUploadDto) => void
    resume?: AttachmentUploadDto
  } = {}): Promise<AttachmentUploadDto> {
    if (options.resume) {
      await this.native.cancelEncryptedMediaUpload(options.resume.attachmentId).catch(() => undefined)
      this.mediaUploads.delete(options.resume.attachmentId)
    }
    const staged = await this.native.beginEncryptedMediaUpload(file.size)
    let upload: AttachmentUploadDto = {
      attachmentId: staged.uploadId, sessionId, filename: file.name,
      mimeType: file.type || 'application/octet-stream', sizeBytes: file.size,
      receivedBytes: 0, status: 'uploading',
    }
    this.mediaUploads.set(staged.uploadId, upload)
    options.onUpload?.(upload)
    options.onStage?.('uploading')
    try {
      while (upload.receivedBytes < file.size) {
        assertNotAborted(options.signal)
        const bytes = new Uint8Array(await file.slice(
          upload.receivedBytes,
          upload.receivedBytes + 256 * 1024,
        ).arrayBuffer())
        const next = await this.native.appendEncryptedMediaUpload(
          upload.attachmentId,
          upload.receivedBytes,
          bytes,
        )
        upload = { ...upload, receivedBytes: next.receivedBytes }
        this.mediaUploads.set(upload.attachmentId, upload)
        options.onUpload?.(upload)
        options.onProgress?.(upload.receivedBytes, upload.sizeBytes)
      }
      assertNotAborted(options.signal)
      options.onStage?.('storing')
      const encryptedFile = await this.native.completeEncryptedMediaUpload(upload.attachmentId)
      this.mediaUploads.delete(upload.attachmentId)
      return this.completed(await this.request(this.requireSessionGateway(sessionId), {
        kind: 'attachment.media.import', sessionId, filename: file.name,
        mimeType: upload.mimeType, sizeBytes: file.size, encryptedFile,
      })) as AttachmentUploadDto
    } catch (error) {
      this.mediaUploads.delete(upload.attachmentId)
      await this.native.cancelEncryptedMediaUpload(upload.attachmentId).catch(() => undefined)
      throw error
    }
  }
  async cancelAttachment(sessionId: string, attachmentId: string): Promise<AttachmentUploadDto> {
    const upload = this.mediaUploads.get(attachmentId)
    if (!upload || upload.sessionId !== sessionId) throw new CodeverApiError('Unknown active upload')
    await this.native.cancelEncryptedMediaUpload(attachmentId)
    this.mediaUploads.delete(attachmentId)
    return { ...upload, status: 'cancelled' }
  }
  async listSessionAttachments(sessionId: string): Promise<SessionAttachmentListDto> {
    return this.completed(await this.request(this.requireSessionGateway(sessionId), {
      kind: 'attachment.list', sessionId,
    })) as SessionAttachmentListDto
  }
  async deleteSessionAttachments(sessionId: string, attachmentIds: string[]): Promise<MutationReceiptDto> {
    return this.completed(await this.request(this.requireSessionGateway(sessionId), {
      kind: 'attachment.delete', sessionId, attachmentIds,
    })) as MutationReceiptDto
  }
  async exportSessionFile(sessionId: string, path: string): Promise<SessionAttachmentDto> {
    return this.completed(await this.request(this.requireSessionGateway(sessionId), {
      kind: 'file.export', sessionId, path,
    })) as SessionAttachmentDto
  }
  async downloadAttachment(attachment: SessionAttachmentDto): Promise<Blob> {
    const chunks: BlobPart[] = []; let offset = 0
    while (true) {
      const chunk = this.completed(await this.request(this.requireSessionGateway(attachment.sessionId), {
        kind: 'attachment.download', sessionId: attachment.sessionId,
        attachmentId: attachment.attachmentId, offset,
      })) as AttachmentDownloadChunkDto
      if (chunk.offset !== offset) throw new CodeverApiError('Attachment download returned an unexpected offset')
      chunks.push(decodeBase64(chunk.data))
      if (chunk.nextOffset === null) break
      offset = chunk.nextOffset
    }
    return new Blob(chunks, { type: attachment.mimeType })
  }
  async listToolOutputs(sessionId: string): Promise<ToolOutputListDto> {
    return this.completed(await this.request(this.requireSessionGateway(sessionId), {
      kind: 'tool.output.list', sessionId,
    })) as ToolOutputListDto
  }
  async deleteToolOutputs(sessionId: string, outputIds: string[]): Promise<MutationReceiptDto> {
    return this.completed(await this.request(this.requireSessionGateway(sessionId), {
      kind: 'tool.output.delete', sessionId, outputIds,
    })) as MutationReceiptDto
  }
  async clearToolOutputs(sessionId: string): Promise<MutationReceiptDto> {
    return this.completed(await this.request(this.requireSessionGateway(sessionId), {
      kind: 'tool.output.clear', sessionId,
    })) as MutationReceiptDto
  }
  async downloadToolOutput(output: ToolOutputListItemDto): Promise<Blob> {
    const chunks: BlobPart[] = []; let offset = 0
    while (true) {
      const chunk = this.completed(await this.request(this.requireSessionGateway(output.sessionId), {
        kind: 'tool.output.download', sessionId: output.sessionId, outputId: output.outputId, offset,
      })) as ToolOutputDownloadChunkDto
      if (chunk.offset !== offset) throw new CodeverApiError('Tool output download returned an unexpected offset')
      chunks.push(decodeBase64(chunk.data))
      if (chunk.nextOffset === null) break
      offset = chunk.nextOffset
    }
    return new Blob(chunks, { type: output.mediaType })
  }

  private async inventory(gatewayId: string): Promise<InventorySnapshot> {
    const response = this.completed(await this.request(gatewayId, { kind: 'inventory.get' })) as InventorySnapshot
    this.inventories.set(gatewayId, response)
    for (const project of response.projects) this.projectGateways.set(project.id, gatewayId)
    for (const session of response.sessions) this.sessionGateways.set(session.id, gatewayId)
    return response
  }
  private request(gatewayId: string, payload: ClientGatewayRequestPayload) { return this.requireMatrix().request(gatewayId, payload) }
  private requireMatrix(): MatrixGatewayClient {
    if (!this.matrix) throw new CodeverApiError('Secure Matrix synchronization is not connected', 'sync_unavailable')
    return this.matrix
  }
  private requireProjectGateway(id: string): string {
    const gateway = this.projectGateways.get(id); if (!gateway) throw new CodeverApiError('Refresh projects before opening this project')
    return gateway
  }
  private requireSessionGateway(id: string): string {
    const gateway = this.sessionGateways.get(id); if (!gateway) throw new CodeverApiError('Refresh sessions before opening this session')
    return gateway
  }
  private completed(response: ClientGatewayResponseFrame): unknown {
    if (response.status === 'completed') return response.payload
    if (response.status === 'failed') throw new CodeverApiError(response.error.message, response.error.code)
    throw new CodeverApiError('Gateway accepted the request but has not completed it')
  }
  private setConnectionState(state: ConnectionState): void {
    if (state === this.connectionStateValue) return
    this.connectionStateValue = state
    for (const subscriber of this.connectionSubscribers) subscriber(state)
  }
}

function assertNotAborted(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError') }
function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value); const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i); return bytes
}

export const codeverApiKey: InjectionKey<CodeverApi> = Symbol('codever-api')
