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
import type { CodeverApi } from '../src/api/codeverApi'
import { codeverApiKey } from '../src/api/codeverApi'
import { MatrixGatewayClientClosedError } from '../src/api/matrixGatewayClient'
import ConversationTimeline from '../src/components/timeline/ConversationTimeline.vue'
import SessionControls from '../src/components/SessionControls.vue'
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
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('session view', () => {
  it('shows a conversation loader when only cached Session metadata is available', async () => {
    const sessionId = 'session-metadata-only'
    const seed = await mountSession(fakeApi(sessionId, []), sessionId)
    seed.unmount()

    const pendingSession = deferred<CodeverSession>()
    const wrapper = await mountSession(fakeApi(sessionId, [], {
      getSession: vi.fn(() => pendingSession.promise),
    }), sessionId, false)
    await flushPromises()

    expect(wrapper.find('.session-load-state').text()).toContain('Loading conversation')
    wrapper.unmount()
  })

  it('shows a cached conversation while the remote refresh is still pending', async () => {
    const sessionId = 'session-offline-first'
    const cachedEvents = [assistantEvent(sessionId, 1, 'turn-1')]
    const seed = await mountSession(fakeApi(sessionId, cachedEvents), sessionId)
    seed.unmount()

    const pendingSession = deferred<CodeverSession>()
    const pendingHistory = deferred<HistoryPage>()
    const wrapper = await mountSession(fakeApi(sessionId, cachedEvents, {
      getSession: vi.fn(() => pendingSession.promise),
      getSessionEvents: vi.fn(() => pendingHistory.promise),
    }), sessionId, false)
    await flushPromises()

    expect(wrapper.find('.session-load-state').exists()).toBe(false)
    expect(wrapper.getComponent(ConversationTimeline).props('events')).toHaveLength(1)
    wrapper.unmount()
  })

  it('stops an abandoned Session load before it requests history', async () => {
    const sessionId = 'session-abandoned-navigation'
    const pendingSession = deferred<CodeverSession>()
    const getSessionEvents = vi.fn(async () => ({
      events: [], nextAfter: null, previousBefore: null,
    }))
    const api = fakeApi(sessionId, [], {
      getSession: vi.fn(() => pendingSession.promise),
      getSessionEvents,
    })
    const wrapper = await mountSession(api, sessionId, false)
    await flushPromises()

    expect(api.getSession).toHaveBeenCalledOnce()
    wrapper.unmount()
    pendingSession.resolve(sessionRecord(sessionId, []))
    await flushPromises()

    expect(getSessionEvents).not.toHaveBeenCalled()
  })

  it('rebinds and refreshes cached session state without surfacing cancellation from a replaced client', async () => {
    const sessionId = 'session-reconnect-race'
    const cached = assistantEvent(sessionId, 1, 'cached-turn')
    const recovered = assistantEvent(sessionId, 2, 'recovered-turn')
    const seed = await mountSession(fakeApi(sessionId, [cached]), sessionId)
    seed.unmount()

    const staleSession = deferred<CodeverSession>()
    const staleControls = deferred<never>()
    let notifyConnection: ((state: 'connected' | 'reconnecting') => void) | undefined
    const subscribeSession = vi.fn(() => () => undefined)
    const getSession = vi.fn()
      .mockImplementationOnce(() => staleSession.promise)
      .mockResolvedValue(sessionRecord(sessionId, [cached, recovered]))
    const discoverProviderSessions = vi.fn()
      .mockImplementationOnce(() => staleControls.promise)
      .mockResolvedValue({
        projectId: project.id, provider: 'codex', discoverySupported: false,
        models: [], permissionModes: [], controls: [], sessions: [],
        capabilities: {
          resume: false, cancel: true, changeModel: false, changeMode: false,
          fork: false, retry: false, editHistory: false, listBranches: false, attachFiles: false,
        },
      })
    const api = fakeApi(sessionId, [cached], {
      getSession,
      getSessionEvents: vi.fn(async () => ({
        events: [cached, recovered], nextAfter: null, previousBefore: null,
      })),
      discoverProviderSessions,
      subscribeSession,
      subscribeConnection: vi.fn((subscriber: (state: 'connected' | 'reconnecting') => void) => {
        notifyConnection = subscriber
        subscriber('connected')
        return () => undefined
      }),
    })
    const wrapper = await mountSession(api, sessionId, false)
    await flushPromises()

    expect(getSession).toHaveBeenCalledOnce()
    expect(discoverProviderSessions).toHaveBeenCalledOnce()
    expect(subscribeSession).toHaveBeenCalledOnce()

    notifyConnection?.('reconnecting')
    await flushPromises()
    expect(wrapper.get('.connection-banner strong').text()).toBe('Reconnecting')
    expect(wrapper.get('.connection-banner').text()).toContain('Cached messages remain available')
    notifyConnection?.('connected')
    await flushPromises()
    staleSession.reject(new MatrixGatewayClientClosedError())
    staleControls.reject(new MatrixGatewayClientClosedError())
    await flushPromises()

    expect(getSession).toHaveBeenCalledTimes(2)
    expect(discoverProviderSessions).toHaveBeenCalledTimes(2)
    expect(subscribeSession).toHaveBeenCalledTimes(2)
    expect(wrapper.getComponent(ConversationTimeline).props('events')).toEqual([cached, recovered])
    expect(wrapper.getComponent(SessionControls).props('error')).toBe('')
    expect(wrapper.find('.inline-alert').exists()).toBe(false)
    wrapper.unmount()
  })

  it('renders a durable live event without reopening the session', async () => {
    const sessionId = 'session-live-update'
    let subscriber: ((event: SessionEventEnvelope) => void) | undefined
    const api = fakeApi(sessionId, [], {
      subscribeSession: vi.fn((_id: string, callback: (event: SessionEventEnvelope) => void) => {
        subscriber = callback
        return () => undefined
      }),
    })
    const wrapper = await mountSession(api, sessionId)

    subscriber?.(assistantEvent(sessionId, 1, 'turn-1'))
    await flushPromises()

    expect(wrapper.getComponent(ConversationTimeline).props('events')).toHaveLength(1)
    wrapper.unmount()
  })

  it('fills the journal gap when the first Matrix wake-up is not sequence one', async () => {
    const sessionId = 'session-first-wakeup-gap'
    let subscriber: ((event: SessionEventEnvelope) => void) | undefined
    const first = event(sessionId, 1)
    const reply = assistantEvent(sessionId, 2, 'turn-1')
    const terminal = {
      ...event(sessionId, 3),
      event: { kind: 'session_state' as const, state: 'idle' as const, reason: 'turn_success' },
    }
    const getSessionEvents = vi.fn()
      .mockResolvedValueOnce({ events: [], nextAfter: null, previousBefore: null })
      .mockResolvedValueOnce({ events: [first, reply, terminal], nextAfter: null, previousBefore: null })
    const api = fakeApi(sessionId, [], {
      getSessionEvents,
      subscribeSession: vi.fn((_id: string, callback: (event: SessionEventEnvelope) => void) => {
        subscriber = callback
        return () => undefined
      }),
    })
    const wrapper = await mountSession(api, sessionId)

    subscriber?.(terminal)
    await flushPromises()

    expect(getSessionEvents).toHaveBeenLastCalledWith(sessionId, { after: 0, limit: 256 })
    expect(wrapper.getComponent(ConversationTimeline).props('events')).toEqual([first, reply, terminal])
    wrapper.unmount()
  })

  it('shows an optimistic user bubble and clears the Android composer before acceptance', async () => {
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
    const timeline = wrapper.getComponent(ConversationTimeline)
    expect(timeline.props('pendingMessages')).toMatchObject([{
      sessionId: 'session-composer', text: 'hello from Android', status: 'sending',
    }])
    expect(api.sendMessage).toHaveBeenCalledWith('session-composer', expect.objectContaining({
      text: 'hello from Android', attachmentIds: [], sendWhenOnline: undefined,
      clientMessageId: expect.stringMatching(/^message_/),
    }))

    pendingSend.resolve({ commandId: 'command-1', status: 'succeeded' })
    await flushPromises()
    expect(timeline.props('pendingMessages')).toMatchObject([{ status: 'accepted' }])
    wrapper.unmount()
  })

  it('ends the send transaction at acceptance without waiting for history catch-up', async () => {
    const pendingSend = deferred<unknown>()
    const pendingHistory = deferred<HistoryPage>()
    const api = fakeApi('session-accepted', [], {
      sendMessage: vi.fn(() => pendingSend.promise),
      getSessionEvents: vi.fn()
        .mockResolvedValueOnce({ events: [], nextAfter: null, previousBefore: null })
        .mockImplementationOnce(() => pendingHistory.promise),
    })
    const wrapper = await mountSession(api, 'session-accepted')

    const composer = wrapper.get<HTMLTextAreaElement>('.composer textarea')
    await composer.setValue('first message')
    await wrapper.get('.send-button').trigger('click')
    pendingSend.resolve({ commandId: 'command-1', status: 'succeeded' })
    await flushPromises()

    expect(wrapper.getComponent(ConversationTimeline).props('pendingMessages')).toMatchObject([{ status: 'accepted' }])
    await composer.setValue('second message')
    expect(wrapper.get<HTMLButtonElement>('.send-button').element.disabled).toBe(false)

    pendingHistory.resolve({ events: [], nextAfter: null, previousBefore: null })
    await flushPromises()
    wrapper.unmount()
  })

  it('polls the durable journal after acceptance when Matrix wake-ups are missed', async () => {
    vi.useFakeTimers()
    const sessionId = 'session-missed-wakeup'
    const reply = assistantEvent(sessionId, 2, 'turn-1')
    const terminal = {
      ...event(sessionId, 3),
      event: { kind: 'session_state' as const, state: 'idle' as const, reason: 'turn_success' },
    }
    const getSessionEvents = vi.fn()
      .mockResolvedValueOnce({ events: [], nextAfter: null, previousBefore: null })
      .mockResolvedValueOnce({ events: [reply, terminal], nextAfter: null, previousBefore: null })
    const api = fakeApi(sessionId, [], { getSessionEvents })
    const wrapper = await mountSession(api, sessionId)

    await wrapper.get<HTMLTextAreaElement>('.composer textarea').setValue('recover the reply')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()

    expect(getSessionEvents).toHaveBeenCalledTimes(2)
    expect(wrapper.getComponent(ConversationTimeline).props('events')).toEqual([reply, terminal])
    wrapper.unmount()
  })

  it('does not let an older idle history event overwrite authoritative querying state', async () => {
    const sessionId = 'session-authoritative-querying'
    const staleIdle = {
      ...event(sessionId, 2),
      event: { kind: 'session_state' as const, state: 'idle' as const, reason: 'old_turn_finished' },
    }
    const querying: CodeverSession = {
      ...sessionRecord(sessionId, []), state: 'querying', lastEventSeq: 3,
    }
    const wrapper = await mountSession(fakeApi(sessionId, [], {
      getSession: vi.fn(async () => querying),
      getSessionEvents: vi.fn(async () => ({ events: [staleIdle], nextAfter: null, previousBefore: null })),
    }), sessionId)

    expect(wrapper.get('[aria-label="Stop"]').classes()).toContain('send-button--stop')
    wrapper.unmount()
  })

  it('offers Stop as soon as the Gateway accepts a message', async () => {
    const sessionId = 'session-stop-after-acceptance'
    const wrapper = await mountSession(fakeApi(sessionId, []), sessionId)

    await wrapper.get<HTMLTextAreaElement>('.composer textarea').setValue('keep working')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(wrapper.get('[aria-label="Stop"]').classes()).toContain('send-button--stop')
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

    expect(wrapper.getComponent(ConversationTimeline).props('events')).toHaveLength(5)
    await wrapper.get('.conversation-pane').trigger('scroll')

    expect(getSessionEvents).toHaveBeenCalledTimes(1)
    expect(wrapper.getComponent(ConversationTimeline).props('events')).toHaveLength(6)
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
): CodeverApi & Record<string, ReturnType<typeof vi.fn>> {
  const session = sessionRecord(sessionId, events)
  return {
    connectionState: 'connected',
    subscribeConnection: vi.fn((subscriber: (state: string) => void) => {
      subscriber('connected')
      return () => undefined
    }),
    rememberRoute: vi.fn(),
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
      controls: [],
      capabilities: {
        resume: false, cancel: true, changeModel: false, changeMode: false,
        fork: false, retry: false, editHistory: false, listBranches: false, attachFiles: false,
      },
      sessions: [],
    })),
    sendMessage: vi.fn(async () => ({ commandId: 'command-1', status: 'succeeded' })),
    cancelSession: vi.fn(async () => ({ commandId: 'cancel-1', status: 'succeeded' })),
    ...overrides,
  } as unknown as CodeverApi & Record<string, ReturnType<typeof vi.fn>>
}

function sessionRecord(sessionId: string, events: SessionEventEnvelope[]): CodeverSession {
  return {
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
}

async function mountSession(api: CodeverApi, sessionId: string, settle = true) {
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
      provide: { [codeverApiKey as symbol]: api },
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
