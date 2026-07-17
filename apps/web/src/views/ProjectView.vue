<script setup lang="ts">
import type { ProviderSession } from '@codever/protocol'
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
  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
const providers = computed(() => gateway.value?.capabilities.providers ?? [])
const selectedProvider = ref('')
const providerFilter = ref('all')
const title = ref('')
const showCreate = ref(false)
const showInactive = ref(false)
const inactiveSessions = ref<ProviderSession[]>([])
const discovering = ref(false)
const creating = ref(false)
const createError = ref('')
const openingProviderSessionId = ref('')
const creatorElement = ref<HTMLElement>()
const filteredInactiveSessions = computed(() => inactiveSessions.value.filter(session =>
  providerFilter.value === 'all' || session.provider === providerFilter.value,
))

onMounted(() => state.loadWorkspace())
watch(projectId, id => void state.loadSessions(id), { immediate: true })
watch([project, providers], ([nextProject, nextProviders]) => {
  if (!selectedProvider.value || !nextProviders.includes(selectedProvider.value)) {
    selectedProvider.value = nextProject?.defaultProvider ?? nextProviders[0] ?? ''
  }
}, { immediate: true })

function openCreate(): void {
  createError.value = ''
  showInactive.value = false
  showCreate.value = true
  void nextTick(() => creatorElement.value?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}

async function openInactive(): Promise<void> {
  showCreate.value = false
  showInactive.value = true
  await nextTick(() => creatorElement.value?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  await discoverProviderSessions()
}

async function discoverProviderSessions(): Promise<void> {
  if (!providers.value.length || discovering.value) return
  discovering.value = true
  createError.value = ''
  try {
    const attempts = await Promise.allSettled(providers.value.map(provider =>
      state.api.discoverProviderSessions(projectId.value, provider),
    ))
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
    createError.value = error instanceof Error ? error.message : 'Could not load inactive sessions'
  } finally {
    discovering.value = false
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
  createError.value = ''
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
    createError.value = error instanceof Error ? error.message : 'Could not continue the session'
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
      <div><span class="eyebrow">{{ gateway?.name }}</span><h1>{{ project?.name ?? 'Project' }}</h1><p>{{ project?.repoIdentity ?? project?.rootPath }}</p></div>
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

    <section v-else-if="showInactive" ref="creatorElement" class="session-creator" aria-label="Inactive sessions">
      <div class="session-creator__heading">
        <div><span class="eyebrow">Provider history</span><h2>Inactive sessions</h2></div>
        <button class="icon-button" aria-label="Close" @click="showInactive = false">×</button>
      </div>
      <div class="inactive-toolbar">
        <label class="creator-provider"><span>Provider</span><select v-model="providerFilter"><option value="all">All providers</option><option v-for="provider in providers" :key="provider" :value="provider">{{ provider }}</option></select></label>
        <button class="button" :disabled="discovering" @click="discoverProviderSessions">{{ discovering ? 'Scanning…' : 'Refresh' }}</button>
      </div>
      <div v-if="createError" class="error-banner"><strong>History unavailable</strong>{{ createError }}</div>
      <div v-if="filteredInactiveSessions.length" class="session-table">
        <button v-for="providerSession in filteredInactiveSessions" :key="`${providerSession.provider}:${providerSession.providerSessionId}`" class="session-row session-row--button" :disabled="Boolean(openingProviderSessionId)" @click="continueProviderSession(providerSession)">
          <StatusDot :status="providerSession.state ?? 'offline'" />
          <div><strong>{{ providerSession.title }}</strong><small>{{ providerSession.firstMessage || providerSession.providerSessionId }}</small></div>
          <span class="session-mode">{{ providerSession.provider }}</span>
          <time>{{ new Date(providerSession.updatedAt).toLocaleString() }}</time><span>{{ openingProviderSessionId === providerSession.providerSessionId ? '…' : '→' }}</span>
        </button>
      </div>
      <div v-else-if="discovering" class="creator-loading"><span class="loader" /> Scanning all provider history…</div>
      <div v-else class="empty-state empty-state--compact"><h2>No inactive sessions</h2><p>Try another provider filter or start a new session.</p></div>
    </section>

    <section>
      <div class="section-heading"><div><span class="eyebrow">Codever sessions</span><h2>Active sessions</h2></div><span>{{ activeSessions.length }}</span></div>
      <div v-if="activeSessions.length" class="session-table">
        <RouterLink v-for="session in activeSessions" :key="session.id" class="session-row" :to="{ name: 'session', params: { gatewayId, projectId, sessionId: session.id } }">
          <StatusDot :status="session.state" />
          <div><strong>{{ session.title ?? 'Untitled session' }}</strong><small>{{ session.provider }} · {{ session.model ?? 'default model' }} · {{ gateway?.name }}</small></div>
          <span class="session-mode">{{ session.mode ?? 'default' }}</span>
          <time>{{ new Date(session.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</time><span>→</span>
        </RouterLink>
      </div>
      <div v-else class="empty-state empty-state--compact"><span class="empty-orbit">◇</span><h2>No active sessions</h2><p>Start a new task, or resume one from provider history.</p></div>
      <div class="session-actions">
        <button class="button button--primary" :disabled="!gatewayIsMutable(gateway)" @click="openCreate">New session</button>
        <button class="button" :disabled="!gatewayIsMutable(gateway)" @click="openInactive">Browse inactive sessions</button>
      </div>
    </section>
  </div>
</template>
