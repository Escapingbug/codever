import type {
  CancelSessionDto,
  CodeverSession,
  ClientGatewayResponseFrame,
  CreateSessionDto,
  Gateway,
  InventorySnapshot,
  JsonValue,
  MutationReceiptDto,
  PatchSessionConfigDto,
  Project,
  ProviderSessionListDto,
  SendMessageDto,
  SessionEventEnvelope,
} from '@codever/protocol'
import type { InjectionKey } from 'vue'
import { DeviceSecureHandshake } from '../security/deviceSecureHandshake'
import { ClientDeviceCredentialStore } from '../security/deviceCredentialStore'
import { RelaySecureHandshake } from '../security/relaySecureHandshake'
import { ClientRelayCredentialStore, type ClientRelayCredential } from '../security/relayCredentialStore'
import type { SecretStore } from '../security/secretStore'
import { GatewaySecureConnection, SecureRelayClient } from './secureRelayClient'

export interface RelayApiOptions {
  baseUrl: string | (() => string | undefined)
  relayProfileId: string | (() => string | undefined)
  secrets: SecretStore
  fetch?: typeof globalThis.fetch
  onDisconnected?: () => void
}

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
  private readonly gatewayConnections = new Map<string, GatewaySecureConnection>()
  private readonly inventories = new Map<string, InventorySnapshot>()
  private readonly projectGateways = new Map<string, string>()
  private readonly sessionGateways = new Map<string, string>()
  private readonly eventSubscribers = new Map<string, Set<(event: SessionEventEnvelope) => void>>()

  constructor(private readonly options: RelayApiOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.relayCredentials = new ClientRelayCredentialStore(options.secrets)
    this.deviceCredentials = new ClientDeviceCredentialStore(options.secrets)
  }

  get baseUrl(): string { return (source(this.options.baseUrl) ?? '').replace(/\/+$/, '') }
  get relayProfileId(): string { return source(this.options.relayProfileId) ?? '' }

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
    await this.openRelay({ credentialId: credential.credentialId, credential })
    return credential
  }

  async pairRelay(pairingCode: string, credentialId = `client_${crypto.randomUUID()}`): Promise<ClientRelayCredential> {
    await this.openRelay({ credentialId, pairingCode })
    const credential = await this.relayCredentials.load(this.relayProfileId)
    if (!credential) throw new RelayApiError('Relay credential provisioning did not complete')
    return credential
  }

  async disconnect(deleteCredential = false): Promise<void> {
    this.relay?.close()
    this.relay = undefined
    this.relayCredential = undefined
    this.gatewayConnections.clear()
    this.inventories.clear()
    this.projectGateways.clear()
    this.sessionGateways.clear()
    if (deleteCredential && this.relayProfileId) await this.relayCredentials.delete(this.relayProfileId)
  }

  async listGateways(): Promise<Gateway[]> { return (await this.requireRelay()).listGateways() }

  async pairGateway(gatewayId: string, pairingCode: string, credentialId = `device_${crypto.randomUUID()}`): Promise<void> {
    const relay = await this.requireRelay()
    const handshake = new DeviceSecureHandshake({
      relayProfileId: this.relayProfileId,
      gatewayId,
      credentialId,
      pairingCode,
      saveCredential: value => this.deviceCredentials.save(value),
    })
    const connection = await relay.openGateway(gatewayId, handshake, event => this.publishEvents(event.payload.events))
    this.gatewayConnections.set(gatewayId, connection)
  }

  async listProjects(gatewayId: string): Promise<Project[]> {
    return (await this.inventory(gatewayId)).projects
  }

  async listSessions(projectId: string): Promise<CodeverSession[]> {
    const gatewayId = this.requireProjectGateway(projectId)
    return (await this.inventory(gatewayId)).sessions.filter(session => session.projectId === projectId)
  }

  async discoverProviderSessions(projectId: string, provider: string): Promise<ProviderSessionListDto> {
    return this.completed(await (await this.gatewayForProject(projectId)).request({ kind: 'provider.sessions.list', projectId, provider })) as ProviderSessionListDto
  }

  async getSession(sessionId: string): Promise<CodeverSession> {
    const gatewayId = this.requireSessionGateway(sessionId)
    const session = (await this.inventory(gatewayId)).sessions.find(value => value.id === sessionId)
    if (!session) throw new RelayApiError(`Unknown session ${sessionId}`, 404, 'session_not_found')
    return session
  }

  async getSessionEvents(sessionId: string, after = 0): Promise<{ events: SessionEventEnvelope[]; nextAfter: number | null }> {
    const payload = this.completed(await (await this.gatewayForSession(sessionId)).request({ kind: 'events.list', sessionId, after })) as {
      events: SessionEventEnvelope[]; nextAfter: number | null
    }
    return payload
  }

  async createSession(projectId: string, input: CreateSessionDto): Promise<CodeverSession> {
    const payload = this.completed(await (await this.gatewayForProject(projectId)).request({ kind: 'session.create', projectId, input })) as { session: CodeverSession }
    await this.refreshProjectInventory(projectId)
    return payload.session
  }

  async sendMessage(sessionId: string, input: SendMessageDto): Promise<MutationReceiptDto> {
    return this.completed(await (await this.gatewayForSession(sessionId)).request({ kind: 'session.message', sessionId, input })) as MutationReceiptDto
  }

  async cancelSession(sessionId: string, input: CancelSessionDto = {}): Promise<MutationReceiptDto> {
    return this.completed(await (await this.gatewayForSession(sessionId)).request({ kind: 'session.cancel', sessionId, input })) as MutationReceiptDto
  }

  async patchSessionConfig(sessionId: string, input: PatchSessionConfigDto): Promise<MutationReceiptDto> {
    return this.completed(await (await this.gatewayForSession(sessionId)).request({ kind: 'session.config.patch', sessionId, input })) as MutationReceiptDto
  }

  async resolveDecision(sessionId: string, decisionId: string, value: JsonValue): Promise<MutationReceiptDto> {
    return this.completed(await (await this.gatewayForSession(sessionId)).request({
      kind: 'decision.respond', sessionId, decisionId, input: { value },
    })) as MutationReceiptDto
  }

  subscribeSession(sessionId: string, subscriber: (event: SessionEventEnvelope) => void): () => void {
    const subscribers = this.eventSubscribers.get(sessionId) ?? new Set()
    subscribers.add(subscriber)
    this.eventSubscribers.set(sessionId, subscribers)
    return () => {
      subscribers.delete(subscriber)
      if (!subscribers.size) this.eventSubscribers.delete(sessionId)
    }
  }

  private async openRelay(input: { credentialId: string; pairingCode?: string; credential?: ClientRelayCredential }): Promise<void> {
    if (!this.baseUrl || !this.relayProfileId) throw new RelayApiError('Relay profile is incomplete')
    this.relay?.close()
    const handshake = new RelaySecureHandshake({
      relayProfileId: this.relayProfileId,
      credentialId: input.credentialId,
      ...(input.pairingCode ? { pairingCode: input.pairingCode } : {}),
      ...(input.credential ? { credential: input.credential } : {}),
      saveCredential: value => this.relayCredentials.save(value),
    })
    const relay = new SecureRelayClient({
      baseUrl: this.baseUrl,
      handshake,
      onError: () => this.options.onDisconnected?.(),
    })
    await relay.connect()
    this.relay = relay
    this.relayCredential = await this.relayCredentials.load(this.relayProfileId)
  }

  private async requireRelay(): Promise<SecureRelayClient> {
    if (this.relay) return this.relay
    const restored = await this.restoreRelay()
    if (!restored || !this.relay) throw new RelayApiError('Relay pairing is required', 401, 'pairing_required')
    return this.relay
  }

  private async gateway(gatewayId: string): Promise<GatewaySecureConnection> {
    const existing = this.gatewayConnections.get(gatewayId)
    if (existing) return existing
    const credential = await this.deviceCredentials.load(this.relayProfileId, gatewayId)
    if (!credential) throw new RelayApiError('Gateway pairing is required', 401, 'gateway_pairing_required')
    const handshake = new DeviceSecureHandshake({
      relayProfileId: this.relayProfileId,
      gatewayId,
      credentialId: credential.credentialId,
      credential,
      saveCredential: value => this.deviceCredentials.save(value),
    })
    const connection = await (await this.requireRelay()).openGateway(
      gatewayId, handshake, event => this.publishEvents(event.payload.events),
    )
    this.gatewayConnections.set(gatewayId, connection)
    return connection
  }

  private async inventory(gatewayId: string): Promise<InventorySnapshot> {
    const payload = this.completed(await (await this.gateway(gatewayId)).request({ kind: 'inventory.get' })) as InventorySnapshot
    this.inventories.set(gatewayId, payload)
    for (const project of payload.projects) this.projectGateways.set(project.id, gatewayId)
    for (const session of payload.sessions) this.sessionGateways.set(session.id, gatewayId)
    return payload
  }

  private gatewayForProject(projectId: string): Promise<GatewaySecureConnection> { return this.gateway(this.requireProjectGateway(projectId)) }
  private gatewayForSession(sessionId: string): Promise<GatewaySecureConnection> { return this.gateway(this.requireSessionGateway(sessionId)) }
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
  private completed(response: ClientGatewayResponseFrame): unknown {
    if (response.status === 'completed') return response.payload
    if (response.status === 'failed') throw new RelayApiError(response.error.message, 0, response.error.code)
    throw new RelayApiError('Gateway request was accepted but did not complete')
  }
  private publishEvents(events: SessionEventEnvelope[]): void {
    for (const event of events) for (const subscriber of this.eventSubscribers.get(event.sessionId) ?? []) subscriber(event)
  }
}

function source(value: string | (() => string | undefined)): string | undefined {
  return typeof value === 'function' ? value() : value
}

export const relayApiKey: InjectionKey<RelayApi> = Symbol('relay-api')
