import type {
  AccountProfile,
  ApproveGatewayEnrollmentDto,
  AuthSessionDto,
  CodeverSession,
  CreateSessionDto,
  Gateway,
  GatewayEnrollmentDto,
  GatewayEnrollmentListDto,
  EnrolledGatewayKeyDto,
  JsonObject,
  JsonValue,
  LoginDto,
  LoginResultDto,
  MutationReceiptDto,
  Project,
  SessionEventEnvelope,
} from '@codever/protocol'

export const DEMO_RELAY_URL = 'demo://preview'
const gatewayId = 'demo-gateway-main'
const projectId = 'demo-project-codever'
const sessionId = 'demo-session-auth'
const timestamp = '2026-07-16T12:00:00.000Z'
const user: AccountProfile = {
  id: 'demo-user', username: 'demo', workspaceId: 'demo-workspace', roles: ['admin'],
}
const demoEnrollment: GatewayEnrollmentDto = {
  enrollmentId: 'demo-enrollment-new-laptop', code: 'DEMO2345', gatewayId: 'demo-gateway-pending',
  workspaceId: 'demo-workspace', name: 'New studio workstation', platform: 'linux',
  fingerprint: 'sha256:demo-preview-gateway-fingerprint-2345', status: 'pending',
  createdAt: '2026-07-16T11:58:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
}
const enrolledGatewayKeys: EnrolledGatewayKeyDto[] = [{
  gatewayId, workspaceId: 'demo-workspace', name: 'Development workstation', platform: 'windows',
  fingerprint: 'sha256:demo-development-workstation-key', enabled: true, enrolledAt: timestamp,
}]

const gateways: Gateway[] = [{
  id: gatewayId,
  workspaceId: 'demo-workspace',
  name: 'Development workstation',
  platform: 'windows',
  version: '0.1.0-preview',
  status: 'online',
  connectionEpoch: 'demo-connection',
  lastSeenAt: timestamp,
  capabilities: {
    protocolVersions: [1],
    providers: ['codex', 'cursor', 'opencode'],
    features: ['sessions', 'events', 'tools', 'decisions'],
  },
}, {
  id: 'demo-gateway-laptop',
  workspaceId: 'demo-workspace',
  name: 'Travel laptop',
  platform: 'linux',
  version: '0.1.0-preview',
  status: 'offline',
  lastSeenAt: '2026-07-15T08:30:00.000Z',
  capabilities: { protocolVersions: [1], providers: ['codex'], features: ['sessions', 'events'] },
}]

const projects: Project[] = [{
  id: projectId,
  gatewayId,
  name: 'Codever',
  rootPath: 'D:\\codever',
  canonicalRoot: 'D:\\codever',
  repoIdentity: 'github.com/example/codever',
  defaultProvider: 'codex',
}, {
  id: 'demo-project-api',
  gatewayId,
  name: 'Relay API',
  rootPath: 'D:\\relay-api',
  canonicalRoot: 'D:\\relay-api',
  defaultProvider: 'cursor',
}]

const sessions: CodeverSession[] = [{
  id: sessionId,
  gatewayId,
  projectId,
  title: 'Review authentication refactor',
  state: 'idle',
  provider: 'codex',
  providerSessionId: 'demo-provider-session',
  model: 'gpt-5.6',
  mode: 'agent',
  config: { reasoningEffort: 'high' },
  createdAt: '2026-07-16T11:55:00.000Z',
  updatedAt: timestamp,
  lastEventSeq: 8,
}, {
  id: 'demo-session-design',
  gatewayId,
  projectId,
  title: 'Plan multi-gateway navigation',
  state: 'closed',
  provider: 'cursor',
  model: 'auto',
  mode: 'plan',
  config: {},
  createdAt: '2026-07-15T09:00:00.000Z',
  updatedAt: '2026-07-15T09:42:00.000Z',
  lastEventSeq: 0,
}]

const events = new Map<string, SessionEventEnvelope[]>([[sessionId, [
  envelope(1, { kind: 'user_message', text: 'Review the Relay authentication changes and show me the important parts.' }),
  envelope(2, { kind: 'turn_started' }),
  envelope(3, { kind: 'assistant_text_delta', text: 'I’ll inspect the authentication service and its tests, then summarize the security boundaries.' }),
  envelope(4, {
    kind: 'tool', phase: 'started', toolCallId: 'demo-tool-1', toolName: 'read_file', category: 'read',
    displayTitle: 'Reading Relay account authentication', input: { path: 'apps/relay/src/accountAuth.ts' },
  }),
  envelope(5, {
    kind: 'tool', phase: 'completed', toolCallId: 'demo-tool-1', toolName: 'read_file', category: 'read',
    displayTitle: 'Read Relay account authentication', output: { lines: 284, tokenStorage: 'sha256' },
    content: [{ type: 'text', text: 'Opaque bearer tokens are persisted only as SHA-256 hashes.' }],
  }),
  envelope(6, { kind: 'assistant_text_delta', text: 'The Gateway key authenticates the machine; TLS protects transport confidentiality. Client sessions use revocable opaque bearer tokens.' }),
  envelope(7, {
    kind: 'decision_request', decisionId: 'demo-decision-1', title: 'Apply the recommended session policy?',
    body: 'This is an interactive preview. Choosing an option updates the timeline locally.', required: true, source: 'agent',
    options: [
      { id: 'approve', label: 'Apply policy', value: 'approve', style: 'primary' },
      { id: 'later', label: 'Review later', value: 'later' },
      { id: 'reject', label: 'Reject', value: 'reject', style: 'danger' },
    ],
  }),
  envelope(8, { kind: 'session_state', state: 'idle' }),
]]])

type Listener = (event: SessionEventEnvelope) => void
const listeners = new Map<string, Set<Listener>>()
let commandCounter = 0
let sessionCounter = 0

export function isDemoRelayUrl(value: string): boolean {
  return value.replace(/\/+$/, '') === DEMO_RELAY_URL
}

export const demoRelay = {
  checkHealth(): void {},
  login(input: LoginDto): LoginResultDto {
    if (input.username !== 'demo' || input.password !== 'demo') throw new Error('Use demo / demo for the preview Relay.')
    return { accessToken: 'demo-access-token-for-offline-preview', expiresAt: '2099-01-01T00:00:00.000Z', user }
  },
  session(): AuthSessionDto {
    return { expiresAt: '2099-01-01T00:00:00.000Z', user }
  },
  listGateways: (): Gateway[] => structuredClone(gateways),
  listEnrollments(): GatewayEnrollmentListDto {
    return { bootstrapComplete: true, enrollments: demoEnrollment.status === 'pending' ? [structuredClone(demoEnrollment)] : [] }
  },
  getEnrollment(code: string): GatewayEnrollmentDto {
    if (code.replace(/[\s-]/g, '').toUpperCase() !== demoEnrollment.code) throw new Error('Demo pairing code is DEMO-2345')
    return structuredClone(demoEnrollment)
  },
  approveEnrollment(code: string, confirmation: ApproveGatewayEnrollmentDto): GatewayEnrollmentDto {
    const enrollment = this.getEnrollment(code)
    if (confirmation.fingerprint !== enrollment.fingerprint || confirmation.name !== enrollment.name || confirmation.platform !== enrollment.platform) throw new Error('Gateway confirmation details changed')
    demoEnrollment.status = 'approved'
    demoEnrollment.approvedAt = new Date().toISOString()
    const key: EnrolledGatewayKeyDto = {
      gatewayId: enrollment.gatewayId, workspaceId: enrollment.workspaceId, name: enrollment.name,
      platform: enrollment.platform, fingerprint: enrollment.fingerprint, enabled: true, enrolledAt: demoEnrollment.approvedAt,
    }
    enrolledGatewayKeys.push(key)
    return structuredClone(demoEnrollment)
  },
  rejectEnrollment(code: string, reason?: string): GatewayEnrollmentDto {
    this.getEnrollment(code)
    demoEnrollment.status = 'rejected'
    demoEnrollment.rejectedAt = new Date().toISOString()
    if (reason) demoEnrollment.rejectionReason = reason
    return structuredClone(demoEnrollment)
  },
  listEnrolledGateways: (): EnrolledGatewayKeyDto[] => structuredClone(enrolledGatewayKeys),
  revokeGateway(id: string): EnrolledGatewayKeyDto {
    const key = enrolledGatewayKeys.find(value => value.gatewayId === id)
    if (!key) throw new Error('Enrolled Gateway not found')
    key.enabled = false
    key.revokedAt = new Date().toISOString()
    return structuredClone(key)
  },
  listProjects: (id: string): Project[] => structuredClone(projects.filter(project => project.gatewayId === id)),
  listSessions: (id: string): CodeverSession[] => structuredClone(sessions.filter(session => session.projectId === id)),
  getSession(id: string): CodeverSession {
    const session = sessions.find(value => value.id === id)
    if (!session) throw new Error('Demo session not found')
    return structuredClone(session)
  },
  getEvents(id: string, after: number): SessionEventEnvelope[] {
    return structuredClone((events.get(id) ?? []).filter(event => event.seq > after))
  },
  createSession(id: string, input: CreateSessionDto): CodeverSession {
    sessionCounter += 1
    const session: CodeverSession = {
      id: `demo-created-${sessionCounter}`, gatewayId, projectId: id, title: input.title ?? 'New preview session',
      state: 'idle', provider: input.provider, ...(input.model && { model: input.model }),
      ...(input.mode && { mode: input.mode }), config: input.config, createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), lastEventSeq: 0,
    }
    sessions.unshift(session)
    events.set(session.id, [])
    return structuredClone(session)
  },
  sendMessage(id: string, text: string): MutationReceiptDto {
    const toolCallId = `demo-tool-${Date.now()}`
    append(id, { kind: 'user_message', text })
    append(id, { kind: 'turn_started' })
    append(id, { kind: 'tool', phase: 'started', toolCallId, toolName: 'preview', category: 'agent', displayTitle: 'Running offline preview' })
    append(id, { kind: 'tool', phase: 'completed', toolCallId, toolName: 'preview', category: 'agent', displayTitle: 'Completed offline preview', output: { demo: true } })
    append(id, { kind: 'assistant_text_delta', text: `This is a local Demo Relay response to: ${text}` })
    append(id, { kind: 'turn_finished', status: 'success', summary: 'Offline preview completed' })
    append(id, { kind: 'session_state', state: 'idle' })
    return receipt()
  },
  cancel(id: string): MutationReceiptDto {
    append(id, { kind: 'session_state', state: 'idle', reason: 'Cancelled in offline preview' })
    return receipt()
  },
  patchConfig(id: string, config: JsonObject): MutationReceiptDto {
    const session = sessions.find(value => value.id === id)
    if (session) session.config = { ...session.config, ...config }
    append(id, { kind: 'settings', model: typeof config.model === 'string' ? config.model : undefined, providerSettings: config })
    return receipt()
  },
  resolveDecision(id: string, decisionId: string, value: JsonValue): MutationReceiptDto {
    append(id, { kind: 'decision_resolved', decisionId, value, resolvedBy: user.id })
    return receipt()
  },
  subscribe(id: string, after: number, listener: Listener): () => void {
    for (const event of (events.get(id) ?? []).filter(value => value.seq > after)) queueMicrotask(() => listener(structuredClone(event)))
    const set = listeners.get(id) ?? new Set<Listener>()
    set.add(listener)
    listeners.set(id, set)
    return () => set.delete(listener)
  },
}

function envelope(seq: number, event: SessionEventEnvelope['event'], id = sessionId): SessionEventEnvelope {
  return {
    schemaVersion: 1, gatewayId, projectId, sessionId: id, seq, eventId: `${id}-event-${seq}`,
    timestamp: new Date(Date.parse(timestamp) + seq * 1_000).toISOString(), event,
  }
}

function append(id: string, event: SessionEventEnvelope['event']): void {
  const list = events.get(id) ?? []
  const next = envelope((list.at(-1)?.seq ?? 0) + 1, event, id)
  list.push(next)
  events.set(id, list)
  const session = sessions.find(value => value.id === id)
  if (session) {
    session.lastEventSeq = next.seq
    session.updatedAt = next.timestamp
  }
  for (const listener of listeners.get(id) ?? []) listener(structuredClone(next))
}

function receipt(): MutationReceiptDto {
  commandCounter += 1
  return { commandId: `demo-command-${commandCounter}`, status: 'completed', completedAt: new Date().toISOString() }
}
