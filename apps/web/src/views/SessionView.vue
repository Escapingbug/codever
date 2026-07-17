<script setup lang="ts">
import type { CodeverSession, JsonValue, PatchSessionConfigDto, ProviderSessionListDto, SessionEventEnvelope } from '@codever/protocol'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ConversationTimeline from '../components/timeline/ConversationTimeline.vue'
import SessionControls from '../components/SessionControls.vue'
import StatusDot from '../components/StatusDot.vue'
import { gatewayIsMutable, useCodeverState } from '../state/codeverState'

const route = useRoute()
const router = useRouter()
const state = useCodeverState()
const gatewayId = computed(() => String(route.params.gatewayId))
const projectId = computed(() => String(route.params.projectId))
const sessionId = computed(() => String(route.params.sessionId))
const gateway = computed(() => state.gateways.value.find((item) => item.id === gatewayId.value))
const project = computed(() => (state.projectsByGateway[gatewayId.value] ?? []).find((item) => item.id === projectId.value))
// Protocol values are immutable snapshots; shallow refs avoid recursively unwrapping
// the deeply inferred Zod event union.
const session = shallowRef<CodeverSession>()
const provider = computed(() => session.value?.provider ?? '')
const providerCapabilities = shallowRef<ProviderSessionListDto>()
const events = shallowRef<SessionEventEnvelope[]>([])
const socketState = ref<'connected' | 'closed'>('closed')
const loadError = ref('')
const liveError = ref('')
const loading = ref(true)
const draft = ref('')
const sendWhenOnline = ref(false)
const sending = ref(false)
const savingControls = ref(false)
const updatingArchive = ref(false)
const showMobileControls = ref(false)
const submittingDecisionId = ref<string>()
const selectedEvent = shallowRef<SessionEventEnvelope>()
const timelineElement = ref<HTMLElement>()
let unsubscribeEvents: (() => void) | undefined
const HISTORY_PAGE_SIZE = 80
const HISTORY_LOAD_THRESHOLD = 96
const hasMoreBefore = ref(false)
const loadingOlder = ref(false)

const gatewayOnline = computed(() => gatewayIsMutable(gateway.value))
const liveConnected = computed(() => socketState.value === 'connected')
const canMutate = computed(() => gatewayOnline.value
  && liveConnected.value
  && session.value?.state !== 'closed'
  && session.value?.state !== 'offline')
const canSend = computed(() => canMutate.value || (!gatewayOnline.value && sendWhenOnline.value))
const connectionLabel = computed(() => {
  if (!gatewayOnline.value) return 'Gateway offline'
  if (socketState.value === 'connected') return 'Live'
  return 'Connection unavailable'
})

onMounted(() => {
  void state.loadGateways()
  void state.loadProjects(gatewayId.value)
})
watch(sessionId, () => void loadSession(), { immediate: true })
watch([projectId, provider], () => void loadProviderCapabilities(), { immediate: true })
onBeforeUnmount(() => unsubscribeEvents?.())

async function loadSession(): Promise<void> {
  unsubscribeEvents?.()
  unsubscribeEvents = undefined
  const requestedId = sessionId.value
  const memoryCached = state.eventsBySession[requestedId] ?? []
  events.value = memoryCached.slice(-HISTORY_PAGE_SIZE)
  hasMoreBefore.value = memoryCached.length > events.value.length
  loading.value = events.value.length === 0
  loadError.value = ''
  liveError.value = ''
  selectedEvent.value = undefined
  try {
    const persisted = await state.loadCachedSessionEvents(requestedId)
    if (requestedId !== sessionId.value) return
    if (persisted.length) {
      events.value = persisted.slice(-HISTORY_PAGE_SIZE)
      hasMoreBefore.value = persisted.length > events.value.length
      loading.value = false
    }
    session.value = await state.api.getSession(requestedId)
    state.replaceSession(session.value)
    startLiveConnection(requestedId)
    const page = await state.api.getSessionEvents(requestedId, { limit: HISTORY_PAGE_SIZE })
    const lastRemoteSeq = page.events.at(-1)?.seq ?? 0
    const liveSinceRequest = events.value.filter(event => event.seq > lastRemoteSeq)
    events.value = mergeEvents(page.events, liveSinceRequest)
    state.mergeSessionEvents(requestedId, page.events)
    hasMoreBefore.value = page.previousBefore !== null
    if (requestedId !== sessionId.value) return
    await scrollToLatest(false)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not load the session'
    if (events.value.length) liveError.value = `Could not refresh this cached conversation: ${message}`
    else loadError.value = message
  } finally {
    if (requestedId === sessionId.value) loading.value = false
  }
}

async function loadProviderCapabilities(): Promise<void> {
  if (!provider.value) return
  try {
    providerCapabilities.value = await state.api.discoverProviderSessions(projectId.value, provider.value)
  } catch {
    providerCapabilities.value = undefined
  }
}

function startLiveConnection(id: string): void {
  unsubscribeEvents = state.api.subscribeSession(id, event => {
    const nearBottom = isNearTimelineBottom()
    appendEvents([event])
    if (event.event.kind === 'session_state' && session.value) {
      session.value = { ...session.value, state: event.event.state, updatedAt: event.timestamp, lastEventSeq: event.seq }
      state.replaceSession(session.value)
    }
    if (nearBottom) void scrollToLatest()
  })
  socketState.value = 'connected'
}

function appendEvents(incoming: SessionEventEnvelope[]): void {
  const known = new Set(events.value.map((event) => event.eventId))
  const additions = incoming.filter((event) => event.sessionId === sessionId.value && !known.has(event.eventId))
  if (!additions.length) return
  events.value = [...events.value, ...additions].sort((a, b) => a.seq - b.seq)
  state.mergeSessionEvents(sessionId.value, additions)
}

function mergeEvents(...groups: SessionEventEnvelope[][]): SessionEventEnvelope[] {
  const merged = new Map<string, SessionEventEnvelope>()
  for (const event of groups.flat()) merged.set(event.eventId, event)
  return [...merged.values()].sort((left, right) => left.seq - right.seq)
}

async function scrollToLatest(smooth = true): Promise<void> {
  await nextTick()
  timelineElement.value?.scrollTo({ top: timelineElement.value.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
}

function isNearTimelineBottom(): boolean {
  const element = timelineElement.value
  return !element || element.scrollHeight - element.scrollTop - element.clientHeight < 120
}

async function handleTimelineScroll(): Promise<void> {
  const element = timelineElement.value
  if (!element || element.scrollTop > HISTORY_LOAD_THRESHOLD || loadingOlder.value || !hasMoreBefore.value) return
  await loadOlderEvents()
}

async function loadOlderEvents(): Promise<void> {
  const element = timelineElement.value
  const earliest = events.value.at(0)?.seq
  if (!element || earliest === undefined || loadingOlder.value) return
  loadingOlder.value = true
  const previousHeight = element.scrollHeight
  try {
    const cached = (state.eventsBySession[sessionId.value] ?? [])
      .filter(event => event.seq < earliest)
      .slice(-HISTORY_PAGE_SIZE)
    if (cached.length) {
      appendEvents(cached)
      hasMoreBefore.value = cached.at(0)!.seq > 1
    } else {
      const page = await state.api.getSessionEvents(sessionId.value, { before: earliest, limit: HISTORY_PAGE_SIZE })
      appendEvents(page.events)
      hasMoreBefore.value = page.previousBefore !== null
    }
    await nextTick()
    element.scrollTop += element.scrollHeight - previousHeight
  } catch (error) {
    liveError.value = error instanceof Error ? error.message : 'Earlier messages could not be loaded'
  } finally {
    loadingOlder.value = false
  }
}

async function sendMessage(): Promise<void> {
  const text = draft.value.trim()
  if (!text || !canSend.value || sending.value) return
  sending.value = true
  try {
    await state.api.sendMessage(sessionId.value, {
      text,
      sendWhenOnline: !gatewayOnline.value ? true : undefined,
    })
    draft.value = ''
    sendWhenOnline.value = false
    if (session.value?.archivedAt) {
      session.value = { ...session.value, archivedAt: undefined }
      state.replaceSession(session.value)
    }
  } catch (error) {
    liveError.value = error instanceof Error ? error.message : 'Message was not accepted'
  } finally {
    sending.value = false
  }
}

async function toggleArchive(): Promise<void> {
  if (!canMutate.value || !session.value || updatingArchive.value) return
  updatingArchive.value = true
  liveError.value = ''
  const archived = !session.value.archivedAt
  try {
    await state.api.setSessionArchived(sessionId.value, archived)
    session.value = {
      ...session.value,
      ...(archived ? { archivedAt: new Date().toISOString() } : { archivedAt: undefined }),
    }
    state.replaceSession(session.value)
    if (archived) {
      await router.replace({ name: 'project', params: { gatewayId: gatewayId.value, projectId: projectId.value } })
    }
  } catch (error) {
    liveError.value = error instanceof Error ? error.message : 'Task collection was not updated'
  } finally {
    updatingArchive.value = false
  }
}

async function cancel(): Promise<void> {
  if (!canMutate.value) return
  try {
    await state.api.cancelSession(sessionId.value, { reason: 'Cancelled from web client' })
  } catch (error) {
    liveError.value = error instanceof Error ? error.message : 'Cancel was not accepted'
  }
}

async function saveControls(patch: PatchSessionConfigDto): Promise<void> {
  if (!canMutate.value || !session.value) return
  savingControls.value = true
  try {
    await state.api.patchSessionConfig(sessionId.value, patch)
    session.value = {
      ...session.value,
      ...('model' in patch ? { model: patch.model ?? undefined } : {}),
      ...('mode' in patch ? { mode: patch.mode ?? undefined } : {}),
      config: { ...session.value.config, ...patch.config },
    }
    state.replaceSession(session.value)
  } catch (error) {
    liveError.value = error instanceof Error ? error.message : 'Session controls were not saved'
  } finally {
    savingControls.value = false
  }
}

async function resolveDecision(decisionId: string, value: JsonValue): Promise<void> {
  if (!canMutate.value) return
  submittingDecisionId.value = decisionId
  try {
    await state.api.resolveDecision(sessionId.value, decisionId, value)
  } catch (error) {
    liveError.value = error instanceof Error ? error.message : 'Decision response was not accepted'
  } finally {
    submittingDecisionId.value = undefined
  }
}

function submitOnShortcut(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    void sendMessage()
  }
}
</script>

<template>
  <div class="session-page">
    <header class="session-header">
      <div class="session-identity">
        <small>{{ gateway?.name }} / {{ project?.name }}</small>
        <div><h1>{{ session?.title ?? 'Untitled session' }}</h1><StatusDot v-if="session" :status="session.state" :label="session.state" /></div>
      </div>
      <button class="icon-button mobile-controls-button" aria-label="Session controls" @click="showMobileControls = !showMobileControls">⚙</button>
      <SessionControls v-if="session" :class="{ 'session-controls--mobile-open': showMobileControls }" :session="session" :capabilities="providerCapabilities" :disabled="!canMutate" :saving="savingControls" @save="saveControls" />
      <button v-if="session?.state === 'querying'" class="button button--danger" :disabled="!canMutate" @click="cancel">Stop</button>
      <button v-else-if="session" class="button" :disabled="!canMutate || updatingArchive" @click="toggleArchive">{{ session.archivedAt ? 'Restore' : 'Archive' }}</button>
    </header>

    <div v-if="!gatewayOnline || !liveConnected" class="connection-banner" :class="{ 'connection-banner--offline': !gatewayOnline }">
      <span class="pulse-dot" />
      <div><strong>{{ connectionLabel }}</strong><small v-if="!gatewayOnline">The encrypted Gateway channel is offline.</small><small v-else>Live events continue after sequence {{ events.at(-1)?.seq ?? 0 }}.</small></div>
    </div>
    <button v-if="liveError" class="inline-alert" @click="liveError = ''">{{ liveError }} <span>×</span></button>

    <div v-if="loadError" class="session-load-state"><div class="error-banner"><strong>Session unavailable</strong>{{ loadError }}</div><button class="button" @click="loadSession">Try again</button></div>
    <div v-else-if="loading" class="session-load-state"><span class="loader" /><p>Loading conversation…</p></div>
    <template v-else>
      <section ref="timelineElement" class="conversation-pane" aria-label="Conversation timeline" @scroll.passive="handleTimelineScroll">
        <div v-if="loadingOlder" class="history-loader"><span class="loader" /> Loading earlier messages…</div>
        <ConversationTimeline
          :events="events"
          :mutable="canMutate"
          :submitting-decision-id="submittingDecisionId"
          @resolve-decision="resolveDecision"
          @select="selectedEvent = $event"
        />
      </section>

      <aside class="inspector" :class="{ 'inspector--open': selectedEvent }">
        <div class="inspector-heading"><div><span class="eyebrow">Event inspector</span><h2>{{ selectedEvent?.event.kind.replaceAll('_', ' ') ?? 'Details' }}</h2></div><button class="icon-button" aria-label="Close inspector" @click="selectedEvent = undefined">×</button></div>
        <template v-if="selectedEvent"><dl><dt>Sequence</dt><dd>{{ selectedEvent.seq }}</dd><dt>Event ID</dt><dd>{{ selectedEvent.eventId }}</dd><dt>Source</dt><dd>{{ selectedEvent.event.meta?.source ?? 'live' }}</dd><dt>Time</dt><dd>{{ new Date(selectedEvent.timestamp).toLocaleString() }}</dd></dl><pre>{{ JSON.stringify(selectedEvent.event, null, 2) }}</pre></template>
        <div v-else class="inspector-empty"><span>◇</span><p>Select an event to inspect its structured payload.</p></div>
      </aside>

      <footer class="composer-wrap">
        <label v-if="!gatewayOnline" class="queue-option"><input v-model="sendWhenOnline" type="checkbox" /> Send when Gateway reconnects</label>
        <div class="composer" :class="{ 'composer--disabled': !canSend }">
          <textarea v-model="draft" rows="2" :disabled="!canSend" :placeholder="canSend ? 'Message agent…' : 'Reconnect to send a message'" @keydown="submitOnShortcut" />
          <div class="composer-footer"><span><kbd>Ctrl</kbd> <kbd>Enter</kbd> to send</span><button class="send-button" :disabled="!draft.trim() || !canSend || sending" aria-label="Send message" @click="sendMessage">{{ sending ? '…' : '↑' }}</button></div>
        </div>
      </footer>
    </template>
  </div>
</template>
