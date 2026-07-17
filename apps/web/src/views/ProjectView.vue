<script setup lang="ts">
import type { CodeverSession, ProviderSession } from '@codever/protocol'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import StatusDot from '../components/StatusDot.vue'
import { gatewayIsMutable, useCodeverState } from '../state/codeverState'

interface ProjectTask {
  key: string
  provider: string
  providerSessionId?: string
  codeverSessionId?: string
  title: string
  firstMessage?: string
  updatedAt: string
  state?: CodeverSession['state']
  archivedAt?: string
  draft: boolean
}

const route = useRoute()
const router = useRouter()
const state = useCodeverState()
const gatewayId = computed(() => String(route.params.gatewayId))
const projectId = computed(() => String(route.params.projectId))
const gateway = computed(() => state.gateways.value.find(item => item.id === gatewayId.value))
const project = computed(() => (state.projectsByGateway[gatewayId.value] ?? []).find(item => item.id === projectId.value))
const bridges = computed(() => state.sessionsByProject[projectId.value] ?? [])
const providers = computed(() => gateway.value?.capabilities.providers ?? [])
const providerSessions = computed(() => state.providerSessionsByProject[projectId.value] ?? [])
const selectedProvider = ref('')
const providerFilter = ref('all')
const scopeFilter = ref<'recent' | 'archived' | 'all'>('recent')
const searchQuery = ref('')
const title = ref('')
const showCreate = ref(false)
const showFilters = ref(false)
const discovering = ref(false)
const creating = ref(false)
const taskError = ref('')
const createError = ref('')
const openingKey = ref('')
const archivingKey = ref('')
const creatorElement = ref<HTMLElement>()
let discoveryGeneration = 0

const tasks = computed<ProjectTask[]>(() => {
  const result = new Map<string, ProjectTask>()
  for (const native of providerSessions.value) {
    const key = `${native.provider}:${native.providerSessionId}`
    if (result.has(key)) continue
    result.set(key, {
      key,
      provider: native.provider,
      providerSessionId: native.providerSessionId,
      ...(native.codeverSessionId ? { codeverSessionId: native.codeverSessionId } : {}),
      title: native.title,
      ...(native.firstMessage !== undefined ? { firstMessage: native.firstMessage } : {}),
      updatedAt: native.updatedAt,
      ...(native.state ? { state: native.state } : {}),
      ...(native.archivedAt ? { archivedAt: native.archivedAt } : {}),
      draft: false,
    })
  }
  for (const bridge of bridges.value) {
    const nativeKey = bridge.providerSessionId ? `${bridge.provider}:${bridge.providerSessionId}` : undefined
    if (nativeKey && result.has(nativeKey)) continue
    const key = nativeKey ?? `draft:${bridge.id}`
    result.set(key, {
      key,
      provider: bridge.provider,
      ...(bridge.providerSessionId ? { providerSessionId: bridge.providerSessionId } : {}),
      codeverSessionId: bridge.id,
      title: bridge.title ?? 'Untitled task',
      updatedAt: bridge.updatedAt,
      state: bridge.state,
      ...(bridge.archivedAt ? { archivedAt: bridge.archivedAt } : {}),
      draft: !bridge.providerSessionId,
    })
  }
  return [...result.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
})

const normalizedSearch = computed(() => searchQuery.value.trim().toLocaleLowerCase())
const visibleTasks = computed(() => tasks.value.filter(task => {
  if (providerFilter.value !== 'all' && task.provider !== providerFilter.value) return false
  if (scopeFilter.value === 'recent' && task.archivedAt) return false
  if (scopeFilter.value === 'archived' && !task.archivedAt) return false
  if (!normalizedSearch.value) return true
  return [task.title, task.firstMessage, task.provider, task.providerSessionId]
    .filter(Boolean).join(' ').toLocaleLowerCase().includes(normalizedSearch.value)
}))

const runningTasks = computed(() => visibleTasks.value.filter(task => task.state === 'querying' || task.state === 'canceling'))
const readyTasks = computed(() => visibleTasks.value.filter(task => task.state !== 'querying' && task.state !== 'canceling'))

onMounted(() => state.loadWorkspace())
watch(project, value => { if (value) void refreshTasks() }, { immediate: true })
watch([project, providers], ([nextProject, nextProviders]) => {
  if (!selectedProvider.value || !nextProviders.includes(selectedProvider.value)) {
    selectedProvider.value = nextProject?.defaultProvider ?? nextProviders[0] ?? ''
  }
}, { immediate: true })

function openCreate(): void {
  createError.value = ''
  showCreate.value = true
  void nextTick(() => creatorElement.value?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}

async function refreshTasks(): Promise<void> {
  const generation = ++discoveryGeneration
  const currentProjectId = projectId.value
  const currentProviders = [...providers.value]
  discovering.value = true
  taskError.value = ''
  try {
    await state.loadCachedProviderSessions(currentProjectId)
    await state.loadSessions(currentProjectId)
    const attempts = await Promise.allSettled(currentProviders.map(provider =>
      state.api.discoverProviderSessions(currentProjectId, provider),
    ))
    if (generation !== discoveryGeneration) return
    const successful = attempts.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    if (successful.length || currentProviders.length === 0) {
      state.replaceProviderSessions(currentProjectId, successful.flatMap(result => result.sessions))
    }
    if (!successful.length && attempts.some(result => result.status === 'rejected')) {
      throw new Error('Provider task history could not be loaded')
    }
  } catch (error) {
    if (generation === discoveryGeneration) {
      taskError.value = error instanceof Error ? error.message : 'Could not load project tasks'
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
    createError.value = error instanceof Error ? error.message : 'Could not create the task'
  } finally {
    creating.value = false
  }
}

async function openTask(task: ProjectTask): Promise<void> {
  if (openingKey.value || archivingKey.value) return
  openingKey.value = task.key
  taskError.value = ''
  try {
    let sessionId = task.codeverSessionId
    if (!sessionId) {
      const session = await state.api.createSession(projectId.value, {
        provider: task.provider,
        providerSessionId: task.providerSessionId,
        title: task.title,
        config: {},
      })
      state.replaceSession(session)
      sessionId = session.id
    }
    await openSession(sessionId)
  } catch (error) {
    taskError.value = error instanceof Error ? error.message : 'Could not open the task'
  } finally {
    openingKey.value = ''
  }
}

async function toggleArchive(task: ProjectTask): Promise<void> {
  if (openingKey.value || archivingKey.value) return
  archivingKey.value = task.key
  taskError.value = ''
  try {
    let sessionId = task.codeverSessionId
    if (!sessionId) {
      const bridge = await state.api.createSession(projectId.value, {
        provider: task.provider,
        providerSessionId: task.providerSessionId,
        title: task.title,
        config: {},
      })
      state.replaceSession(bridge)
      sessionId = bridge.id
    }
    await state.api.setSessionArchived(sessionId, !task.archivedAt)
    await refreshTasks()
  } catch (error) {
    taskError.value = error instanceof Error ? error.message : 'Could not update the task'
  } finally {
    archivingKey.value = ''
  }
}

async function openSession(sessionId: string): Promise<void> {
  await router.push({ name: 'session', params: { gatewayId: gatewayId.value, projectId: projectId.value, sessionId } })
}
</script>

<template>
  <div class="page page--overview page--project-tasks">
    <header class="page-header project-title project-title--compact">
      <div>
        <h1>{{ project?.name ?? 'Project' }}</h1>
        <small class="project-location">{{ gateway?.name }}</small>
        <details v-if="project" class="project-details">
          <summary>Project details</summary>
          <dl>
            <div><dt>Path</dt><dd>{{ project.rootPath }}</dd></div>
            <div><dt>Gateway</dt><dd>{{ gateway?.name }} · {{ gateway?.platform }}</dd></div>
            <div v-if="project.defaultProvider"><dt>Default provider</dt><dd>{{ project.defaultProvider }}</dd></div>
          </dl>
        </details>
      </div>
      <button class="button button--primary" :disabled="!gatewayIsMutable(gateway)" @click="openCreate">＋ New task</button>
    </header>

    <section v-if="showCreate" ref="creatorElement" class="session-creator" aria-label="Create a new task">
      <div class="session-creator__heading">
        <div><span class="eyebrow">New task</span><h2>Start with a fresh provider session</h2></div>
        <button class="icon-button" aria-label="Close" @click="showCreate = false">×</button>
      </div>
      <label class="creator-provider"><span>Provider</span><select v-model="selectedProvider"><option v-for="provider in providers" :key="provider" :value="provider">{{ provider }}</option></select></label>
      <div v-if="createError" class="error-banner"><strong>Task unavailable</strong>{{ createError }}</div>
      <form class="fresh-session-form" @submit.prevent="createNewSession">
        <label><span>Task title</span><input v-model="title" autofocus placeholder="Optional — describe the task" /></label>
        <button class="button button--primary" :disabled="creating || !selectedProvider">{{ creating ? 'Creating…' : 'Create task' }}</button>
      </form>
    </section>

    <section class="sessions-section sessions-section--primary">
      <div class="section-heading sessions-heading">
        <div><h2>Tasks</h2><span class="task-count">{{ visibleTasks.length }}</span></div>
        <div class="session-list-actions">
          <button class="button button--compact" :class="{ 'button--selected': showFilters }" @click="showFilters = !showFilters">Filter</button>
          <button class="button button--compact" :disabled="discovering" @click="refreshTasks">Refresh</button>
        </div>
      </div>

      <div v-if="showFilters" class="session-filters" aria-label="Task filters">
        <label class="session-search"><span class="sr-only">Search tasks</span><input v-model="searchQuery" type="search" placeholder="Search tasks" /></label>
        <label><span class="sr-only">Task collection</span><select v-model="scopeFilter"><option value="recent">Recent</option><option value="archived">Archived</option><option value="all">All tasks</option></select></label>
        <label><span class="sr-only">Provider</span><select v-model="providerFilter"><option value="all">All providers</option><option v-for="provider in providers" :key="provider" :value="provider">{{ provider }}</option></select></label>
      </div>

      <div v-if="taskError" class="error-banner"><strong>Tasks unavailable</strong>{{ taskError }}</div>
      <div v-if="discovering" class="session-refresh-state" role="status"><span class="loader" /><span><strong>Refreshing tasks</strong><small>Loaded tasks remain available while provider history is updated.</small></span></div>

      <template v-if="runningTasks.length">
        <div class="session-group-label"><span>Running</span><small>{{ runningTasks.length }}</small></div>
        <div class="session-table">
          <article v-for="task in runningTasks" :key="task.key" class="session-row session-row--task" tabindex="0" @click="openTask(task)" @keydown.enter="openTask(task)">
            <StatusDot :status="task.state ?? 'idle'" />
            <div><strong>{{ task.title }}</strong><small>{{ task.provider }} · {{ gateway?.name }}</small></div>
            <span class="session-mode">{{ task.state }}</span>
            <time>{{ new Date(task.updatedAt).toLocaleString() }}</time>
            <button class="task-archive" @click.stop="toggleArchive(task)">{{ task.archivedAt ? 'Restore' : 'Archive' }}</button>
          </article>
        </div>
      </template>

      <div class="session-group-label" :class="{ 'session-group-label--inactive': runningTasks.length }"><span>{{ scopeFilter === 'archived' ? 'Archived' : 'Ready to continue' }}</span><small>{{ readyTasks.length }}</small></div>
      <div v-if="readyTasks.length" class="session-table">
        <article v-for="task in readyTasks" :key="task.key" class="session-row session-row--task" tabindex="0" @click="openTask(task)" @keydown.enter="openTask(task)">
          <StatusDot :status="task.state ?? 'idle'" />
          <div><strong>{{ task.title }}</strong><small>{{ task.firstMessage || `${task.provider} · ${gateway?.name}` }}</small></div>
          <span class="session-mode">{{ task.draft ? 'draft' : task.provider }}</span>
          <time>{{ new Date(task.updatedAt).toLocaleString() }}</time>
          <button class="task-archive" :disabled="archivingKey === task.key" @click.stop="toggleArchive(task)">{{ task.archivedAt ? 'Restore' : 'Archive' }}</button>
        </article>
      </div>
      <div v-else-if="discovering" class="session-group-empty">Waiting for the first provider tasks…</div>
      <p v-else class="session-group-empty">No tasks match these filters.</p>

    </section>
  </div>
</template>
