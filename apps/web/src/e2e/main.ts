import type {
  CodeverSession,
  Gateway,
  PatchSessionConfigDto,
  Project,
  SendMessageDto,
  SessionAttachmentDto,
  SessionEventEnvelope,
} from '@codever/protocol'
import { createApp, defineComponent, h } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from '../App.vue'
import { relayApiKey, type RelayApi } from '../api/relayApi'
import { clientSession } from '../state/clientSession'
import ProjectView from '../views/ProjectView.vue'
import SessionView from '../views/SessionView.vue'
import '../styles.css'

const gateway: Gateway = {
  id: 'gateway-e2e', workspaceId: 'workspace-e2e', name: 'My computer', platform: 'windows', version: 'e2e',
  capabilities: { protocolVersions: [1], providers: ['scripted-agent'], features: ['file.export', 'attachment.download'] },
  status: 'online', lastSeenAt: '2026-07-18T08:00:00.000Z',
}
const project: Project = {
  id: 'project-e2e', gatewayId: gateway.id, name: 'Codever', rootPath: 'D:/workspace', canonicalRoot: 'D:/workspace',
  defaultProvider: 'scripted-agent',
}
const session: CodeverSession = {
  id: 'session-e2e', gatewayId: gateway.id, projectId: project.id, title: 'Build Android client', state: 'idle',
  provider: 'scripted-agent', config: {}, createdAt: '2026-07-18T08:00:00.000Z',
  updatedAt: '2026-07-18T08:01:00.000Z', lastEventSeq: 4,
}

let sequence = 0
const events: SessionEventEnvelope[] = []
const subscribers = new Set<(event: SessionEventEnvelope) => void>()
const connectionSubscribers = new Set<(state: 'connected' | 'disconnected') => void>()
let pendingSend: { input: SendMessageDto; resolve: (value: unknown) => void } | undefined
let exportedPath = ''
let lastConfig: PatchSessionConfigDto | undefined
let archiveUpdates = 0
const attachments: SessionAttachmentDto[] = []

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
  async listGateways() { return [gateway] },
  async listProjects() { return [project] },
  async listSessions() { return [session] },
  async getSession() { return session },
  async getSessionEvents(_id: string, options: { after?: number; before?: number; limit?: number } = {}) {
    let selected = events
    if (options.after !== undefined) selected = selected.filter(event => event.seq > options.after!)
    if (options.before !== undefined) selected = selected.filter(event => event.seq < options.before!)
    const limit = options.limit ?? selected.length
    selected = options.after !== undefined ? selected.slice(0, limit) : selected.slice(-limit)
    return { events: selected, nextAfter: null, previousBefore: null }
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
      sessions: [{ provider: session.provider, providerSessionId: 'provider-session-e2e', title: session.title!, updatedAt: session.updatedAt, codeverSessionId: session.id, state: session.state }],
    }
  },
  async listSessionAttachments() { return { sessionId: session.id, attachments: [...attachments] } },
  sendMessage(_id: string, input: SendMessageDto) {
    return new Promise(resolve => { pendingSend = { input, resolve } })
  },
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
  async cancelSession() {},
  async resolveDecision(_id: string, decisionId: string, value: unknown) {
    append({ kind: 'decision_resolved', decisionId, value: value as boolean, optionId: value === true ? 'yes' : 'no', meta: { source: 'live' } })
  },
  async deleteSessionAttachments() {},
} as unknown as RelayApi

const Placeholder = defineComponent({ setup: () => () => h('main', { 'data-testid': 'machines-page' }, 'Machines') })
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: `/projects/${gateway.id}/${project.id}` },
    { path: '/projects', redirect: `/projects/${gateway.id}/${project.id}` },
    { path: '/machines', component: Placeholder },
    { path: '/settings', component: Placeholder },
    { path: '/projects/:gatewayId/:projectId', name: 'project', component: ProjectView },
    { path: '/projects/:gatewayId/:projectId/sessions/:sessionId', name: 'session', component: SessionView },
  ],
})

declare global {
  interface Window {
    __CODEVER_E2E__: {
      completeTurn(): void
      exportedPath(): string
      setConnection(state: 'connected' | 'disconnected'): void
      requestDecision(): void
      lastConfig(): PatchSessionConfigDto | undefined
      archiveUpdates(): number
    }
  }
}

window.__CODEVER_E2E__ = {
  completeTurn() {
    if (!pendingSend) throw new Error('No pending Client message')
    const { input, resolve } = pendingSend
    pendingSend = undefined
    const turnId = `turn-${input.clientMessageId}`
    append({ kind: 'user_message', text: input.text, clientMessageId: input.clientMessageId, meta: { turnId, source: 'live' } })
    append({ kind: 'turn_started', meta: { turnId, source: 'live' } })
    append({ kind: 'assistant_text_delta', text: 'First ', meta: { turnId, source: 'live' } })
    append({ kind: 'assistant_text_delta', text: 'reply.', meta: { turnId, source: 'live' } })
    append({ kind: 'turn_finished', status: 'success', meta: { turnId, source: 'live' } })
    resolve({ commandId: input.clientMessageId, status: 'succeeded' })
  },
  exportedPath: () => exportedPath,
  setConnection(state) {
    clientSession.connectionState.value = state
    for (const callback of connectionSubscribers) callback(state)
  },
  requestDecision() {
    append({
      kind: 'decision_request', decisionId: 'decision-e2e', title: 'Install the APK?', body: 'Continue on the connected phone?',
      required: true, source: 'agent', options: [{ id: 'yes', label: 'Install', value: true }, { id: 'no', label: 'Stop', value: false }],
    })
  },
  lastConfig: () => lastConfig,
  archiveUpdates: () => archiveUpdates,
}

clientSession.connectionState.value = 'connected'
const app = createApp(App)
app.provide(relayApiKey, api)
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
  if (publish) for (const subscriber of subscribers) subscriber(envelope)
}
