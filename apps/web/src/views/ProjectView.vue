<script setup lang="ts">
import type { CodeverSession, ProviderSession } from '@codever/protocol'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import StatusDot from '../components/StatusDot.vue'
import { clientSession } from '../state/clientSession'
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
const projectMutable = computed(() => gatewayIsMutable(gateway.value) && clientSession.connectionState.value === 'connected')
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
const renamingTask = ref<ProjectTask>()
const renameTitle = ref('')
const renaming = ref(false)
const creatorElement = ref<HTMLElement>()
let discoveryGeneration = 0
let longPressTimer: ReturnType<typeof setTimeout> | undefined
let longPressOrigin: { x: number; y: number } | undefined
let suppressTaskClick = false

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
    const linked = [...result.values()].find(task => task.codeverSessionId === bridge.id)
    if (linked) {
      linked.title = bridge.title ?? linked.title
      linked.state = bridge.state
      linked.updatedAt = bridge.updatedAt > linked.updatedAt ? bridge.updatedAt : linked.updatedAt
      linked.archivedAt = bridge.archivedAt
      linked.draft = false
      continue
    }
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
onBeforeUnmount(() => { discoveryGeneration += 1 })
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
  taskError.value = ''
  try {
    // Cached task rows are the page's usable state. Network discovery only
    // refreshes them in the background and must never gate opening a task.
    await state.hydrateProject(currentProjectId)
    state.api.rememberRoute(gatewayId.value, currentProjectId)
    if (generation !== discoveryGeneration) return
    discovering.value = true
    const sessionsRefresh = state.loadSessions(currentProjectId)
    const attempts: PromiseSettledResult<Awaited<ReturnType<typeof state.api.discoverProviderSessions>>>[] = []
    const orderedProviders = currentProviders.includes(selectedProvider.value)
      ? [selectedProvider.value, ...currentProviders.filter(provider => provider !== selectedProvider.value)]
      : [...currentProviders]
    for (const provider of orderedProviders) {
      if (generation !== discoveryGeneration) return
      try {
        const result = await state.api.discoverProviderSessions(currentProjectId, provider)
        attempts.push({ status: 'fulfilled', value: result })
        if (generation === discoveryGeneration) {
          // Replace only the Provider that answered. Cached rows from slow or
          // failed Providers remain navigable throughout the refresh.
          state.replaceProviderSessions(currentProjectId, [
            ...providerSessions.value.filter(session => session.provider !== result.provider),
            ...result.sessions,
          ])
        }
      } catch (reason) {
        attempts.push({ status: 'rejected', reason })
      }
      if (generation !== discoveryGeneration) return
      if (provider !== orderedProviders.at(-1)) await new Promise(resolve => setTimeout(resolve, 1_000))
    }
    await sessionsRefresh
    if (generation !== discoveryGeneration) return
    const successful = attempts.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    if (currentProviders.length === 0) state.replaceProviderSessions(currentProjectId, [])
    if (!successful.length && attempts.some(result => result.status === 'rejected')) {
      const failures = attempts.flatMap((result, index) => result.status === 'rejected'
        ? [`${orderedProviders[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
        : [])
      throw new Error(`Provider task history could not be loaded (${failures.join('; ')})`)
    }
  } catch (error) {
    if (generation === discoveryGeneration) {
      taskError.value = error instanceof Error ? error.message : 'Could not refresh project tasks'
    }
  } finally {
    if (generation === discoveryGeneration) discovering.value = false
  }
}

async function createNewSession(): Promise<void> {
  if (!selectedProvider.value || creating.value) return
  // Interactive work takes priority over background Provider discovery. The
  // in-flight request may finish, but no further discovery commands are sent.
  discoveryGeneration += 1
  discovering.value = false
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
  if (suppressTaskClick) {
    suppressTaskClick = false
    return
  }
  // A linked Codever Session is already a complete navigation target. Opening
  // it must not wait behind Provider discovery or another attach operation.
  if (task.codeverSessionId) {
    await openSession(task.codeverSessionId)
    return
  }
  if (openingKey.value || archivingKey.value) return
  if (!task.codeverSessionId && !projectMutable.value) {
    taskError.value = 'Restore Matrix sync and Gateway connectivity before attaching a provider task'
    return
  }
  openingKey.value = task.key
  taskError.value = ''
  try {
    const session = await state.api.createSession(projectId.value, {
      provider: task.provider,
      providerSessionId: task.providerSessionId,
      title: task.title,
      config: {},
    })
    state.replaceSession(session)
    const sessionId = session.id
    await openSession(sessionId)
  } catch (error) {
    taskError.value = error instanceof Error ? error.message : 'Could not open the task'
  } finally {
    openingKey.value = ''
  }
}

function beginLongPress(event: PointerEvent, task: ProjectTask): void {
  if (event.pointerType === 'mouse' && event.button !== 0) return
  cancelLongPress()
  longPressOrigin = { x: event.clientX, y: event.clientY }
  longPressTimer = setTimeout(() => {
    suppressTaskClick = true
    openRename(task)
  }, 550)
}

function moveLongPress(event: PointerEvent): void {
  if (!longPressOrigin) return
  if (Math.hypot(event.clientX - longPressOrigin.x, event.clientY - longPressOrigin.y) > 10) cancelLongPress()
}

function cancelLongPress(): void {
  if (longPressTimer) clearTimeout(longPressTimer)
  longPressTimer = undefined
  longPressOrigin = undefined
}

function openRename(task: ProjectTask): void {
  cancelLongPress()
  if (!task.codeverSessionId) {
    taskError.value = 'Open this provider task once before renaming it in Codever'
    return
  }
  renamingTask.value = task
  renameTitle.value = task.title
}

function closeRename(): void {
  if (renaming.value) return
  renamingTask.value = undefined
  renameTitle.value = ''
}

async function renameSession(): Promise<void> {
  const task = renamingTask.value
  const nextTitle = renameTitle.value.trim()
  if (!task?.codeverSessionId || !nextTitle || renaming.value) return
  renaming.value = true
  taskError.value = ''
  try {
    await state.api.renameSession(task.codeverSessionId, { title: nextTitle })
    const existing = bridges.value.find(item => item.id === task.codeverSessionId)
    if (existing) state.replaceSession({ ...existing, title: nextTitle, updatedAt: new Date().toISOString() })
    closeRename()
  } catch (error) {
    taskError.value = error instanceof Error ? error.message : 'Could not rename the task'
  } finally {
    renaming.value = false
    if (renamingTask.value === task && !taskError.value) closeRename()
  }
}

async function toggleArchive(task: ProjectTask): Promise<void> {
  if (openingKey.value || archivingKey.value || !projectMutable.value) return
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
      <button class="button button--primary" :disabled="!projectMutable" @click="openCreate">＋ New task</button>
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

      <div v-if="taskError" class="error-banner"><strong>Refresh incomplete</strong>{{ taskError }}</div>
      <div v-if="discovering" class="session-refresh-state" role="status"><span class="loader" /><span><strong>Refreshing tasks</strong><small>Loaded tasks remain available while provider history is updated.</small></span></div>

      <template v-if="runningTasks.length">
        <div class="session-group-label"><span>Running</span><small>{{ runningTasks.length }}</small></div>
        <div class="session-table">
          <article v-for="task in runningTasks" :key="task.key" class="session-row session-row--task" tabindex="0" role="button" :aria-label="`Open task ${task.title}`" :data-session-id="task.codeverSessionId || undefined" @click="openTask(task)" @keydown.enter="openTask(task)" @contextmenu.prevent="openRename(task)" @pointerdown="beginLongPress($event, task)" @pointermove="moveLongPress" @pointerup="cancelLongPress" @pointercancel="cancelLongPress">
            <StatusDot :status="task.state ?? 'idle'" />
            <div><strong>{{ task.title }}</strong><small>{{ task.provider }} · {{ gateway?.name }}</small></div>
            <span class="session-mode">{{ task.state }}</span>
            <time>{{ new Date(task.updatedAt).toLocaleString() }}</time>
            <button class="task-archive" :disabled="!projectMutable || archivingKey === task.key" @click.stop="toggleArchive(task)">{{ task.archivedAt ? 'Restore' : 'Archive' }}</button>
          </article>
        </div>
      </template>

      <div class="session-group-label" :class="{ 'session-group-label--inactive': runningTasks.length }"><span>{{ scopeFilter === 'archived' ? 'Archived' : 'Ready to continue' }}</span><small>{{ readyTasks.length }}</small></div>
      <div v-if="readyTasks.length" class="session-table">
        <article v-for="task in readyTasks" :key="task.key" class="session-row session-row--task" tabindex="0" role="button" :aria-label="`Open task ${task.title}`" :data-session-id="task.codeverSessionId || undefined" @click="openTask(task)" @keydown.enter="openTask(task)" @contextmenu.prevent="openRename(task)" @pointerdown="beginLongPress($event, task)" @pointermove="moveLongPress" @pointerup="cancelLongPress" @pointercancel="cancelLongPress">
          <StatusDot :status="task.state ?? 'idle'" />
          <div><strong>{{ task.title }}</strong><small>{{ task.firstMessage || `${task.provider} · ${gateway?.name}` }}</small></div>
          <span class="session-mode">{{ task.draft ? 'draft' : task.provider }}</span>
          <time>{{ new Date(task.updatedAt).toLocaleString() }}</time>
          <button class="task-archive" :disabled="!projectMutable || archivingKey === task.key" @click.stop="toggleArchive(task)">{{ task.archivedAt ? 'Restore' : 'Archive' }}</button>
        </article>
      </div>
      <div v-else-if="discovering" class="session-group-empty">Waiting for the first provider tasks…</div>
      <p v-else class="session-group-empty">No tasks match these filters.</p>

    </section>

    <div v-if="renamingTask" class="dialog-backdrop" @click.self="closeRename">
      <section class="settings-card rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-task-title">
        <div class="session-creator__heading"><div><span class="eyebrow">Task</span><h2 id="rename-task-title">Rename task</h2></div><button class="icon-button" aria-label="Close rename dialog" @click="closeRename">×</button></div>
        <form class="fresh-session-form" @submit.prevent="renameSession">
          <label><span>Title</span><input v-model="renameTitle" autofocus maxlength="200" /></label>
          <div class="dialog-actions"><button type="button" class="button" :disabled="renaming" @click="closeRename">Cancel</button><button class="button button--primary" :disabled="renaming || !renameTitle.trim()">{{ renaming ? 'Saving…' : 'Save' }}</button></div>
        </form>
      </section>
    </div>
  </div>
</template>
