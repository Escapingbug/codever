import type { CodeverSession, Gateway, Project } from '@codever/protocol'
import { computed, inject, reactive, ref } from 'vue'
import { RelayApi, relayApiKey } from '../api/relayApi'

const gateways = ref<Gateway[]>([])
const projectsByGateway = reactive<Record<string, Project[]>>({})
const sessionsByProject = reactive<Record<string, CodeverSession[]>>({})
const pending = reactive(new Set<string>())
const errors = reactive<Record<string, string | undefined>>({})
let workspaceLoad: Promise<void> | undefined

export function useCodeverState() {
  const injectedApi = inject(relayApiKey)
  if (!injectedApi) throw new Error('RelayApi was not provided')
  const api: RelayApi = injectedApi

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
      await load('gateways', () => api.listGateways(), (value) => { gateways.value = value })
      await Promise.all(gateways.value.map((gateway) => load(
        `projects:${gateway.id}`,
        () => api.listProjects(gateway.id),
        (value) => { projectsByGateway[gateway.id] = value },
      )))
    })()
    try {
      await workspaceLoad
    } finally {
      workspaceLoad = undefined
    }
  }

  return {
    api,
    gateways,
    projectsByGateway,
    sessionsByProject,
    pending: computed(() => pending),
    errors,
    loadWorkspace,
    loadGateways: () => load('gateways', () => api.listGateways(), (value) => { gateways.value = value }),
    loadProjects: (gatewayId: string) => load(
      `projects:${gatewayId}`,
      () => api.listProjects(gatewayId),
      (value) => { projectsByGateway[gatewayId] = value },
    ),
    loadSessions: (projectId: string) => load(
      `sessions:${projectId}`,
      () => api.listSessions(projectId),
      (value) => { sessionsByProject[projectId] = value },
    ),
    replaceSession: (session: CodeverSession) => {
      const sessions = sessionsByProject[session.projectId]
      if (!sessions) return
      const index = sessions.findIndex((item) => item.id === session.id)
      if (index >= 0) sessions[index] = session
      else sessions.unshift(session)
    },
  }
}

export function gatewayIsMutable(gateway: Gateway | undefined): boolean {
  return gateway?.status === 'online'
}

export type CodeverState = ReturnType<typeof useCodeverState>
export { RelayApi }
