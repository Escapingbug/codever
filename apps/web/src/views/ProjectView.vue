<script setup lang="ts">
import type { CodeverSession, ProviderSession } from '@codever/protocol'
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
const activeSessions = computed(() => [...(state.sessionsByProject[projectId.value] ?? [])]
  .filter(session => session.state !== 'closed')
  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
const providers = computed(() => gateway.value?.capabilities.providers ?? [])
const selectedProvider = ref('')
const providerFilter = ref('all')
const scopeFilter = ref<'all' | 'active' | 'inactive'>('all')
const searchQuery = ref('')
const title = ref('')
const showCreate = ref(false)
const inactiveSessions = ref<ProviderSession[]>([])
const discovering = ref(false)
const creating = ref(false)
const historyError = ref('')
const createError = ref('')
const openingProviderSessionId = ref('')
const creatorElement = ref<HTMLElement>()
let discoveryGeneration = 0

const normalizedSearch = computed(() => searchQuery.value.trim().toLocaleLowerCase())
const visibleActiveSessions = computed(() => scopeFilter.value === 'inactive' ? [] : activeSessions.value.filter(session =>
  matchesProvider(session.provider) && matchesSearch(activeSearchText(session)),
))
const visibleInactiveSessions = computed(() => scopeFilter.value === 'active' ? [] : inactiveSessions.value.filter(session =>
  matchesProvider(session.provider) && matchesSearch(inactiveSearchText(session)),
))
const visibleCount = computed(() => visibleActiveSessions.value.length + visibleInactiveSessions.value.length)

onMounted(() => state.loadWorkspace())
watch(project, value => { if (value) void state.loadSessions(value.id) }, { immediate: true })
watch([project, providers], ([nextProject, nextProviders]) => {
  if (!selectedProvider.value || !nextProviders.includes(selectedProvider.value)) {
    selectedProvider.value = nextProject?.defaultProvider ?? nextProviders[0] ?? ''
  }
}, { immediate: true })
watch([project, providers], ([value]) => { if (value) void discoverProviderSessions() }, { immediate: true })

function matchesProvider(provider: string): boolean {
  return providerFilter.value === 'all' || provider === providerFilter.value
}

function matchesSearch(value: string): boolean {
  return !normalizedSearch.value || value.toLocaleLowerCase().includes(normalizedSearch.value)
}

function activeSearchText(session: CodeverSession): string {
  return [session.title, session.provider, session.providerSessionId, session.model, session.mode].filter(Boolean).join(' ')
}

function inactiveSearchText(session: ProviderSession): string {
  return [session.title, session.firstMessage, session.provider, session.providerSessionId, session.cwd].filter(Boolean).join(' ')
}

function openCreate(): void {
  createError.value = ''
  showCreate.value = true
  void nextTick(() => creatorElement.value?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}

async function discoverProviderSessions(): Promise<void> {
  const currentProjectId = projectId.value
  const currentProviders = [...providers.value]
  const generation = ++discoveryGeneration
  if (!currentProviders.length) {
    inactiveSessions.value = []
    return
  }
  discovering.value = true
  historyError.value = ''
  try {
    const attempts = await Promise.allSettled(currentProviders.map(provider =>
      state.api.discoverProviderSessions(currentProjectId, provider),
    ))
    if (generation !== discoveryGeneration) return
    const results = attempts.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    if (!results.length && attempts.some(result => result.status === 'rejected')) {
      throw new Error('No provider history could be loaded')
    }
    const known = new Set(activeSessions.value.map(session => `${session.provider}:${session.providerSessionId ?? ''}`))
    inactiveSessions.value = results
      .flatMap(result => result.sessions)
      .filter(session => !session.codeverSessionId && !known.has(`${session.provider}:${session.providerSessionId}`))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } catch (error) {
    if (generation === discoveryGeneration) {
      historyError.value = error instanceof Error ? error.message : 'Could not load inactive sessions'
    }
  } finally {
    if (generation === discoveryGeneration) discovering.value = false
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
    await openSession(session.id)
  } catch (error) {
    createError.value = error instanceof Error ? error.message : 'Could not create the session'
  } finally {
    creating.value = false
  }
}

async function continueProviderSession(providerSession: ProviderSession): Promise<void> {
  if (openingProviderSessionId.value) return
  openingProviderSessionId.value = providerSession.providerSessionId
  historyError.value = ''
  try {
    const session = await state.api.createSession(projectId.value, {
      provider: providerSession.provider,
      providerSessionId: providerSession.providerSessionId,
      title: providerSession.title,
      config: {},
    })
    state.replaceSession(session)
    await openSession(session.id)
  } catch (error) {
    historyError.value = error instanceof Error ? error.message : 'Could not continue the session'
  } finally {
    openingProviderSessionId.value = ''
  }
}

async function openSession(sessionId: string): Promise<void> {
  await router.push({ name: 'session', params: { gatewayId: gatewayId.value, projectId: projectId.value, sessionId } })
}
</script>

<template>
  <div class="page page--overview">
    <header class="page-header project-title">
      <div>
        <span class="eyebrow">{{ gateway?.name }}</span>
        <h1>{{ project?.name ?? 'Project' }}</h1>
        <details v-if="project" class="project-details">
          <summary>Project details</summary>
          <dl>
            <div><dt>Path</dt><dd>{{ project.rootPath }}</dd></div>
            <div v-if="project.canonicalRoot !== project.rootPath"><dt>Resolved path</dt><dd>{{ project.canonicalRoot }}</dd></div>
            <div><dt>Gateway</dt><dd>{{ gateway?.name }} · {{ gateway?.platform }}</dd></div>
            <div v-if="project.defaultProvider"><dt>Default provider</dt><dd>{{ project.defaultProvider }}</dd></div>
          </dl>
        </details>
      </div>
      <button class="button button--primary" :disabled="!gatewayIsMutable(gateway)" @click="openCreate">＋ New session</button>
    </header>

    <section v-if="showCreate" ref="creatorElement" class="session-creator" aria-label="Create a new session">
      <div class="session-creator__heading">
        <div><span class="eyebrow">New session</span><h2>Start a fresh task</h2></div>
        <button class="icon-button" aria-label="Close" @click="showCreate = false">×</button>
      </div>
      <label class="creator-provider"><span>Provider</span><select v-model="selectedProvider"><option v-for="provider in providers" :key="provider" :value="provider">{{ provider }}</option></select></label>
      <div v-if="createError" class="error-banner"><strong>Session unavailable</strong>{{ createError }}</div>
      <form class="fresh-session-form" @submit.prevent="createNewSession">
        <label><span>Session title</span><input v-model="title" autofocus placeholder="Optional — describe the task" /></label>
        <button class="button button--primary" :disabled="creating || !selectedProvider">{{ creating ? 'Creating…' : 'Create session' }}</button>
      </form>
    </section>

    <section class="sessions-section">
      <div class="section-heading sessions-heading">
        <div><span class="eyebrow">Project work</span><h2>Sessions</h2></div>
        <span>{{ visibleCount }}</span>
      </div>

      <div class="session-filters" aria-label="Session filters">
        <label class="session-search"><span class="sr-only">Search sessions</span><input v-model="searchQuery" type="search" placeholder="Search sessions" /></label>
        <label><span class="sr-only">Session status</span><select v-model="scopeFilter"><option value="all">All sessions</option><option value="active">Active only</option><option value="inactive">Inactive only</option></select></label>
        <label><span class="sr-only">Provider</span><select v-model="providerFilter"><option value="all">All providers</option><option v-for="provider in providers" :key="provider" :value="provider">{{ provider }}</option></select></label>
        <button class="button" :disabled="discovering" @click="discoverProviderSessions">{{ discovering ? 'Refreshing…' : 'Refresh' }}</button>
      </div>

      <div v-if="historyError" class="error-banner"><strong>History unavailable</strong>{{ historyError }}</div>

      <template v-if="scopeFilter !== 'inactive'">
        <div class="session-group-label"><span>Active</span><small>{{ visibleActiveSessions.length }}</small></div>
        <div v-if="visibleActiveSessions.length" class="session-table">
          <RouterLink v-for="session in visibleActiveSessions" :key="session.id" class="session-row" :to="{ name: 'session', params: { gatewayId, projectId, sessionId: session.id } }">
            <StatusDot :status="session.state" />
            <div><strong>{{ session.title ?? 'Untitled session' }}</strong><small>{{ session.provider }} · {{ session.model ?? 'default model' }} · {{ gateway?.name }}</small></div>
            <span class="session-mode">{{ session.mode ?? 'default' }}</span>
            <time>{{ new Date(session.updatedAt).toLocaleString() }}</time><span>→</span>
          </RouterLink>
        </div>
        <p v-else class="session-group-empty">No active sessions match these filters.</p>
      </template>

      <template v-if="scopeFilter !== 'active'">
        <div class="session-group-label session-group-label--inactive"><span>Inactive · available to continue</span><small>{{ visibleInactiveSessions.length }}</small></div>
        <div v-if="visibleInactiveSessions.length" class="session-table">
          <button v-for="providerSession in visibleInactiveSessions" :key="`${providerSession.provider}:${providerSession.providerSessionId}`" class="session-row session-row--button" :disabled="Boolean(openingProviderSessionId)" @click="continueProviderSession(providerSession)">
            <StatusDot status="offline" />
            <div><strong>{{ providerSession.title }}</strong><small>{{ providerSession.firstMessage || providerSession.providerSessionId }}</small></div>
            <span class="session-mode">{{ providerSession.provider }}</span>
            <time>{{ new Date(providerSession.updatedAt).toLocaleString() }}</time><span>{{ openingProviderSessionId === providerSession.providerSessionId ? '…' : '→' }}</span>
          </button>
        </div>
        <div v-else-if="discovering" class="creator-loading"><span class="loader" /> Loading provider history…</div>
        <p v-else class="session-group-empty">No inactive sessions match these filters.</p>
      </template>

      <div class="session-actions">
        <button class="button button--primary" :disabled="!gatewayIsMutable(gateway)" @click="openCreate">New session</button>
      </div>
    </section>
  </div>
</template>
