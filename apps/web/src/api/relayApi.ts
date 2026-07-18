import type {
  CancelSessionDto,
  AttachmentDownloadChunkDto,
  AttachmentUploadDto,
  CodeverSession,
  ClientGatewayResponseFrame,
  ClientGatewayRequestPayload,
  CreateProjectDto,
  CreateSessionDto,
  Gateway,
  InventorySnapshot,
  JsonValue,
  MutationReceiptDto,
  PatchSessionConfigDto,
  Project,
  ProviderSessionListDto,
  SendMessageDto,
  SessionAttachmentDto,
  SessionAttachmentListDto,
  SessionEventEnvelope,
} from '@codever/protocol'
import type { InjectionKey } from 'vue'
import { DeviceSecureHandshake } from '../security/deviceSecureHandshake'
import { ClientDeviceCredentialStore } from '../security/deviceCredentialStore'
import { RelaySecureHandshake } from '../security/relaySecureHandshake'
import { ClientRelayCredentialStore, type ClientRelayCredential } from '../security/relayCredentialStore'
import type { SecretStore } from '../security/secretStore'
import { SecureRelayClient } from './secureRelayClient'
import { connectDurableNats, DurableSyncClient } from './durableSyncClient'
import { IndexedDbDurableResponseStore } from './durableResponseStore'
import { IndexedDbSessionEventStore } from './sessionEventStore'
import { pairGatewayOverNats } from './natsDevicePairingClient'
import type { NatsConnection } from '@nats-io/nats-core'
import { mergeSessionEvents } from '../sessionEvents'

export interface RelayApiOptions {
  baseUrl: string | (() => string | undefined)
  relayProfileId: string | (() => string | undefined)
  secrets: SecretStore
  fetch?: typeof globalThis.fetch
  onDisconnected?: () => void
  onConnectionState?: (state: RelayConnectionState) => void
  requestTimeoutMs?: number
  longRequestTimeoutMs?: number
}

export type RelayConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

export class RelayApiError extends Error {
  constructor(message: string, public readonly status = 0, public readonly code?: string) {
    super(message)
    this.name = 'RelayApiError'
  }
}

export class RelayApi {
  private readonly fetcher: typeof globalThis.fetch
  private readonly relayCredentials: ClientRelayCredentialStore
  private readonly deviceCredentials: ClientDeviceCredentialStore
  private relay?: SecureRelayClient
  private relayCredential?: ClientRelayCredential
  private nats?: NatsConnection
  private durable?: DurableSyncClient
  private readonly inventories = new Map<string, InventorySnapshot>()
  private readonly gateways = new Map<string, Gateway>()
  private readonly projectGateways = new Map<string, string>()
  private readonly sessionGateways = new Map<string, string>()
  private readonly eventSubscribers = new Map<string, Set<(event: SessionEventEnvelope) => void>>()
  private readonly connectionSubscribers = new Set<(state: RelayConnectionState) => void>()
  private readonly eventBacklog = new Map<string, SessionEventEnvelope[]>()
  private readonly durableIdempotencyGateways = new Set<string>()
  private connectionStateValue: RelayConnectionState = 'disconnected'
  private connectionGeneration = 0
  private recovery?: Promise<void>

  constructor(private readonly options: RelayApiOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.relayCredentials = new ClientRelayCredentialStore(options.secrets)
    this.deviceCredentials = new ClientDeviceCredentialStore(options.secrets)
  }

  get baseUrl(): string { return (source(this.options.baseUrl) ?? '').replace(/\/+$/, '') }
  get relayProfileId(): string { return source(this.options.relayProfileId) ?? '' }
  get connectionState(): RelayConnectionState { return this.connectionStateValue }

  subscribeConnection(subscriber: (state: RelayConnectionState) => void): () => void {
    this.connectionSubscribers.add(subscriber)
    subscriber(this.connectionStateValue)
    return () => this.connectionSubscribers.delete(subscriber)
  }

  rememberRoute(gatewayId: string, projectId?: string, sessionId?: string): void {
    if (projectId) this.projectGateways.set(projectId, gatewayId)
    if (sessionId) this.sessionGateways.set(sessionId, gatewayId)
  }

  async checkHealth(): Promise<void> {
    if (!this.baseUrl) throw new RelayApiError('No Relay profile is configured')
    try {
      const response = await this.fetcher(`${this.baseUrl}/health`, { headers: { Accept: 'application/json' } })
      if (!response.ok) throw new Error(response.statusText)
    } catch (error) {
      throw new RelayApiError(error instanceof Error ? error.message : 'Relay is unreachable', 0, 'network_error')
    }
  }

  async restoreRelay(): Promise<ClientRelayCredential | undefined> {
    if (!this.relayProfileId) return undefined
    const credential = await this.relayCredentials.load(this.relayProfileId)
    if (!credential) return undefined
    this.relayCredential = credential
    await this.openDurable(credential)
    return credential
  }

  markSuspended(): void {
    if (this.connectionStateValue === 'connected') this.setConnectionState('reconnecting')
  }

  resumeDurable(): Promise<void> {
    if (this.recovery) return this.recovery
    const recovery = (async () => {
      const credential = this.relayCredential
        ?? (this.relayProfileId ? await this.relayCredentials.load(this.relayProfileId) : undefined)
      if (!credential) return
      this.relayCredential = credential
      await this.openDurable(credential)
    })()
    this.recovery = recovery
    void recovery.finally(() => {
      if (this.recovery === recovery) this.recovery = undefined
    }).catch(() => undefined)
    return recovery
  }

  async pairRelay(pairingCode: string, credentialId = `client_${crypto.randomUUID()}`): Promise<ClientRelayCredential> {
    await this.openRelay({ credentialId, pairingCode })
    const credential = await this.relayCredentials.load(this.relayProfileId)
    if (!credential) throw new RelayApiError('Relay credential provisioning did not complete')
    this.relay?.close(false)
    this.relay = undefined
    return credential
  }

  async disconnect(deleteCredential = false): Promise<void> {
    this.connectionGeneration += 1
    await this.durable?.close()
    this.durable = undefined
    await this.nats?.close()
    this.nats = undefined
    this.relay?.close(false)
    this.relay = undefined
    this.relayCredential = undefined
    this.inventories.clear()
    this.gateways.clear()
    this.projectGateways.clear()
    this.sessionGateways.clear()
    this.durableIdempotencyGateways.clear()
    this.setConnectionState('disconnected')
    if (deleteCredential && this.relayProfileId) await this.relayCredentials.delete(this.relayProfileId)
  }

  async listGateways(): Promise<Gateway[]> {
    if (!this.durable) await this.restoreRelay()
    const staleBefore = Date.now() - 45_000
    const gateways = [...this.gateways.values()].map(gateway => ({
      ...gateway,
      status: gateway.lastSeenAt && Date.parse(gateway.lastSeenAt) >= staleBefore ? 'online' as const : 'offline' as const,
    }))
    this.rememberGatewayCapabilities(gateways)
    return gateways
  }

  async pairGateway(gatewayId: string, pairingCode: string, credentialId?: string): Promise<void> {
    if (!this.durable) await this.restoreRelay()
    const deviceId = credentialId ?? this.relayCredential?.credentialId
    if (!deviceId) throw new RelayApiError('Relay credential is required before pairing a Gateway')
    const handshake = new DeviceSecureHandshake({
      relayProfileId: this.relayProfileId,
      gatewayId,
      credentialId: deviceId,
      pairingCode,
      saveCredential: value => this.deviceCredentials.save(value),
    })
    if (!this.nats) throw new RelayApiError('Durable Relay synchronization is not connected', 0, 'sync_unavailable')
    await pairGatewayOverNats({ connection: this.nats, gatewayId, credentialId: deviceId, handshake })
  }

  async listProjects(gatewayId: string): Promise<Project[]> {
    return (await this.inventory(gatewayId)).projects
  }

  async createProject(gatewayId: string, input: CreateProjectDto): Promise<Project> {
    const payload = this.completed(
      await this.requestGateway(gatewayId, { kind: 'project.create', input }),
    ) as { project: Project }
    return payload.project
  }

  async listSessions(projectId: string): Promise<CodeverSession[]> {
    const gatewayId = this.requireProjectGateway(projectId)
    return (await this.inventory(gatewayId)).sessions.filter(session => session.projectId === projectId)
  }

  async discoverProviderSessions(projectId: string, provider: string): Promise<ProviderSessionListDto> {
    const gatewayId = this.requireProjectGateway(projectId)
    return this.completed(await this.requestGateway(gatewayId, { kind: 'provider.sessions.list', projectId, provider })) as ProviderSessionListDto
  }

  async getSession(sessionId: string): Promise<CodeverSession> {
    const gatewayId = this.requireSessionGateway(sessionId)
    const session = (await this.inventory(gatewayId)).sessions.find(value => value.id === sessionId)
    if (!session) throw new RelayApiError(`Unknown session ${sessionId}`, 404, 'session_not_found')
    return session
  }

  async getSessionEvents(
    sessionId: string,
    options: { after?: number; before?: number; limit?: number } = {},
  ): Promise<{ events: SessionEventEnvelope[]; nextAfter: number | null; previousBefore: number | null }> {
    const payload = this.completed(await this.requestGateway(
      this.requireSessionGateway(sessionId), { kind: 'events.list', sessionId, ...options },
    )) as {
      events: SessionEventEnvelope[]; nextAfter: number | null; previousBefore: number | null
    }
    return payload
  }

  async createSession(projectId: string, input: CreateSessionDto): Promise<CodeverSession> {
    const gatewayId = this.requireProjectGateway(projectId)
    try {
      const payload = this.completed(await this.requestGateway(gatewayId, { kind: 'session.create', projectId, input })) as { session: CodeverSession }
      await this.refreshProjectInventory(projectId)
      return payload.session
    } catch (error) {
      if (!(error instanceof RelayApiError) || error.code !== 'idempotency_in_doubt' || !input.providerSessionId) throw error
      const inventory = await this.inventory(gatewayId)
      const recovered = inventory.sessions.find(session =>
        session.projectId === projectId
        && session.provider === input.provider
        && session.providerSessionId === input.providerSessionId
        && session.state !== 'closed',
      )
      if (recovered) return recovered
      throw new RelayApiError(
        'The Gateway restarted while attaching this provider task. Refresh the task list before trying again.',
        0,
        'idempotency_in_doubt',
      )
    }
  }

  async sendMessage(sessionId: string, input: SendMessageDto): Promise<MutationReceiptDto> {
    return this.completed(await this.requestGateway(
      this.requireSessionGateway(sessionId), { kind: 'session.message', sessionId, input },
    )) as MutationReceiptDto
  }

  async uploadAttachment(
    sessionId: string,
    file: File,
    options: {
      signal?: AbortSignal
      onProgress?: (receivedBytes: number, sizeBytes: number) => void
      onStage?: (stage: 'uploading' | 'storing') => void
      onUpload?: (upload: AttachmentUploadDto) => void
      resume?: AttachmentUploadDto
    } = {},
  ): Promise<AttachmentUploadDto> {
    let attachmentId = options.resume?.attachmentId
    try {
      assertNotAborted(options.signal)
      let upload = options.resume ?? this.completed(await this.requestGateway(this.requireSessionGateway(sessionId), {
          kind: 'attachment.upload.begin',
          sessionId,
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: file.size,
        })) as AttachmentUploadDto
      if (upload.sessionId !== sessionId || upload.sizeBytes !== file.size) throw new Error('Upload resume state does not match this file')
      attachmentId = upload.attachmentId
      options.onUpload?.(upload)
      options.onStage?.('uploading')
      options.onProgress?.(upload.receivedBytes, upload.sizeBytes)

      const chunkBytes = 192 * 1024
      while (upload.receivedBytes < file.size) {
        assertNotAborted(options.signal)
        const offset = upload.receivedBytes
        const bytes = new Uint8Array(await file.slice(offset, offset + chunkBytes).arrayBuffer())
        upload = this.completed(await this.requestGateway(this.requireSessionGateway(sessionId), {
          kind: 'attachment.upload.chunk',
          attachmentId,
          offset,
          data: bytesToBase64(bytes),
        })) as AttachmentUploadDto
        options.onUpload?.(upload)
        options.onProgress?.(upload.receivedBytes, upload.sizeBytes)
      }

      assertNotAborted(options.signal)
      options.onStage?.('storing')
      const completed = this.completed(await this.requestGateway(this.requireSessionGateway(sessionId), {
        kind: 'attachment.upload.complete', attachmentId,
      })) as AttachmentUploadDto
      options.onUpload?.(completed)
      return completed
    } catch (error) {
      if (attachmentId && options.signal?.aborted) {
        await this.cancelAttachment(sessionId, attachmentId).catch(() => undefined)
      }
      throw error
    }
  }

  async cancelAttachment(sessionId: string, attachmentId: string): Promise<AttachmentUploadDto> {
    return this.completed(await this.requestGateway(this.requireSessionGateway(sessionId), {
      kind: 'attachment.upload.cancel', attachmentId,
    })) as AttachmentUploadDto
  }

  async listSessionAttachments(sessionId: string): Promise<SessionAttachmentListDto> {
    return this.completed(await this.requestGateway(this.requireSessionGateway(sessionId), {
      kind: 'attachment.list', sessionId,
    })) as SessionAttachmentListDto
  }

  async deleteSessionAttachments(sessionId: string, attachmentIds: string[]): Promise<MutationReceiptDto> {
    return this.completed(await this.requestGateway(this.requireSessionGateway(sessionId), {
      kind: 'attachment.delete', sessionId, attachmentIds,
    })) as MutationReceiptDto
  }

  async exportSessionFile(sessionId: string, path: string): Promise<SessionAttachmentDto> {
    return this.completed(await this.requestGateway(this.requireSessionGateway(sessionId), {
      kind: 'file.export', sessionId, path,
    })) as SessionAttachmentDto
  }

  async downloadAttachment(attachment: SessionAttachmentDto): Promise<Blob> {
    const chunks: BlobPart[] = []
    let offset = 0
    while (true) {
      const chunk = this.completed(await this.requestGateway(this.requireSessionGateway(attachment.sessionId), {
        kind: 'attachment.download',
        sessionId: attachment.sessionId,
        attachmentId: attachment.attachmentId,
        offset,
      })) as AttachmentDownloadChunkDto
      if (chunk.offset !== offset) throw new RelayApiError('Attachment download returned an unexpected offset')
      chunks.push(decodeBase64Bytes(chunk.data))
      if (chunk.nextOffset === null) break
      if (chunk.nextOffset <= offset) throw new RelayApiError('Attachment download did not advance')
      offset = chunk.nextOffset
    }
    return new Blob(chunks, { type: attachment.mimeType })
  }

  async cancelSession(sessionId: string, input: CancelSessionDto = {}): Promise<MutationReceiptDto> {
    return this.completed(await this.requestGateway(
      this.requireSessionGateway(sessionId), { kind: 'session.cancel', sessionId, input },
    )) as MutationReceiptDto
  }

  async setSessionArchived(sessionId: string, archived: boolean): Promise<MutationReceiptDto> {
    return this.completed(await this.requestGateway(
      this.requireSessionGateway(sessionId), { kind: 'session.archive.set', sessionId, archived },
    )) as MutationReceiptDto
  }

  async patchSessionConfig(sessionId: string, input: PatchSessionConfigDto): Promise<MutationReceiptDto> {
    return this.completed(await this.requestGateway(
      this.requireSessionGateway(sessionId), { kind: 'session.config.patch', sessionId, input },
    )) as MutationReceiptDto
  }

  async resolveDecision(sessionId: string, decisionId: string, value: JsonValue): Promise<MutationReceiptDto> {
    return this.completed(await this.requestGateway(this.requireSessionGateway(sessionId), {
      kind: 'decision.respond', sessionId, decisionId, input: { value },
    })) as MutationReceiptDto
  }

  subscribeSession(sessionId: string, subscriber: (event: SessionEventEnvelope) => void): () => void {
    const subscribers = this.eventSubscribers.get(sessionId) ?? new Set()
    subscribers.add(subscriber)
    this.eventSubscribers.set(sessionId, subscribers)
    for (const event of this.eventBacklog.get(sessionId) ?? []) subscriber(event)
    return () => {
      subscribers.delete(subscriber)
      if (!subscribers.size) this.eventSubscribers.delete(sessionId)
    }
  }

  private async openRelay(input: { credentialId: string; pairingCode: string }): Promise<void> {
    if (!this.baseUrl || !this.relayProfileId) throw new RelayApiError('Relay profile is incomplete')
    this.relay?.close()
    const handshake = new RelaySecureHandshake({
      relayProfileId: this.relayProfileId,
      credentialId: input.credentialId,
      pairingCode: input.pairingCode,
      saveCredential: value => this.relayCredentials.save(value),
    })
    const relay = new SecureRelayClient({
      baseUrl: this.baseUrl,
      handshake,
      requestTimeoutMs: this.options.requestTimeoutMs,
      onError: () => {
        if (this.relay === relay) {
          this.relay = undefined
          this.options.onDisconnected?.()
        }
      },
    })
    this.relay = relay
    try {
      await relay.connect()
    } catch (error) {
      if (this.relay === relay) this.relay = undefined
      throw error
    }
    this.relayCredential = await this.relayCredentials.load(this.relayProfileId)
    if (this.relayCredential) await this.openDurable(this.relayCredential)
  }

  private async inventory(gatewayId: string): Promise<InventorySnapshot> {
    const payload = this.completed(await this.requestGateway(gatewayId, { kind: 'inventory.get' })) as InventorySnapshot
    this.inventories.set(gatewayId, payload)
    for (const project of payload.projects) this.projectGateways.set(project.id, gatewayId)
    for (const session of payload.sessions) this.sessionGateways.set(session.id, gatewayId)
    return payload
  }

  private requireProjectGateway(projectId: string): string {
    const value = this.projectGateways.get(projectId)
    if (!value) throw new RelayApiError('Load the Gateway inventory before accessing this project')
    return value
  }
  private requireSessionGateway(sessionId: string): string {
    const value = this.sessionGateways.get(sessionId)
    if (!value) throw new RelayApiError('Load the Gateway inventory before accessing this session')
    return value
  }
  private async refreshProjectInventory(projectId: string): Promise<void> { await this.inventory(this.requireProjectGateway(projectId)) }
  private async requestGateway(
    gatewayId: string,
    payload: ClientGatewayRequestPayload,
  ): Promise<ClientGatewayResponseFrame> {
    const idempotencyKey = crypto.randomUUID()
    const timeoutMs = this.options.requestTimeoutMs ?? 10_000
    try {
      return await this.requireDurable().request(gatewayId, payload, idempotencyKey, timeoutMs)
    } catch (error) {
      if (!isRetrySafe(payload) && !this.durableIdempotencyGateways.has(gatewayId)) throw error
      await this.resumeDurable()
      return this.requireDurable().request(gatewayId, payload, idempotencyKey, timeoutMs)
    }
  }

  private async openDurable(credential: ClientRelayCredential): Promise<void> {
    const generation = ++this.connectionGeneration
    this.setConnectionState('connecting')
    await this.durable?.close()
    await this.nats?.close()
    let nats: NatsConnection
    try {
      nats = await connectDurableNats(credential)
    } catch (error) {
      if (generation === this.connectionGeneration) this.setConnectionState('disconnected')
      throw error
    }
    const durable = new DurableSyncClient({
      connection: nats,
      relayCredential: credential,
      deviceCredentials: this.deviceCredentials,
      responseStore: new IndexedDbDurableResponseStore(credential.relayProfileId, credential.credentialId),
      eventStore: new IndexedDbSessionEventStore(),
      onEvent: event => this.publishEvents([event]),
      onEvents: events => this.publishEvents(events.map(value => value.event)),
      onInventory: (gatewayId, inventory) => {
        this.inventories.set(gatewayId, inventory)
        for (const project of inventory.projects) this.projectGateways.set(project.id, gatewayId)
        for (const session of inventory.sessions) this.sessionGateways.set(session.id, gatewayId)
      },
      onGateway: gateway => { this.gateways.set(gateway.id, gateway) },
      onError: error => {
        console.error('Codever durable synchronization error', error)
      },
    })
    try {
      await durable.start()
    } catch (error) {
      await nats.close()
      if (generation === this.connectionGeneration) this.setConnectionState('disconnected')
      throw error
    }
    this.nats = nats
    this.durable = durable
    if (generation === this.connectionGeneration) {
      this.setConnectionState('connected')
      this.monitorConnection(nats, generation)
    }
  }

  private requireDurable(): DurableSyncClient {
    if (!this.durable) throw new RelayApiError('Durable Relay synchronization is not connected', 0, 'sync_unavailable')
    return this.durable
  }
  private rememberGatewayCapabilities(gateways: Gateway[]): void {
    this.durableIdempotencyGateways.clear()
    for (const gateway of gateways) {
      if (gateway.capabilities.features.includes('durable-idempotency')) {
        this.durableIdempotencyGateways.add(gateway.id)
      }
    }
  }
  private completed(response: ClientGatewayResponseFrame): unknown {
    if (response.status === 'completed') return response.payload
    if (response.status === 'failed') {
      const message = response.error.code === 'idempotency_in_doubt'
        ? 'The Gateway restarted before this operation could be confirmed. Refresh before deciding whether to try again.'
        : response.error.message
      throw new RelayApiError(message, 0, response.error.code)
    }
    throw new RelayApiError('Gateway request was accepted but did not complete')
  }
  private publishEvents(events: SessionEventEnvelope[]): void {
    for (const event of events) {
      const backlog = mergeSessionEvents(this.eventBacklog.get(event.sessionId) ?? [], [event])
      this.eventBacklog.set(event.sessionId, backlog.slice(-2_000))
      for (const subscriber of this.eventSubscribers.get(event.sessionId) ?? []) subscriber(event)
    }
  }
  private monitorConnection(connection: NatsConnection, generation: number): void {
    void (async () => {
      try {
        for await (const status of connection.status()) {
          if (generation !== this.connectionGeneration) return
          if (status.type === 'reconnect') this.setConnectionState('connected')
          else if (status.type === 'disconnect' || status.type === 'reconnecting') {
            this.durable?.beginEventReplay()
            this.setConnectionState('reconnecting')
          }
        }
      } finally {
        if (generation === this.connectionGeneration) this.setConnectionState('disconnected')
      }
    })()
  }
  private setConnectionState(state: RelayConnectionState): void {
    if (this.connectionStateValue === state) return
    this.connectionStateValue = state
    this.options.onConnectionState?.(state)
    for (const subscriber of this.connectionSubscribers) subscriber(state)
  }
}

function source(value: string | (() => string | undefined)): string | undefined {
  return typeof value === 'function' ? value() : value
}

function isRetrySafe(payload: ClientGatewayRequestPayload): boolean {
  return payload.kind === 'inventory.get' || payload.kind === 'events.list'
    || payload.kind === 'provider.sessions.list' || payload.kind === 'attachment.download'
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Upload cancelled', 'AbortError')
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const block = 0x8000
  for (let index = 0; index < bytes.length; index += block) {
    binary += String.fromCharCode(...bytes.subarray(index, index + block))
  }
  return btoa(binary)
}

function decodeBase64Bytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export const relayApiKey: InjectionKey<RelayApi> = Symbol('relay-api')
