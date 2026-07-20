import type {
  CodeverSession,
  AttachmentUploadDto,
  CreateSessionDto,
  Gateway,
  PatchSessionConfigDto,
  Project,
  SendMessageDto,
  SessionAttachmentDto,
  SessionEventEnvelope,
} from '@codever/protocol'
import { createApp } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from '../App.vue'
import { codeverApiKey, type CodeverApi } from '../api/codeverApi'
import { clientSession } from '../state/clientSession'
import ProjectView from '../views/ProjectView.vue'
import SessionView from '../views/SessionView.vue'
import GatewayListView from '../views/GatewayListView.vue'
import GatewayView from '../views/GatewayView.vue'
import MachineListView from '../views/MachineListView.vue'
import SettingsView from '../views/SettingsView.vue'
import { createPlatformSecretStore } from '../security/secretStore'
import '../styles.css'

const gateway: Gateway = {
  id: 'gateway-e2e', workspaceId: 'workspace-e2e', name: 'My computer', platform: 'windows', version: 'e2e',
  capabilities: { protocolVersions: [1], providers: ['scripted-agent'], features: ['file.export', 'attachment.download'] },
  status: 'online', lastSeenAt: '2026-07-18T08:00:00.000Z',
}
const unpairedGateway: Gateway = {
  id: 'gateway-unpaired-e2e', workspaceId: 'workspace-e2e', name: 'Second computer', platform: 'linux', version: 'e2e',
  capabilities: { protocolVersions: [1], providers: ['codex'], features: [], metadata: { matrixDeviceId: 'SECONDGATEWAY', matrixVerified: false } },
  status: 'online', lastSeenAt: '2026-07-18T08:00:00.000Z',
}
const project: Project = {
  id: 'project-e2e', gatewayId: gateway.id, name: 'Codever', rootPath: 'D:/workspace', canonicalRoot: 'D:/workspace',
  defaultProvider: 'scripted-agent',
}
const projects: Project[] = [project]
let secondGatewayAuthorized = false
const longHistoryFixture = new URLSearchParams(window.location.search).get('history') === 'long'
const session: CodeverSession = {
  id: longHistoryFixture ? 'session-long-history-e2e' : 'session-e2e', gatewayId: gateway.id, projectId: project.id, title: 'Build Android client', state: 'idle',
  provider: 'scripted-agent', config: {}, createdAt: '2026-07-18T08:00:00.000Z',
  updatedAt: '2026-07-18T08:01:00.000Z', lastEventSeq: 4,
}
const sessions: CodeverSession[] = [session]

let sequence = 0
const events: SessionEventEnvelope[] = []
const subscribers = new Set<(event: SessionEventEnvelope) => void>()
const connectionSubscribers = new Set<(state: 'connected' | 'disconnected') => void>()
let mockConnectionState: 'connected' | 'disconnected' = 'connected'
const offlineBacklog: SessionEventEnvelope[] = []
let pendingSend: { input: SendMessageDto; resolve: (value: unknown) => void } | undefined
let activeTurnId = ''
let lastSentInput: SendMessageDto | undefined
let exportedPath = ''
let lastConfig: PatchSessionConfigDto | undefined
let archiveUpdates = 0
let matrixGatewayVerified = false
let verificationStage: 'none' | 'requested' | 'present_sas' | 'done' = 'none'
let approvalVisible = true
let approvalSubscriber: ((requests: Array<Record<string, unknown>>) => void) | undefined
const attachments: SessionAttachmentDto[] = []
const nativeSecrets = createPlatformSecretStore()

clientSession.server.value = { domain: 'matrix.example.test', homeserver: 'https://matrix.example.test' }
clientSession.identity.value = {
  session: { homeserver: 'https://matrix.example.test', userId: '@codever:matrix.example.test', deviceId: 'CLIENTDEVICE' },
  controlRoomId: '!control:matrix.example.test', executionKeyId: 'execution-current', executionPublicKey: {},
}
clientSession.listMatrixDevices = async () => [
  { deviceId: 'CLIENTDEVICE', displayName: 'Codever Android', verified: true, current: true, verifiable: true },
  { deviceId: 'SECONDGATEWAY', displayName: 'Windows Gateway', verified: matrixGatewayVerified, current: false, verifiable: true },
]
clientSession.listVerifications = async () => {
  if (verificationStage === 'none' || verificationStage === 'done') return []
  const stage = verificationStage
  return [{
  flowId: 'verification-e2e', stage, otherDeviceId: 'SECONDGATEWAY',
  ...(verificationStage === 'present_sas' ? { emojis: [
    { symbol: '🐶', description: 'Dog' }, { symbol: '🚀', description: 'Rocket' },
    { symbol: '🎸', description: 'Guitar' }, { symbol: '🌙', description: 'Moon' },
  ] } : {}),
  }]
}
clientSession.requestVerification = async () => {
  verificationStage = 'requested'
  return { flowId: 'verification-e2e', stage: 'requested', otherDeviceId: 'SECONDGATEWAY' }
}
clientSession.advanceVerification = async () => {
  verificationStage = 'present_sas'
  return (await clientSession.listVerifications())[0]!
}
clientSession.confirmVerification = async (_flowId: string, matches: boolean) => {
  if (!matches) throw new Error('E2E verification mismatch')
  matrixGatewayVerified = true
  unpairedGateway.capabilities.metadata = { ...unpairedGateway.capabilities.metadata, matrixVerified: true }
  verificationStage = 'done'
  return { flowId: 'verification-e2e', stage: 'done' as const, otherDeviceId: 'SECONDGATEWAY' }
}
clientSession.cancelVerification = async () => { verificationStage = 'done' }

if (longHistoryFixture) {
  for (let index = 1; index <= 8; index += 1) {
    const turnId = `historical-turn-${index}`
    append({ kind: 'user_message', text: `Historical request ${index}`, meta: { turnId, source: 'replay' } }, false)
    append({ kind: 'turn_started', meta: { turnId, source: 'replay' } }, false)
    append({ kind: 'assistant_text_delta', text: `Historical reply ${index}.`, meta: { turnId, source: 'replay' } }, false)
    append({ kind: 'turn_finished', status: 'success', meta: { turnId, source: 'replay' } }, false)
  }
}
append({ kind: 'user_message', text: 'Prepare a test build', clientMessageId: 'historic-message', meta: { turnId: 'historic-turn', source: 'replay' } }, false)
append({ kind: 'turn_started', meta: { turnId: 'historic-turn', source: 'replay' } }, false)
append({ kind: 'assistant_text_delta', text: 'Build ready. [Download APK](D:/workspace/codever-client.apk)', meta: { turnId: 'historic-turn', source: 'replay' } }, false)
append({ kind: 'turn_finished', status: 'success', meta: { turnId: 'historic-turn', source: 'replay' } }, false)
session.lastEventSeq = sequence

const api = {
  connectionState: 'connected',
  subscribeConnection(callback: (state: 'connected' | 'disconnected') => void) {
    callback(clientSession.connectionState.value === 'connected' ? 'connected' : 'disconnected')
    connectionSubscribers.add(callback)
    return () => connectionSubscribers.delete(callback)
  },
  rememberRoute() {},
  async listGateways() { return [gateway, unpairedGateway] },
  subscribeExecutionApprovals(callback: (requests: Array<Record<string, unknown>>) => void) {
    approvalSubscriber = callback
    callback(approvalVisible ? [{
      requestId: 'approval-e2e', gatewayId: gateway.id, ownerId: 'NEWCLIENT', label: 'New phone',
      senderDevice: 'NEWCLIENT', publicKey: {
        kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', kid: 'execution-new', x: 'x', y: 'y',
      },
    }] : [])
    return () => undefined
  },
  async approveExecutionRoot() {
    approvalVisible = false
    approvalSubscriber?.([])
    return { commandId: 'approval-e2e', status: 'succeeded' }
  },
  async listProjects(gatewayId: string) {
    if (gatewayId === unpairedGateway.id) {
      if (!secondGatewayAuthorized) throw new Error('Execution signing key is unknown or revoked')
      return []
    }
    return [...projects]
  },
  async createProject(gatewayId: string, input: { name: string; rootPath: string; defaultProvider?: string }) {
    const created: Project = {
      id: `project-created-${projects.length}`, gatewayId, name: input.name,
      rootPath: input.rootPath, canonicalRoot: input.rootPath,
      ...(input.defaultProvider ? { defaultProvider: input.defaultProvider } : {}),
    }
    projects.push(created)
    return created
  },
  async listSessions(projectId: string) { return projectId === project.id ? [...sessions] : [] },
  async getSession(sessionId: string) { return sessions.find(item => item.id === sessionId) ?? session },
  async createSession(projectId: string, input: CreateSessionDto) {
    const created: CodeverSession = {
      id: `session-created-${sessions.length}`, gatewayId: gateway.id, projectId,
      title: input.title ?? 'Untitled task', state: 'idle', provider: input.provider,
      ...(input.providerSessionId ? { providerSessionId: input.providerSessionId } : {}),
      config: input.config, createdAt: '2026-07-18T08:04:00.000Z',
      updatedAt: '2026-07-18T08:04:00.000Z', lastEventSeq: 0,
    }
    sessions.push(created)
    return created
  },
  async getSessionEvents(_id: string, options: { after?: number; before?: number; limit?: number } = {}) {
    let selected = events
    if (options.after !== undefined) selected = selected.filter(event => event.seq > options.after!)
    if (options.before !== undefined) selected = selected.filter(event => event.seq < options.before!)
    const limit = options.limit ?? selected.length
    selected = options.after !== undefined ? selected.slice(0, limit) : selected.slice(-limit)
    const first = selected.at(0)?.seq
    const last = selected.at(-1)?.seq
    return {
      events: selected,
      nextAfter: last !== undefined && events.some(event => event.seq > last) ? last : null,
      previousBefore: first !== undefined && events.some(event => event.seq < first) ? first : null,
    }
  },
  subscribeSession(_id: string, callback: (event: SessionEventEnvelope) => void) {
    subscribers.add(callback)
    return () => subscribers.delete(callback)
  },
  async discoverProviderSessions() {
    return {
      projectId: project.id, provider: session.provider, discoverySupported: true,
      models: [{ id: 'scripted-model', name: 'Scripted model', supportedReasoningLevels: [{ effort: 'medium' }, { effort: 'high' }] }], permissionModes: ['default', 'bypassPermissions'],
      capabilities: { resume: true, cancel: true, changeModel: true, changeMode: true, fork: false, retry: false, editHistory: false, listBranches: false, attachFiles: true },
      sessions: [
        { provider: session.provider, providerSessionId: 'provider-session-e2e', title: session.title!, updatedAt: session.updatedAt, codeverSessionId: session.id, state: session.state },
        { provider: session.provider, providerSessionId: 'provider-session-inactive', title: 'Local Codex investigation', firstMessage: 'Investigate the local build failure', updatedAt: '2026-07-18T07:30:00.000Z' },
      ],
    }
  },
  async listSessionAttachments() { return { sessionId: session.id, attachments: [...attachments] } },
  sendMessage(_id: string, input: SendMessageDto) {
    lastSentInput = input
    return new Promise(resolve => { pendingSend = { input, resolve } })
  },
  async uploadAttachment(_id: string, file: File, options: {
    onProgress?: (receivedBytes: number, sizeBytes: number) => void
    onStage?: (stage: 'uploading' | 'storing') => void
    onUpload?: (upload: AttachmentUploadDto) => void
  } = {}) {
    const attachmentId = `attachment-upload-${attachments.length + 1}`
    const uploading: AttachmentUploadDto = {
      attachmentId, sessionId: session.id, filename: file.name,
      mimeType: file.type || 'application/octet-stream', sizeBytes: file.size,
      receivedBytes: 0, status: 'uploading',
    }
    options.onUpload?.(uploading)
    options.onStage?.('uploading')
    options.onProgress?.(file.size, file.size)
    options.onStage?.('storing')
    const completed: AttachmentUploadDto = { ...uploading, receivedBytes: file.size, status: 'ready' }
    options.onUpload?.(completed)
    attachments.push({
      attachmentId, sessionId: session.id, filename: file.name,
      mimeType: uploading.mimeType, sizeBytes: file.size,
      createdAt: '2026-07-18T08:03:00.000Z', status: 'ready',
    })
    return completed
  },
  async cancelAttachment() { throw new Error('No active E2E upload') },
  async exportSessionFile(_id: string, path: string) {
    exportedPath = path
    const attachment: SessionAttachmentDto = {
      attachmentId: 'attachment-exported', sessionId: session.id, filename: 'codever-client.apk',
      mimeType: 'application/vnd.android.package-archive', sizeBytes: 9,
      createdAt: '2026-07-18T08:02:00.000Z', status: 'ready',
    }
    if (!attachments.some(value => value.attachmentId === attachment.attachmentId)) attachments.push(attachment)
    return attachment
  },
  async downloadAttachment() { return new Blob(['apk-bytes'], { type: 'application/vnd.android.package-archive' }) },
  async setSessionArchived(_id: string, archived: boolean) {
    archiveUpdates += 1
    if (archived) session.archivedAt = new Date().toISOString()
    else delete session.archivedAt
  },
  async patchSessionConfig(_id: string, patch: PatchSessionConfigDto) {
    lastConfig = patch
    session.model = patch.model ?? undefined
    session.mode = patch.mode ?? undefined
    session.config = patch.config
    return session
  },
  async cancelSession() {
    if (!activeTurnId) return
    append({ kind: 'turn_finished', status: 'cancelled', meta: { turnId: activeTurnId, source: 'live' } })
    append({ kind: 'session_state', state: 'idle', reason: 'turn_cancelled', meta: { source: 'synthetic' } })
    activeTurnId = ''
  },
  async resolveDecision(_id: string, decisionId: string, value: unknown) {
    append({ kind: 'decision_resolved', decisionId, value: value as boolean, optionId: value === true ? 'yes' : 'no', meta: { source: 'live' } })
  },
  async deleteSessionAttachments(_id: string, attachmentIds: string[]) {
    for (const id of attachmentIds) {
      const index = attachments.findIndex(item => item.attachmentId === id)
      if (index >= 0) attachments.splice(index, 1)
    }
    return { commandId: 'delete-attachments', status: 'succeeded' }
  },
} as unknown as CodeverApi

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: `/projects/${gateway.id}/${project.id}` },
    { path: '/projects', name: 'projects', component: GatewayListView },
    { path: '/machines', name: 'machines', component: MachineListView },
    { path: '/gateways/:gatewayId', name: 'gateway', component: GatewayView },
    { path: '/settings', component: SettingsView },
    { path: '/projects/:gatewayId/:projectId', name: 'project', component: ProjectView },
    { path: '/projects/:gatewayId/:projectId/sessions/:sessionId', name: 'session', component: SessionView },
  ],
})

declare global {
  interface Window {
    __CODEVER_E2E__: {
      completeTurn(): void
      completeTurnWithWakeup(): void
      startLongTurn(): void
      finishTurnOffline(text: string): void
      failTurn(message: string): void
      exportedPath(): string
      setConnection(state: 'connected' | 'disconnected'): void
      setConnectionError(message: string): void
      requestDecision(): void
      lastConfig(): PatchSessionConfigDto | undefined
      archiveUpdates(): number
      lastSentInput(): SendMessageDto | undefined
      nativeSecretGet(account: string): Promise<string | undefined>
      nativeSecretSet(account: string, value: string): Promise<void>
      nativeSecretDelete(account: string): Promise<void>
      approveSecondComputer(): void
      reportRuntimeError(): void
    }
  }
}

window.__CODEVER_E2E__ = {
  reportRuntimeError() {
    const error = new Error('Synthetic native listener failure')
    window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }))
  },
  approveSecondComputer() { secondGatewayAuthorized = true },
  completeTurn() {
    if (!pendingSend) throw new Error('No pending Client message')
    const { input, resolve } = pendingSend
    pendingSend = undefined
    const turnId = `turn-${input.clientMessageId}`
    append(userMessageEvent(input, turnId))
    append({ kind: 'session_state', state: 'querying', meta: { source: 'synthetic' } })
    append({ kind: 'turn_started', meta: { turnId, source: 'live' } })
    append({ kind: 'assistant_text_delta', text: 'First ', meta: { turnId, source: 'live' } })
    append({ kind: 'assistant_text_delta', text: 'reply.', meta: { turnId, source: 'live' } })
    append({ kind: 'turn_finished', status: 'success', meta: { turnId, source: 'live' } })
    append({ kind: 'session_state', state: 'idle', reason: 'turn_success', meta: { source: 'synthetic' } })
    resolve({ commandId: input.clientMessageId, status: 'succeeded' })
  },
  completeTurnWithWakeup() {
    if (!pendingSend) throw new Error('No pending Client message')
    const { input, resolve } = pendingSend
    pendingSend = undefined
    const turnId = `turn-${input.clientMessageId}`
    append(userMessageEvent(input, turnId), false)
    append({ kind: 'session_state', state: 'querying', meta: { source: 'synthetic' } })
    append({ kind: 'turn_started', meta: { turnId, source: 'live' } }, false)
    append({ kind: 'assistant_text_delta', text: 'Recovered from ', meta: { turnId, source: 'live' } }, false)
    append({ kind: 'assistant_text_delta', text: 'the durable journal.', meta: { turnId, source: 'live' } }, false)
    append({ kind: 'turn_finished', status: 'success', meta: { turnId, source: 'live' } }, false)
    // Only the final durable state crosses Matrix. Its sequence gap tells the
    // client to fetch all intervening events from the Gateway journal.
    append({ kind: 'session_state', state: 'idle', reason: 'turn_success', meta: { source: 'synthetic' } })
    resolve({ commandId: input.clientMessageId, status: 'succeeded' })
  },
  startLongTurn() {
    if (!pendingSend) throw new Error('No pending Client message')
    const { input, resolve } = pendingSend
    pendingSend = undefined
    activeTurnId = `turn-${input.clientMessageId}`
    append(userMessageEvent(input, activeTurnId))
    append({ kind: 'session_state', state: 'querying', meta: { source: 'synthetic' } })
    append({ kind: 'turn_started', meta: { turnId: activeTurnId, source: 'live' } })
    append({ kind: 'tool', phase: 'started', toolCallId: 'long-tool', toolName: 'Bash', category: 'execute', input: { command: 'long task' }, meta: { turnId: activeTurnId, source: 'live' } })
    resolve({ commandId: input.clientMessageId, status: 'gateway_accepted' })
  },
  finishTurnOffline(text) {
    if (!activeTurnId) throw new Error('No active E2E turn')
    append({ kind: 'assistant_text_delta', text, meta: { turnId: activeTurnId, source: 'live' } })
    append({ kind: 'turn_finished', status: 'success', meta: { turnId: activeTurnId, source: 'live' } })
    append({ kind: 'session_state', state: 'idle', reason: 'turn_success', meta: { source: 'synthetic' } })
    activeTurnId = ''
  },
  failTurn(message) {
    if (!pendingSend) throw new Error('No pending Client message')
    const { input, resolve } = pendingSend
    pendingSend = undefined
    const turnId = `turn-${input.clientMessageId}`
    append(userMessageEvent(input, turnId))
    append({ kind: 'session_state', state: 'querying', meta: { source: 'synthetic' } })
    append({ kind: 'turn_started', meta: { turnId, source: 'live' } })
    append({ kind: 'status', level: 'error', message, meta: { turnId, source: 'synthetic' } })
    append({ kind: 'turn_finished', status: 'error', summary: message, meta: { turnId, source: 'live' } })
    append({ kind: 'session_state', state: 'error', reason: 'turn_error', meta: { source: 'synthetic' } })
    resolve({ commandId: input.clientMessageId, status: 'succeeded' })
  },
  exportedPath: () => exportedPath,
  setConnection(state) {
    mockConnectionState = state
    clientSession.connectionState.value = state
    for (const callback of connectionSubscribers) callback(state)
    if (state === 'connected') {
      const queued = offlineBacklog.splice(0)
      for (const envelope of queued) {
        // Matrix timeline replay may race explicit history catch-up. Deliver
        // each envelope twice so the UI journey enforces event idempotency.
        for (const subscriber of subscribers) {
          subscriber(envelope)
          subscriber(envelope)
        }
      }
    }
  },
  setConnectionError(message) {
    mockConnectionState = 'disconnected'
    clientSession.connectionState.value = 'disconnected'
    clientSession.initializationError.value = message
    for (const callback of connectionSubscribers) callback('disconnected')
  },
  requestDecision() {
    append({
      kind: 'decision_request', decisionId: 'decision-e2e', title: 'Install the APK?', body: 'Continue on the connected phone?',
      required: true, source: 'agent', options: [{ id: 'yes', label: 'Install', value: true }, { id: 'no', label: 'Stop', value: false }],
    })
  },
  lastConfig: () => lastConfig,
  archiveUpdates: () => archiveUpdates,
  lastSentInput: () => lastSentInput,
  nativeSecretGet: account => nativeSecrets.get(account),
  nativeSecretSet: (account, value) => nativeSecrets.set(account, value),
  nativeSecretDelete: account => nativeSecrets.delete(account),
}

clientSession.reconnect = async () => {
  mockConnectionState = 'connected'
  clientSession.connectionState.value = 'connected'
  clientSession.initializationError.value = ''
  for (const callback of connectionSubscribers) callback('connected')
}
clientSession.reauthenticate = async () => {
  mockConnectionState = 'connected'
  clientSession.connectionState.value = 'connected'
  clientSession.initializationError.value = ''
  for (const callback of connectionSubscribers) callback('connected')
}
clientSession.connectionState.value = 'connected'
const app = createApp(App)
app.provide(codeverApiKey, api)
app.use(router)
await router.isReady()
app.mount('#app')

function append(event: SessionEventEnvelope['event'], publish = true): void {
  sequence += 1
  const envelope: SessionEventEnvelope = {
    schemaVersion: 1, gatewayId: gateway.id, projectId: project.id, sessionId: session.id,
    seq: sequence, eventId: `event-${sequence}`, timestamp: `2026-07-18T08:00:${String(sequence).padStart(2, '0')}.000Z`, event,
  }
  events.push(envelope)
  session.lastEventSeq = sequence
  if (publish && mockConnectionState === 'connected') {
    for (const subscriber of subscribers) subscriber(envelope)
  } else if (publish) {
    offlineBacklog.push(envelope)
  }
}

function userMessageEvent(input: SendMessageDto, turnId: string): SessionEventEnvelope['event'] {
  return {
    kind: 'user_message', text: input.text, clientMessageId: input.clientMessageId,
    meta: { turnId, source: 'live' },
    ...(input.attachmentIds?.length ? { attachments: input.attachmentIds.map(id => {
      const attachment = attachments.find(item => item.attachmentId === id)
      if (!attachment) throw new Error(`Unknown E2E attachment ${id}`)
      return { id, filename: attachment.filename, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes }
    }) } : {}),
  }
}
