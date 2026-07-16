import type {
  CancelSessionDto,
  CodeverSession,
  CreateSessionDto,
  Gateway,
  JsonObject,
  JsonValue,
  MutationReceiptDto,
  Project,
  ResolveDecisionDto,
  SendMessageDto,
  SessionEventEnvelope,
  AuthSessionDto,
  ApproveGatewayEnrollmentDto,
  EnrolledGatewayKeyDto,
  GatewayEnrollmentDto,
  GatewayEnrollmentListDto,
  LoginDto,
  LoginResultDto,
  ProviderSessionListDto,
  PatchSessionConfigDto,
} from '@codever/protocol'
import {
  parseGatewayListDto,
  parseMutationReceiptDto,
  parseProjectListDto,
  parseSessionDto,
  parseSessionEventsDto,
  parseSessionListDto,
  parseAuthSessionDto,
  parseEnrolledGatewayKeyDto,
  parseEnrolledGatewayKeyListDto,
  parseGatewayEnrollmentDto,
  parseGatewayEnrollmentListDto,
  parseLoginResultDto,
  parseProviderSessionListDto,
} from '@codever/protocol'
import type { InjectionKey } from 'vue'
import { demoRelay, isDemoRelayUrl } from './demoRelay'

export interface RelayApiOptions {
  baseUrl: string | (() => string | undefined)
  fetch?: typeof globalThis.fetch
  getAccessToken?: () => string | undefined
  onUnauthorized?: () => void
}

export class RelayApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message)
    this.name = 'RelayApiError'
  }
}

export class RelayApi {
  private readonly baseUrlSource: RelayApiOptions['baseUrl']
  private readonly fetcher: typeof globalThis.fetch
  private readonly getAccessToken?: () => string | undefined
  private readonly onUnauthorized?: () => void

  constructor(options: RelayApiOptions) {
    this.baseUrlSource = options.baseUrl
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.getAccessToken = options.getAccessToken
    this.onUnauthorized = options.onUnauthorized
  }

  get baseUrl(): string {
    const value = typeof this.baseUrlSource === 'function' ? this.baseUrlSource() : this.baseUrlSource
    return (value ?? '').replace(/\/+$/, '')
  }

  get accessToken(): string | undefined {
    return this.getAccessToken?.()
  }

  async checkHealth(): Promise<void> {
    if (this.isDemo) return demoRelay.checkHealth()
    await this.request('/health', {}, false)
  }

  async login(body: LoginDto): Promise<LoginResultDto> {
    if (this.isDemo) return demoRelay.login(body)
    return parseLoginResultDto(await this.request('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
    }, false))
  }

  async getAuthSession(): Promise<AuthSessionDto> {
    if (this.isDemo) return demoRelay.session()
    return parseAuthSessionDto(await this.request('/v1/auth/session'))
  }

  async logout(): Promise<void> {
    if (this.isDemo) return
    await this.request('/v1/auth/logout', { method: 'POST' })
  }

  async listGateways(): Promise<Gateway[]> {
    if (this.isDemo) return demoRelay.listGateways()
    return parseGatewayListDto(await this.request('/v1/gateways')).gateways
  }

  async listGatewayEnrollments(): Promise<GatewayEnrollmentListDto> {
    if (this.isDemo) return demoRelay.listEnrollments()
    return parseGatewayEnrollmentListDto(await this.request('/v1/gateway-enrollments'))
  }

  async getGatewayEnrollment(code: string): Promise<GatewayEnrollmentDto> {
    if (this.isDemo) return demoRelay.getEnrollment(code)
    return parseGatewayEnrollmentDto(await this.request(`/v1/gateway-enrollments/${encodeURIComponent(normalizePairingCode(code))}`))
  }

  async approveGatewayEnrollment(code: string, body: ApproveGatewayEnrollmentDto): Promise<GatewayEnrollmentDto> {
    if (this.isDemo) return demoRelay.approveEnrollment(code, body)
    return parseGatewayEnrollmentDto(await this.request(`/v1/gateway-enrollments/${encodeURIComponent(normalizePairingCode(code))}/approve`, {
      method: 'POST', body: JSON.stringify(body),
    }))
  }

  async rejectGatewayEnrollment(code: string, reason?: string): Promise<GatewayEnrollmentDto> {
    if (this.isDemo) return demoRelay.rejectEnrollment(code, reason)
    return parseGatewayEnrollmentDto(await this.request(`/v1/gateway-enrollments/${encodeURIComponent(normalizePairingCode(code))}/reject`, {
      method: 'POST', body: JSON.stringify({ ...(reason && { reason }) }),
    }))
  }

  async listEnrolledGateways(): Promise<EnrolledGatewayKeyDto[]> {
    if (this.isDemo) return demoRelay.listEnrolledGateways()
    return parseEnrolledGatewayKeyListDto(await this.request('/v1/enrolled-gateways')).gateways
  }

  async revokeEnrolledGateway(gatewayId: string): Promise<EnrolledGatewayKeyDto> {
    if (this.isDemo) return demoRelay.revokeGateway(gatewayId)
    return parseEnrolledGatewayKeyDto(await this.request(`/v1/enrolled-gateways/${encodeURIComponent(gatewayId)}/revoke`, { method: 'POST' }))
  }

  async listProjects(gatewayId: string): Promise<Project[]> {
    if (this.isDemo) return demoRelay.listProjects(gatewayId)
    const data = await this.request(`/v1/gateways/${encodeURIComponent(gatewayId)}/projects`)
    return parseProjectListDto(data).projects
  }

  async listSessions(projectId: string): Promise<CodeverSession[]> {
    if (this.isDemo) return demoRelay.listSessions(projectId)
    const data = await this.request(`/v1/projects/${encodeURIComponent(projectId)}/sessions`)
    return parseSessionListDto(data).sessions
  }

  async discoverProviderSessions(projectId: string, provider: string): Promise<ProviderSessionListDto> {
    if (this.isDemo) return demoRelay.discoverProviderSessions(projectId, provider)
    const data = await this.mutate(
      `/v1/projects/${encodeURIComponent(projectId)}/providers/${encodeURIComponent(provider)}/sessions/discover`,
      'POST',
      {},
    )
    return parseProviderSessionListDto(data)
  }

  async getSession(sessionId: string): Promise<CodeverSession> {
    if (this.isDemo) return demoRelay.getSession(sessionId)
    const data = await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}`)
    return parseSessionDto(data).session
  }

  async getSessionEvents(sessionId: string, after = 0): Promise<{
    events: SessionEventEnvelope[]
    nextAfter: number | null
  }> {
    if (this.isDemo) {
      const events = demoRelay.getEvents(sessionId, after)
      return { events, nextAfter: events.at(-1)?.seq ?? null }
    }
    const data = await this.request(
      `/v1/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`,
    )
    const parsed = parseSessionEventsDto(data)
    return { events: parsed.events, nextAfter: parsed.nextAfter }
  }

  async createSession(projectId: string, body: CreateSessionDto): Promise<CodeverSession> {
    if (this.isDemo) return demoRelay.createSession(projectId, body)
    const data = await this.mutate(
      `/v1/projects/${encodeURIComponent(projectId)}/sessions`,
      'POST',
      body,
    )
    return parseSessionDto(data).session
  }

  sendMessage(sessionId: string, body: SendMessageDto): Promise<MutationReceiptDto> {
    if (this.isDemo) return Promise.resolve(demoRelay.sendMessage(sessionId, body.text))
    return this.mutationReceipt(`/v1/sessions/${encodeURIComponent(sessionId)}/messages`, 'POST', body)
  }

  cancelSession(sessionId: string, body: CancelSessionDto = {}): Promise<MutationReceiptDto> {
    if (this.isDemo) return Promise.resolve(demoRelay.cancel(sessionId))
    return this.mutationReceipt(`/v1/sessions/${encodeURIComponent(sessionId)}/cancel`, 'POST', body)
  }

  patchSessionConfig(sessionId: string, body: PatchSessionConfigDto): Promise<MutationReceiptDto> {
    if (this.isDemo) return Promise.resolve(demoRelay.patchConfig(sessionId, body))
    return this.mutationReceipt(
      `/v1/sessions/${encodeURIComponent(sessionId)}/config`,
      'PATCH',
      body,
    )
  }

  resolveDecision(sessionId: string, decisionId: string, value: JsonValue): Promise<MutationReceiptDto> {
    if (this.isDemo) return Promise.resolve(demoRelay.resolveDecision(sessionId, decisionId, value))
    const body: ResolveDecisionDto = { value }
    return this.mutationReceipt(
      `/v1/sessions/${encodeURIComponent(sessionId)}/decisions/${encodeURIComponent(decisionId)}`,
      'POST',
      body,
    )
  }

  private async mutationReceipt(path: string, method: string, body: unknown): Promise<MutationReceiptDto> {
    return parseMutationReceiptDto(await this.mutate(path, method, body))
  }

  private mutate(path: string, method: string, body: unknown): Promise<unknown> {
    return this.request(path, {
      method,
      body: JSON.stringify(body),
      headers: { 'Idempotency-Key': createIdempotencyKey() },
    })
  }

  private async request(path: string, init: RequestInit = {}, authenticate = true): Promise<unknown> {
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    if (init.body) headers.set('Content-Type', 'application/json')
    const accessToken = authenticate ? this.getAccessToken?.() : undefined
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)

    let response: Response
    try {
      if (!this.baseUrl) throw new Error('No Relay profile is configured')
      response = await this.fetcher(`${this.baseUrl}${path}`, { ...init, headers })
    } catch (error) {
      throw new RelayApiError(error instanceof Error ? error.message : 'Relay is unreachable', 0, 'network_error')
    }

    const data = await response.json().catch(() => undefined)
    if (!response.ok) {
      if (response.status === 401 && authenticate) this.onUnauthorized?.()
      const details = asErrorDetails(data)
      throw new RelayApiError(details.message ?? response.statusText, response.status, details.code)
    }
    return data
  }

  private get isDemo(): boolean {
    return isDemoRelayUrl(this.baseUrl)
  }
}

function createIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `web-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function normalizePairingCode(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase()
}

function asErrorDetails(value: unknown): { code?: string; message?: string } {
  if (!value || typeof value !== 'object') return {}
  const record = value as Record<string, unknown>
  if (typeof record.error === 'string') return { message: record.error }
  const source = record.error && typeof record.error === 'object'
    ? record.error as Record<string, unknown>
    : record
  return {
    code: typeof source.code === 'string' ? source.code : undefined,
    message: typeof source.message === 'string' ? source.message : undefined,
  }
}

export const relayApiKey: InjectionKey<RelayApi> = Symbol('relay-api')
