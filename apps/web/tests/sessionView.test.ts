// @vitest-environment jsdom
import type {
  CodeverSession,
  Gateway,
  Project,
  SessionEventEnvelope,
} from '@codever/protocol'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RelayApi } from '../src/api/relayApi'
import { relayApiKey } from '../src/api/relayApi'
import ConversationTimeline from '../src/components/timeline/ConversationTimeline.vue'
import SessionView from '../src/views/SessionView.vue'

const gateway: Gateway = {
  id: 'gateway-session-view',
  workspaceId: 'workspace-1',
  name: 'Gateway',
  platform: 'linux',
  version: '1.0.0',
  capabilities: { protocolVersions: [1], providers: ['codex'], features: [] },
  status: 'online',
}
const project: Project = {
  id: 'project-session-view',
  gatewayId: gateway.id,
  name: 'Project',
  rootPath: '/project',
  canonicalRoot: '/project',
}

beforeEach(() => {
  HTMLElement.prototype.scrollTo = vi.fn()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('session view', () => {
  it('clears the Android composer before waiting for message acceptance', async () => {
    const pendingSend = deferred<unknown>()
    const api = fakeApi('session-composer', [], {
      sendMessage: vi.fn(() => pendingSend.promise),
    })
    const wrapper = await mountSession(api, 'session-composer')

    const composer = wrapper.get<HTMLTextAreaElement>('.composer textarea')
    await composer.setValue('hello from Android')
    await wrapper.get('.send-button').trigger('click')
    await wrapper.vm.$nextTick()

    expect(composer.element.value).toBe('')
    expect(api.sendMessage).toHaveBeenCalledWith('session-composer', {
      text: 'hello from Android', attachmentIds: [], sendWhenOnline: undefined,
    })

    pendingSend.resolve({ commandId: 'command-1', status: 'succeeded' })
    await flushPromises()
    wrapper.unmount()
  })

  it('does not start an older-page request while the initial history refresh is pending', async () => {
    const sessionId = 'session-history-race'
    const cachedEvents = Array.from({ length: 6 }, (_, index) => assistantEvent(sessionId, index + 1, `turn-${index + 1}`))
    const seed = await mountSession(fakeApi(sessionId, cachedEvents), sessionId)
    seed.unmount()

    const initialPage = deferred<HistoryPage>()
    const getSessionEvents = vi.fn(() => initialPage.promise)
    const wrapper = await mountSession(fakeApi(sessionId, cachedEvents, { getSessionEvents }), sessionId, false)
    await flushPromises()

    await wrapper.get('.conversation-pane').trigger('scroll')

    expect(getSessionEvents).toHaveBeenCalledTimes(1)
    initialPage.resolve({ events: cachedEvents, nextAfter: null, previousBefore: null })
    await flushPromises()
    wrapper.unmount()
  })

  it('treats a fully fetched new session as complete even when one reply has many events', async () => {
    const sessionId = 'session-complete-history'
    const completeReply = Array.from({ length: 30 }, (_, index) =>
      assistantEvent(sessionId, index + 1, 'turn-1'))
    const getSessionEvents = vi.fn(async () => ({
      events: completeReply, nextAfter: null, previousBefore: null,
    }))
    const wrapper = await mountSession(fakeApi(sessionId, completeReply, { getSessionEvents }), sessionId)

    expect(wrapper.getComponent(ConversationTimeline).props('events')).toHaveLength(30)
    await wrapper.get('.conversation-pane').trigger('scroll')
    expect(getSessionEvents).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })
})

interface HistoryPage {
  events: SessionEventEnvelope[]
  nextAfter: number | null
  previousBefore: number | null
}

function fakeApi(
  sessionId: string,
  events: SessionEventEnvelope[],
  overrides: Record<string, unknown> = {},
): RelayApi & Record<string, ReturnType<typeof vi.fn>> {
  const session: CodeverSession = {
    id: sessionId,
    gatewayId: gateway.id,
    projectId: project.id,
    title: 'Session',
    state: 'idle',
    provider: 'codex',
    config: {},
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    lastEventSeq: events.at(-1)?.seq ?? 0,
  }
  return {
    listGateways: vi.fn(async () => [gateway]),
    listProjects: vi.fn(async () => [project]),
    getSession: vi.fn(async () => session),
    listSessionAttachments: vi.fn(async () => ({ sessionId, attachments: [] })),
    getSessionEvents: vi.fn(async () => ({ events, nextAfter: null, previousBefore: null })),
    subscribeSession: vi.fn(() => () => undefined),
    discoverProviderSessions: vi.fn(async () => ({
      projectId: project.id,
      provider: 'codex',
      discoverySupported: false,
      models: [],
      permissionModes: [],
      capabilities: {
        resume: false, cancel: true, changeModel: false, changeMode: false,
        fork: false, retry: false, editHistory: false, listBranches: false, attachFiles: false,
      },
      sessions: [],
    })),
    sendMessage: vi.fn(async () => ({ commandId: 'command-1', status: 'succeeded' })),
    ...overrides,
  } as unknown as RelayApi & Record<string, ReturnType<typeof vi.fn>>
}

async function mountSession(api: RelayApi, sessionId: string, settle = true) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{
      path: '/gateways/:gatewayId/projects/:projectId/sessions/:sessionId',
      name: 'session',
      component: SessionView,
    }],
  })
  await router.push({ name: 'session', params: { gatewayId: gateway.id, projectId: project.id, sessionId } })
  await router.isReady()
  const wrapper = mount(SessionView, {
    global: {
      plugins: [router],
      provide: { [relayApiKey as symbol]: api },
      stubs: { ConversationTimeline: true, SessionControls: true, StatusDot: true },
    },
  })
  if (settle) await flushPromises()
  return wrapper
}

function event(sessionId: string, seq: number): SessionEventEnvelope {
  return {
    schemaVersion: 1,
    gatewayId: gateway.id,
    projectId: project.id,
    sessionId,
    seq,
    eventId: `${sessionId}-event-${seq}`,
    timestamp: `2026-07-17T00:00:${String(seq).padStart(2, '0')}.000Z`,
    event: { kind: 'status', level: 'info', message: String(seq) },
  }
}

function assistantEvent(sessionId: string, seq: number, turnId: string): SessionEventEnvelope {
  return {
    ...event(sessionId, seq),
    event: { kind: 'assistant_text_delta', text: String(seq), meta: { source: 'live', turnId } },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
