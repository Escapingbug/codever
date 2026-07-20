import type { CodeverSession, CreateProjectDto, Gateway, Project, ProviderSession, SessionEventEnvelope } from '@codever/protocol'
import { computed, inject, reactive, ref, shallowReactive } from 'vue'
import { CodeverApi, codeverApiKey } from '../api/codeverApi'
import { mergeSessionEvents } from '../sessionEvents'
import { readCached, writeCached } from './localCache'
import type { PendingUserMessage } from '../timeline/pendingMessage'
import { gatewayCanControl } from '../gatewayAccess'
import { mergeSessionSnapshot } from './sessionSnapshot'

const gateways = ref<Gateway[]>([])
const projectsByGateway = reactive<Record<string, Project[]>>({})
const sessionsByProject = reactive<Record<string, CodeverSession[]>>({})
const providerSessionsByProject = shallowReactive<Record<string, ProviderSession[]>>({})
const eventsBySession = shallowReactive<Record<string, SessionEventEnvelope[]>>({})
const pendingMessagesBySession = shallowReactive<Record<string, PendingUserMessage[]>>({})
const pending = reactive(new Set<string>())
const errors = reactive<Record<string, string | undefined>>({})
let workspaceLoad: Promise<void> | undefined
let workspaceHydration: Promise<void> | undefined

export function useCodeverState() {
  const injectedApi = inject(codeverApiKey)
  if (!injectedApi) throw new Error('CodeverApi was not provided')
  const api: CodeverApi = injectedApi

  async function load<T>(key: string, task: () => Promise<T>, apply: (value: T) => void): Promise<void> {
    pending.add(key)
    errors[key] = undefined
    try {
      apply(await task())
    } catch (error) {
      errors[key] = error instanceof Error ? error.message : 'Something went wrong'
    } finally {
      pending.delete(key)
    }
  }

  async function loadWorkspace(): Promise<void> {
    if (workspaceLoad) return workspaceLoad
    workspaceLoad = (async () => {
      await hydrateWorkspace()
      await loadGateways()
      await Promise.all(gateways.value.filter(gatewayCanControl).map((gateway) => load(
        `projects:${gateway.id}`,
        () => api.listProjects(gateway.id),
        (value) => {
          projectsByGateway[gateway.id] = value
          writeCached(`projects:${gateway.id}`, value)
        },
      )))
    })()
    try {
      await workspaceLoad
    } finally {
      workspaceLoad = undefined
    }
  }

  async function hydrateWorkspace(): Promise<void> {
    if (workspaceHydration) return workspaceHydration
    workspaceHydration = (async () => {
      const cachedGateways = await readCached<Gateway[]>('gateways') ?? []
      if (cachedGateways.length && !gateways.value.length) gateways.value = cachedGateways.map(markGatewayNegotiationStale)
      await Promise.all(cachedGateways.map(async gateway => {
        if (projectsByGateway[gateway.id]) return
        projectsByGateway[gateway.id] = await readCached<Project[]>(`projects:${gateway.id}`) ?? []
      }))
    })()
    try { await workspaceHydration } finally { workspaceHydration = undefined }
  }

  async function hydrateProject(projectId: string): Promise<void> {
    if (!sessionsByProject[projectId]) {
      sessionsByProject[projectId] = await readCached<CodeverSession[]>(`sessions:${projectId}`) ?? []
    }
    if (!providerSessionsByProject[projectId]) {
      providerSessionsByProject[projectId] = await readCached<ProviderSession[]>(`provider-sessions:${projectId}`) ?? []
    }
  }

  async function loadGateways(): Promise<void> {
    await load('gateways', () => api.listGateways(), value => {
      gateways.value = value
      writeCached('gateways', value)
    })
  }

  async function loadSessions(projectId: string): Promise<void> {
    await load(`sessions:${projectId}`, () => api.listSessions(projectId), value => {
      sessionsByProject[projectId] = value
      writeCached(`sessions:${projectId}`, value)
    })
  }

  async function createProject(gatewayId: string, input: CreateProjectDto): Promise<Project> {
    const key = `project:create:${gatewayId}`
    pending.add(key)
    errors[key] = undefined
    try {
      const project = await api.createProject(gatewayId, input)
      await load(`projects:${gatewayId}`, () => api.listProjects(gatewayId), (value) => {
        projectsByGateway[gatewayId] = value
      })
      return project
    } catch (error) {
      errors[key] = error instanceof Error ? error.message : 'Unable to create project'
      throw error
    } finally {
      pending.delete(key)
    }
  }

  return {
    api,
    gateways,
    projectsByGateway,
    sessionsByProject,
    providerSessionsByProject,
    eventsBySession,
    pendingMessagesBySession,
    pending: computed(() => pending),
    errors,
    loadWorkspace,
    hydrateWorkspace,
    hydrateProject,
    createProject,
    loadGateways,
    markGatewayMatrixVerified: (gatewayId: string) => {
      gateways.value = gateways.value.map(gateway => gateway.id !== gatewayId ? gateway : ({
        ...gateway,
        capabilities: {
          ...gateway.capabilities,
          metadata: { ...gateway.capabilities.metadata, matrixVerified: true },
        },
      }))
      writeCached('gateways', gateways.value)
    },
    loadProjects: (gatewayId: string) => load(
      `projects:${gatewayId}`,
      () => api.listProjects(gatewayId),
      (value) => {
        projectsByGateway[gatewayId] = value
        writeCached(`projects:${gatewayId}`, value)
      },
    ),
    loadSessions,
    replaceSession: (session: CodeverSession): CodeverSession => {
      const sessions = sessionsByProject[session.projectId] ?? []
      if (!sessionsByProject[session.projectId]) sessionsByProject[session.projectId] = sessions
      const index = sessions.findIndex((item) => item.id === session.id)
      const merged = mergeSessionSnapshot(index >= 0 ? sessions[index] : undefined, session)
      if (index >= 0) sessions[index] = merged
      else sessions.unshift(merged)
      writeCached(`sessions:${session.projectId}`, [...sessions])
      return merged
    },
    loadCachedProviderSessions: async (projectId: string) => {
      if (providerSessionsByProject[projectId]) return providerSessionsByProject[projectId]
      const cached = await readCached<ProviderSession[]>(`provider-sessions:${projectId}`) ?? []
      providerSessionsByProject[projectId] = cached
      return cached
    },
    replaceProviderSessions: (projectId: string, sessions: ProviderSession[]) => {
      providerSessionsByProject[projectId] = sessions
      writeCached(`provider-sessions:${projectId}`, sessions)
    },
    loadCachedSessionEvents: async (sessionId: string) => {
      if (eventsBySession[sessionId]) return eventsBySession[sessionId]
      const cached = await readCached<SessionEventEnvelope[]>(`session-events:${sessionId}`) ?? []
      eventsBySession[sessionId] = cached
      return cached
    },
    loadCachedPendingMessages: async (sessionId: string) => {
      if (pendingMessagesBySession[sessionId]) return pendingMessagesBySession[sessionId]
      const cached = await readCached<PendingUserMessage[]>(`pending-messages:${sessionId}`) ?? []
      pendingMessagesBySession[sessionId] = cached
      return cached
    },
    queuePendingMessage: (message: PendingUserMessage) => {
      const messages = [...(pendingMessagesBySession[message.sessionId] ?? [])]
      const index = messages.findIndex(item => item.clientMessageId === message.clientMessageId)
      if (index >= 0) messages[index] = message
      else messages.push(message)
      pendingMessagesBySession[message.sessionId] = messages
      writeCached(`pending-messages:${message.sessionId}`, messages)
    },
    markPendingMessageAccepted: (sessionId: string, clientMessageId: string) => {
      const messages = (pendingMessagesBySession[sessionId] ?? []).map(message =>
        message.clientMessageId === clientMessageId ? { ...message, status: 'accepted' as const } : message)
      pendingMessagesBySession[sessionId] = messages
      writeCached(`pending-messages:${sessionId}`, messages)
    },
    removePendingMessage: (sessionId: string, clientMessageId: string) => {
      const messages = (pendingMessagesBySession[sessionId] ?? [])
        .filter(message => message.clientMessageId !== clientMessageId)
      pendingMessagesBySession[sessionId] = messages
      writeCached(`pending-messages:${sessionId}`, messages)
    },
    reconcilePendingMessages: (sessionId: string, source: SessionEventEnvelope[]) => {
      const confirmed = new Set(source.flatMap(envelope =>
        envelope.event.kind === 'user_message' && envelope.event.clientMessageId
          ? [envelope.event.clientMessageId]
          : []))
      if (!confirmed.size) return
      const messages = (pendingMessagesBySession[sessionId] ?? [])
        .filter(message => !confirmed.has(message.clientMessageId))
      pendingMessagesBySession[sessionId] = messages
      writeCached(`pending-messages:${sessionId}`, messages)
    },
    mergeSessionEvents: (sessionId: string, events: SessionEventEnvelope[]) => {
      const snapshot = mergeSessionEvents(eventsBySession[sessionId] ?? [], events)
      eventsBySession[sessionId] = snapshot
      writeCached(`session-events:${sessionId}`, snapshot)
    },
  }
}

export function gatewayIsMutable(gateway: Gateway | undefined): boolean {
  return gateway?.status === 'online'
}

function markGatewayNegotiationStale(gateway: Gateway): Gateway {
  const metadata = { ...gateway.capabilities.metadata }
  delete metadata.matrixControlNegotiated
  delete metadata.matrixVerified
  return { ...gateway, capabilities: { ...gateway.capabilities, metadata } }
}

export type CodeverState = ReturnType<typeof useCodeverState>
export { CodeverApi }
