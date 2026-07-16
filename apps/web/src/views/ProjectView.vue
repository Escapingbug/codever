<script setup lang="ts">
import type { ProviderSession, ProviderSessionListDto } from '@codever/protocol'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import StatusDot from '../components/StatusDot.vue'
import { gatewayIsMutable, useCodeverState } from '../state/codeverState'

const route = useRoute()
const router = useRouter()
const state = useCodeverState()
const gatewayId = computed(() => String(route.params.gatewayId))
const projectId = computed(() => String(route.params.projectId))
const gateway = computed(() => state.gateways.value.find(item => item.id === gatewayId.value))
const project = computed(() => (state.projectsByGateway[gatewayId.value] ?? []).find(item => item.id === projectId.value))
const sessions = computed(() => state.sessionsByProject[projectId.value] ?? [])
const activeSessions = computed(() => sessions.value
  .filter(session => session.state === 'querying' || session.state === 'canceling')
  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
const providers = computed(() => gateway.value?.capabilities.providers ?? [])
const showCreate = ref(false)
const createMode = ref<'new' | 'continue'>('new')
const selectedProvider = ref('')
const title = ref('')
const discovery = ref<ProviderSessionListDto>()
const discovering = ref(false)
const creating = ref(false)
const createError = ref('')
const openingProviderSessionId = ref('')
const creatorElement = ref<HTMLElement>()

onMounted(() => state.loadGateways())
watch(gatewayId, id => void state.loadProjects(id), { immediate: true })
watch(projectId, id => void state.loadSessions(id), { immediate: true })
watch([project, providers], ([nextProject, nextProviders]) => {
  if (!selectedProvider.value || !nextProviders.includes(selectedProvider.value)) {
    selectedProvider.value = nextProject?.defaultProvider ?? nextProviders[0] ?? ''
  }
}, { immediate: true })
watch([showCreate, createMode, selectedProvider], ([visible, mode, provider]) => {
  if (visible && mode === 'continue' && provider) void discoverProviderSessions()
})

function openCreate(mode: 'new' | 'continue' = 'new'): void {
  createMode.value = mode
  createError.value = ''
  showCreate.value = true
  void nextTick(() => creatorElement.value?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}

function closeCreate(): void {
  showCreate.value = false
  createError.value = ''
  openingProviderSessionId.value = ''
}

async function discoverProviderSessions(): Promise<void> {
  const provider = selectedProvider.value
  if (!provider) return
  discovering.value = true
  createError.value = ''
  discovery.value = undefined
  try {
    const result = await state.api.discoverProviderSessions(projectId.value, provider)
    if (provider === selectedProvider.value) discovery.value = result
  } catch (error) {
    createError.value = error instanceof Error ? error.message : 'Could not load provider sessions'
  } finally {
    if (provider === selectedProvider.value) discovering.value = false
  }
}

async function createNewSession(): Promise<void> {
  if (!selectedProvider.value || creating.value) return
  creating.value = true
  createError.value = ''
  try {
    const session = await state.api.createSession(projectId.value, {
      provider: selectedProvider.value,
      title: title.value.trim() || undefined,
      config: {},
    })
    state.replaceSession(session)
    await openSession(session.id, session.provider)
  } catch (error) {
    createError.value = error instanceof Error ? error.message : 'Could not create the session'
  } finally {
    creating.value = false
  }
}

async function continueProviderSession(providerSession: ProviderSession): Promise<void> {
  if (openingProviderSessionId.value) return
  openingProviderSessionId.value = providerSession.providerSessionId
  createError.value = ''
  try {
    const session = await state.api.createSession(projectId.value, {
      provider: selectedProvider.value,
      providerSessionId: providerSession.providerSessionId,
      title: providerSession.title,
      config: {},
    })
    state.replaceSession(session)
    await openSession(session.id, session.provider)
  } catch (error) {
    createError.value = error instanceof Error ? error.message : 'Could not continue the provider session'
  } finally {
    openingProviderSessionId.value = ''
  }
}

async function openSession(sessionId: string, provider: string): Promise<void> {
  await router.push({ name: 'session', params: { gatewayId: gatewayId.value, projectId: projectId.value, provider, sessionId } })
}
</script>

<template>
  <div class="page page--overview">
    <header class="page-header project-title">
      <div><span class="eyebrow">Project · {{ gateway?.name }}</span><h1>{{ project?.name ?? 'Project' }}</h1><p>{{ project?.repoIdentity ?? project?.rootPath }}</p></div>
      <button class="button button--primary" :disabled="!gatewayIsMutable(gateway)" @click="openCreate()">＋ New session</button>
    </header>

    <section v-if="showCreate" ref="creatorElement" class="session-creator" aria-label="Create session">
      <div class="session-creator__heading">
        <div><span class="eyebrow">New session</span><h2>How do you want to start?</h2></div>
        <button class="icon-button" aria-label="Close session creator" @click="closeCreate">×</button>
      </div>

      <div class="start-options" role="tablist" aria-label="Session source">
        <button class="start-option" :class="{ 'start-option--active': createMode === 'new' }" role="tab" :aria-selected="createMode === 'new'" @click="createMode = 'new'">
          <strong>Start fresh</strong><small>Create a completely new provider session</small>
        </button>
        <button class="start-option" :class="{ 'start-option--active': createMode === 'continue' }" role="tab" :aria-selected="createMode === 'continue'" @click="createMode = 'continue'">
          <strong>Continue existing</strong><small>Resume a session already stored by the provider</small>
        </button>
      </div>

      <label class="creator-provider"><span>Provider</span><select v-model="selectedProvider"><option v-for="provider in providers" :key="provider" :value="provider">{{ provider }}</option></select></label>
      <div v-if="createError" class="error-banner"><strong>Session unavailable</strong>{{ createError }}</div>

      <form v-if="createMode === 'new'" class="fresh-session-form" @submit.prevent="createNewSession">
        <label><span>Session title</span><input v-model="title" autofocus placeholder="Optional — describe the task" /></label>
        <button class="button button--primary" :disabled="creating || !selectedProvider">{{ creating ? 'Creating…' : 'Create new session' }}</button>
      </form>

      <div v-else class="provider-session-picker">
        <div class="picker-heading"><span>{{ discovery?.sessions.length ?? 0 }} sessions found</span><button class="text-link" :disabled="discovering" @click="discoverProviderSessions">{{ discovering ? 'Scanning…' : 'Refresh' }}</button></div>
        <div v-if="discovery?.sessions.length" class="session-table">
          <button v-for="providerSession in discovery.sessions" :key="providerSession.providerSessionId" class="session-row session-row--button" :disabled="Boolean(openingProviderSessionId)" @click="continueProviderSession(providerSession)">
            <StatusDot :status="providerSession.state ?? 'offline'" />
            <div><strong>{{ providerSession.title }}</strong><small>{{ providerSession.firstMessage || providerSession.providerSessionId }}</small></div>
            <span class="session-mode">{{ providerSession.codeverSessionId ? 'connected' : 'provider' }}</span>
            <time>{{ new Date(providerSession.updatedAt).toLocaleString() }}</time><span>{{ openingProviderSessionId === providerSession.providerSessionId ? '…' : '→' }}</span>
          </button>
        </div>
        <div v-else-if="discovering" class="creator-loading"><span class="loader" /> Scanning provider history…</div>
        <div v-else class="empty-state empty-state--compact"><h2>{{ discovery?.discoverySupported === false ? 'Provider history is not supported' : 'No existing sessions' }}</h2><p>You can switch providers or start a fresh session.</p></div>
      </div>
    </section>

    <section>
      <div class="section-heading"><div><span class="eyebrow">Running now</span><h2>Active sessions</h2></div><span>{{ activeSessions.length }}</span></div>
      <div v-if="activeSessions.length" class="session-table">
        <RouterLink v-for="session in activeSessions" :key="session.id" class="session-row" :to="{ name: 'session', params: { gatewayId, projectId, provider: session.provider, sessionId: session.id } }">
          <StatusDot :status="session.state" />
          <div><strong>{{ session.title ?? 'Untitled session' }}</strong><small>{{ session.provider }} · {{ session.model ?? 'default model' }}</small></div>
          <span class="session-mode">{{ session.mode ?? 'default' }}</span>
          <time>{{ new Date(session.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</time><span>→</span>
        </RouterLink>
      </div>
      <div v-else class="empty-state empty-state--compact"><span class="empty-orbit">◇</span><h2>No active sessions</h2><p>Start a new task or continue one from a provider's history.</p><button class="button" :disabled="!gatewayIsMutable(gateway)" @click="openCreate('continue')">Browse provider sessions</button></div>
    </section>
  </div>
</template>
