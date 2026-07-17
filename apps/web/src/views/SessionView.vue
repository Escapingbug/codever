<script setup lang="ts">
import type { AttachmentUploadDto, CodeverSession, JsonValue, PatchSessionConfigDto, ProviderSessionListDto, SessionAttachmentDto, SessionEventEnvelope } from '@codever/protocol'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ConversationTimeline from '../components/timeline/ConversationTimeline.vue'
import SessionControls from '../components/SessionControls.vue'
import StatusDot from '../components/StatusDot.vue'
import { mergeSessionEvents } from '../sessionEvents'
import { gatewayIsMutable, useCodeverState } from '../state/codeverState'
import { buildTimeline, type AssistantTimelineEntry } from '../timeline/model'

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
const fileInput = ref<HTMLInputElement>()
interface PendingAttachment {
  localId: string
  sessionId: string
  file: File
  upload?: AttachmentUploadDto
  receivedBytes: number
  status: 'uploading' | 'ready' | 'error'
  stage: 'uploading' | 'storing'
  error?: string
  controller: AbortController
}
const pendingAttachments = ref<PendingAttachment[]>([])
const sessionAttachments = ref<SessionAttachmentDto[]>([])
const selectedStoredAttachmentIds = ref<string[]>([])
const cleanupAttachmentIds = ref<string[]>([])
const showSessionFiles = ref(false)
const loadingSessionFiles = ref(false)
const deletingSessionFiles = ref(false)
const showMobileControls = ref(false)
const submittingDecisionId = ref<string>()
const selectedEvent = shallowRef<SessionEventEnvelope>()
const timelineElement = ref<HTMLElement>()
let unsubscribeEvents: (() => void) | undefined
const HISTORY_PAGE_SIZE = 24
const INITIAL_AGENT_REPLIES = 5
const MAX_INITIAL_HISTORY_PAGES = 8
const HISTORY_LOAD_THRESHOLD = 96
const hasMoreBefore = ref(false)
const loadingOlder = ref(false)
const loadingInitialHistory = ref(false)
let historyGeneration = 0

const gatewayOnline = computed(() => gatewayIsMutable(gateway.value))
const liveConnected = computed(() => socketState.value === 'connected')
const canMutate = computed(() => gatewayOnline.value
  && liveConnected.value
  && session.value?.state !== 'closed'
  && session.value?.state !== 'offline')
const canSend = computed(() => canMutate.value || (!gatewayOnline.value && sendWhenOnline.value))
const attachmentsUploading = computed(() => pendingAttachments.value.some(item => item.status === 'uploading'))
const readyAttachmentIds = computed(() => [...new Set([
  ...selectedStoredAttachmentIds.value,
  ...pendingAttachments.value.flatMap(item => item.status === 'ready' && item.upload ? [item.upload.attachmentId] : []),
])])
const canSubmitMessage = computed(() => canSend.value
  && !sending.value
  && !attachmentsUploading.value
  && (Boolean(draft.value.trim()) || readyAttachmentIds.value.length > 0))
const connectionLabel = computed(() => {
  if (!gatewayOnline.value) return 'Gateway offline'
  if (socketState.value === 'connected') return 'Live'
  return 'Connection unavailable'
})

onMounted(() => {
  void state.loadGateways()
  void state.loadProjects(gatewayId.value)
})
watch(sessionId, (next, previous) => {
  if (previous && previous !== next) disposeAttachments()
  void loadSession()
}, { immediate: true })
watch([projectId, provider], () => void loadProviderCapabilities(), { immediate: true })
onBeforeUnmount(() => {
  unsubscribeEvents?.()
  disposeAttachments()
})

async function loadSession(): Promise<void> {
  const generation = ++historyGeneration
  unsubscribeEvents?.()
  unsubscribeEvents = undefined
  const requestedId = sessionId.value
  const memoryCached = state.eventsBySession[requestedId] ?? []
  events.value = recentConversation(memoryCached)
  hasMoreBefore.value = false
  loadingOlder.value = false
  loadingInitialHistory.value = true
  loading.value = events.value.length === 0
  loadError.value = ''
  liveError.value = ''
  selectedEvent.value = undefined
  try {
    const persisted = await state.loadCachedSessionEvents(requestedId)
    if (requestedId !== sessionId.value) return
    if (persisted.length) {
      events.value = recentConversation(persisted)
      loading.value = false
    }
    session.value = await state.api.getSession(requestedId)
    state.replaceSession(session.value)
    await refreshSessionAttachments()
    startLiveConnection(requestedId)
    let page = await state.api.getSessionEvents(requestedId, { limit: HISTORY_PAGE_SIZE })
    let fetchedRemoteEvents = page.events
    let pageCount = 1
    while (
      page.previousBefore !== null
      && countAgentReplies(fetchedRemoteEvents) < INITIAL_AGENT_REPLIES
      && pageCount < MAX_INITIAL_HISTORY_PAGES
    ) {
      page = await state.api.getSessionEvents(requestedId, {
        before: page.previousBefore,
        limit: HISTORY_PAGE_SIZE,
      })
      fetchedRemoteEvents = mergeSessionEvents(page.events, fetchedRemoteEvents)
      pageCount += 1
    }
    if (requestedId !== sessionId.value || generation !== historyGeneration) return
    const remoteEvents = recentConversation(fetchedRemoteEvents)
    const lastRemoteSeq = fetchedRemoteEvents.at(-1)?.seq ?? 0
    const liveSinceRequest = events.value.filter(event => event.seq > lastRemoteSeq)
    events.value = mergeSessionEvents(remoteEvents, liveSinceRequest)
    state.mergeSessionEvents(requestedId, fetchedRemoteEvents)
    const earliestVisible = events.value.at(0)?.seq
    hasMoreBefore.value = page.previousBefore !== null
      || (earliestVisible !== undefined && fetchedRemoteEvents.some(event => event.seq < earliestVisible))
    await scrollToLatest(false)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not load the session'
    if (events.value.length) liveError.value = `Could not refresh this cached conversation: ${message}`
    else loadError.value = message
  } finally {
    if (requestedId === sessionId.value && generation === historyGeneration) {
      loading.value = false
      loadingInitialHistory.value = false
    }
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
  const additions = incoming.filter(event => event.sessionId === sessionId.value)
  const merged = mergeSessionEvents(events.value, additions)
  if (merged.length === events.value.length
    && merged.every((event, index) => event.eventId === events.value[index]?.eventId)) return
  events.value = merged
  state.mergeSessionEvents(sessionId.value, additions)
}

function countAgentReplies(source: SessionEventEnvelope[]): number {
  return agentReplies(source).length
}

function recentConversation(source: SessionEventEnvelope[]): SessionEventEnvelope[] {
  if (!source.length) return []
  const ordered = [...source].sort((left, right) => left.seq - right.seq)
  const replies = agentReplies(ordered)
  const boundary = replies.at(-INITIAL_AGENT_REPLIES)?.events.at(0)?.seq
  // A single rendered reply may contain many delta/tool events. If there are
  // fewer replies than the initial target, all of those events are required to
  // reconstruct the complete conversation and must not be cut by page size.
  if (boundary === undefined) return ordered
  const precedingUser = [...ordered].reverse().find(envelope =>
    envelope.seq <= boundary && envelope.event.kind === 'user_message',
  )
  const firstSeq = precedingUser?.seq ?? boundary
  return ordered.filter(envelope => envelope.seq >= firstSeq)
}

function agentReplies(source: SessionEventEnvelope[]): AssistantTimelineEntry[] {
  return buildTimeline(source).filter((entry): entry is AssistantTimelineEntry =>
    entry.type === 'assistant' && Boolean(entry.text.trim()),
  )
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
  if (!element || element.scrollTop > HISTORY_LOAD_THRESHOLD || loadingInitialHistory.value
    || loadingOlder.value || !hasMoreBefore.value) return
  await loadOlderEvents()
}

async function loadOlderEvents(): Promise<void> {
  const element = timelineElement.value
  const earliest = events.value.at(0)?.seq
  if (!element || earliest === undefined || loadingOlder.value) return
  const requestedId = sessionId.value
  const generation = historyGeneration
  loadingOlder.value = true
  const previousHeight = element.scrollHeight
  try {
    const page = await state.api.getSessionEvents(requestedId, { before: earliest, limit: HISTORY_PAGE_SIZE })
    if (requestedId !== sessionId.value || generation !== historyGeneration) return
    appendEvents(page.events)
    hasMoreBefore.value = page.events.length > 0 && page.previousBefore !== null
    await nextTick()
    element.scrollTop += element.scrollHeight - previousHeight
  } catch (error) {
    liveError.value = error instanceof Error ? error.message : 'Earlier messages could not be loaded'
  } finally {
    if (requestedId === sessionId.value && generation === historyGeneration) loadingOlder.value = false
  }
}

async function sendMessage(): Promise<void> {
  const submittedDraft = draft.value
  const text = submittedDraft.trim()
  if (!canSubmitMessage.value) return
  sending.value = true
  draft.value = ''
  await nextTick()
  try {
    await state.api.sendMessage(sessionId.value, {
      text,
      attachmentIds: readyAttachmentIds.value,
      sendWhenOnline: !gatewayOnline.value ? true : undefined,
    })
    pendingAttachments.value = []
    selectedStoredAttachmentIds.value = []
    await refreshSessionAttachments()
    sendWhenOnline.value = false
    if (session.value?.archivedAt) {
      session.value = { ...session.value, archivedAt: undefined }
      state.replaceSession(session.value)
    }
  } catch (error) {
    if (!draft.value) draft.value = submittedDraft
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

function chooseAttachments(): void {
  fileInput.value?.click()
}

async function addAttachments(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  if (!files.length) return
  for (const file of files) {
    const attachment: PendingAttachment = {
      localId: crypto.randomUUID(),
      sessionId: sessionId.value,
      file,
      receivedBytes: 0,
      status: 'uploading',
      stage: 'uploading',
      controller: new AbortController(),
    }
    pendingAttachments.value = [...pendingAttachments.value, attachment]
    void uploadAttachment(attachment)
  }
}

async function uploadAttachment(attachment: PendingAttachment): Promise<void> {
  attachment.status = 'uploading'
  attachment.error = undefined
  attachment.controller = new AbortController()
  try {
    const upload = await state.api.uploadAttachment(attachment.sessionId, attachment.file, {
      signal: attachment.controller.signal,
      onProgress: receivedBytes => {
        attachment.receivedBytes = receivedBytes
        pendingAttachments.value = [...pendingAttachments.value]
      },
      onStage: stage => {
        attachment.stage = stage
        pendingAttachments.value = [...pendingAttachments.value]
      },
      onUpload: upload => { attachment.upload = upload },
      resume: attachment.upload?.status === 'uploading' ? attachment.upload : undefined,
    })
    attachment.upload = upload
    attachment.receivedBytes = upload.receivedBytes
    attachment.status = 'ready'
    await refreshSessionAttachments()
  } catch (error) {
    if (attachment.controller.signal.aborted) return
    attachment.status = 'error'
    attachment.error = error instanceof Error ? error.message : 'Upload failed'
  } finally {
    pendingAttachments.value = [...pendingAttachments.value]
  }
}

async function removeAttachment(attachment: PendingAttachment): Promise<void> {
  attachment.controller.abort()
  pendingAttachments.value = pendingAttachments.value.filter(item => item.localId !== attachment.localId)
  if (attachment.status === 'error' && attachment.upload?.status === 'uploading') {
    await state.api.cancelAttachment(attachment.sessionId, attachment.upload.attachmentId).catch(error => {
      liveError.value = error instanceof Error ? error.message : 'Upload cleanup failed'
    })
  }
}

function retryAttachment(attachment: PendingAttachment): void {
  if (attachment.status === 'error') void uploadAttachment(attachment)
}

function disposeAttachments(): void {
  const attachments = pendingAttachments.value
  pendingAttachments.value = []
  for (const attachment of attachments) {
    attachment.controller.abort()
  }
}

async function refreshSessionAttachments(): Promise<void> {
  const requestedId = sessionId.value
  loadingSessionFiles.value = true
  try {
    const result = await state.api.listSessionAttachments(requestedId)
    if (requestedId !== sessionId.value) return
    sessionAttachments.value = result.attachments
    const available = new Set(result.attachments.map(item => item.attachmentId))
    selectedStoredAttachmentIds.value = selectedStoredAttachmentIds.value.filter(id => available.has(id))
    cleanupAttachmentIds.value = cleanupAttachmentIds.value.filter(id => available.has(id))
  } catch (error) {
    if (requestedId === sessionId.value) liveError.value = error instanceof Error ? error.message : 'Session files could not be loaded'
  } finally {
    if (requestedId === sessionId.value) loadingSessionFiles.value = false
  }
}

function toggleStoredAttachment(attachmentId: string): void {
  selectedStoredAttachmentIds.value = selectedStoredAttachmentIds.value.includes(attachmentId)
    ? selectedStoredAttachmentIds.value.filter(id => id !== attachmentId)
    : [...selectedStoredAttachmentIds.value, attachmentId]
}

function toggleCleanupAttachment(attachmentId: string): void {
  cleanupAttachmentIds.value = cleanupAttachmentIds.value.includes(attachmentId)
    ? cleanupAttachmentIds.value.filter(id => id !== attachmentId)
    : [...cleanupAttachmentIds.value, attachmentId]
}

async function deleteSelectedSessionFiles(): Promise<void> {
  if (!cleanupAttachmentIds.value.length || deletingSessionFiles.value) return
  if (!window.confirm(`Delete ${cleanupAttachmentIds.value.length} encrypted Session file(s) from Relay storage?`)) return
  deletingSessionFiles.value = true
  try {
    const deleting = new Set(cleanupAttachmentIds.value)
    await state.api.deleteSessionAttachments(sessionId.value, [...deleting])
    pendingAttachments.value = pendingAttachments.value.filter(item => !item.upload || !deleting.has(item.upload.attachmentId))
    selectedStoredAttachmentIds.value = selectedStoredAttachmentIds.value.filter(id => !deleting.has(id))
    cleanupAttachmentIds.value = []
    await refreshSessionAttachments()
  } catch (error) {
    liveError.value = error instanceof Error ? error.message : 'Session files could not be deleted'
  } finally {
    deletingSessionFiles.value = false
  }
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
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
        <section v-if="showSessionFiles" class="session-files-panel" aria-label="Files stored for this session">
          <header><div><strong>Session files</strong><small>End-to-end encrypted in Relay storage</small></div><div><button class="button button--small" :disabled="loadingSessionFiles" @click="refreshSessionAttachments">{{ loadingSessionFiles ? 'Refreshing…' : 'Refresh' }}</button><button class="button button--small button--danger" :disabled="!cleanupAttachmentIds.length || deletingSessionFiles" @click="deleteSelectedSessionFiles">{{ deletingSessionFiles ? 'Deleting…' : `Delete (${cleanupAttachmentIds.length})` }}</button></div></header>
          <div v-if="!sessionAttachments.length && !loadingSessionFiles" class="session-files-empty">No files are stored for this session.</div>
          <div v-else class="session-files-list">
            <article v-for="attachment in sessionAttachments" :key="attachment.attachmentId" class="session-file-row">
              <input type="checkbox" :checked="cleanupAttachmentIds.includes(attachment.attachmentId)" aria-label="Select file for deletion" @change="toggleCleanupAttachment(attachment.attachmentId)" />
              <div><strong>{{ attachment.filename }}</strong><small>{{ formatBytes(attachment.sizeBytes) }} · {{ new Date(attachment.createdAt).toLocaleString() }}</small></div>
              <button class="button button--small" :class="{ 'button--selected': selectedStoredAttachmentIds.includes(attachment.attachmentId) }" @click="toggleStoredAttachment(attachment.attachmentId)">{{ selectedStoredAttachmentIds.includes(attachment.attachmentId) ? 'Attached' : 'Attach' }}</button>
            </article>
          </div>
        </section>
        <div class="composer" :class="{ 'composer--disabled': !canSend }">
          <div v-if="pendingAttachments.length || selectedStoredAttachmentIds.length" class="composer-attachments">
            <div v-for="attachmentId in selectedStoredAttachmentIds" :key="`stored-${attachmentId}`" class="composer-attachment composer-attachment--ready">
              <div><strong>{{ sessionAttachments.find(item => item.attachmentId === attachmentId)?.filename ?? 'Session file' }}</strong><small>Stored in Relay</small></div>
              <button type="button" aria-label="Remove stored attachment" @click="toggleStoredAttachment(attachmentId)">×</button>
            </div>
            <div v-for="attachment in pendingAttachments" :key="attachment.localId" class="composer-attachment" :class="`composer-attachment--${attachment.status}`">
              <div><strong>{{ attachment.file.name }}</strong><small>{{ attachment.status === 'uploading' ? attachment.stage === 'storing' ? 'Encrypting into Relay storage…' : `${formatBytes(attachment.receivedBytes)} / ${formatBytes(attachment.file.size)}` : attachment.status === 'ready' ? formatBytes(attachment.file.size) : attachment.error }}</small></div>
              <progress v-if="attachment.status === 'uploading' && attachment.stage === 'uploading' && attachment.file.size > 0" :value="attachment.receivedBytes" :max="attachment.file.size" />
              <span class="composer-attachment-actions"><button v-if="attachment.status === 'error'" type="button" @click="retryAttachment(attachment)">Retry</button><button type="button" aria-label="Remove attachment" @click="removeAttachment(attachment)">×</button></span>
            </div>
          </div>
          <textarea v-model="draft" rows="2" :disabled="!canSend" :placeholder="canSend ? 'Message agent…' : 'Reconnect to send a message'" @keydown="submitOnShortcut" />
          <div class="composer-footer"><div class="composer-actions"><input ref="fileInput" type="file" multiple hidden @change="addAttachments" /><button class="attachment-button" type="button" :disabled="!canMutate" aria-label="Upload files" @click="chooseAttachments">＋ Upload</button><button class="attachment-button" type="button" :class="{ 'attachment-button--active': showSessionFiles }" @click="showSessionFiles = !showSessionFiles">Files {{ sessionAttachments.length }}</button><span class="composer-shortcut"><kbd>Ctrl</kbd> <kbd>Enter</kbd> to send</span></div><button class="send-button" :disabled="!canSubmitMessage" aria-label="Send message" @click="sendMessage">{{ sending ? '…' : '↑' }}</button></div>
        </div>
      </footer>
    </template>
  </div>
</template>
