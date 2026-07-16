import type { CodeverSession, Gateway, Project } from '@codever/protocol'
import { computed, inject, reactive, ref } from 'vue'
import { RelayApi, relayApiKey } from '../api/relayApi'

const gateways = ref<Gateway[]>([])
const projectsByGateway = reactive<Record<string, Project[]>>({})
const sessionsByProject = reactive<Record<string, CodeverSession[]>>({})
const pending = reactive(new Set<string>())
const errors = reactive<Record<string, string | undefined>>({})

export function useCodeverState() {
  const api = inject(relayApiKey)
  if (!api) throw new Error('RelayApi was not provided')

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

  return {
    api,
    gateways,
    projectsByGateway,
    sessionsByProject,
    pending: computed(() => pending),
    errors,
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
