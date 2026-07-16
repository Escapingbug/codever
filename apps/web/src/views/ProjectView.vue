<script setup lang="ts">
import type { CreateSessionDto } from '@codever/protocol'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import StatusDot from '../components/StatusDot.vue'
import { gatewayIsMutable, useCodeverState } from '../state/codeverState'

const route = useRoute()
const router = useRouter()
const state = useCodeverState()
const gatewayId = computed(() => String(route.params.gatewayId))
const projectId = computed(() => String(route.params.projectId))
const gateway = computed(() => state.gateways.value.find((item) => item.id === gatewayId.value))
const project = computed(() => (state.projectsByGateway[gatewayId.value] ?? []).find((item) => item.id === projectId.value))
const sessions = computed(() => state.sessionsByProject[projectId.value] ?? [])
const showCreate = ref(false)
const creating = ref(false)
const createError = ref('')
const draft = reactive({ title: '', provider: '', model: '', mode: 'agent' })

onMounted(() => state.loadGateways())
watch(gatewayId, (id) => void state.loadProjects(id), { immediate: true })
watch(projectId, (id) => void state.loadSessions(id), { immediate: true })
watch([project, gateway], ([nextProject, nextGateway]) => {
  if (!draft.provider) draft.provider = nextProject?.defaultProvider ?? nextGateway?.capabilities.providers[0] ?? ''
}, { immediate: true })

async function createSession(): Promise<void> {
  if (!draft.provider) return
  creating.value = true
  createError.value = ''
  const body: CreateSessionDto = {
    provider: draft.provider,
    title: draft.title.trim() || undefined,
    model: draft.model.trim() || undefined,
    mode: draft.mode || undefined,
    config: {},
  }
  try {
    const session = await state.api.createSession(projectId.value, body)
    state.replaceSession(session)
    await router.push(`/gateways/${gatewayId.value}/projects/${projectId.value}/sessions/${session.id}`)
  } catch (error) {
    createError.value = error instanceof Error ? error.message : 'Could not create session'
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="page page--overview">
    <header class="page-header project-title">
      <div><span class="eyebrow">Project · {{ gateway?.name }}</span><h1>{{ project?.name ?? 'Project' }}</h1><p>{{ project?.repoIdentity ?? project?.rootPath }}</p></div>
      <button class="button button--primary" :disabled="!gatewayIsMutable(gateway)" @click="showCreate = !showCreate">＋ New session</button>
    </header>
    <div v-if="gateway && !gatewayIsMutable(gateway)" class="offline-banner"><strong>Gateway offline.</strong> New sessions and execution are disabled.</div>
    <form v-if="showCreate" class="create-session" @submit.prevent="createSession">
      <div><span class="eyebrow">New session</span><h2>What are we working on?</h2></div>
      <label><span>Title</span><input v-model="draft.title" autofocus placeholder="Optional session title" /></label>
      <label><span>Provider</span><select v-model="draft.provider" required><option v-for="provider in gateway?.capabilities.providers" :key="provider">{{ provider }}</option></select></label>
      <label><span>Model</span><input v-model="draft.model" placeholder="Provider default" /></label>
      <label><span>Mode</span><select v-model="draft.mode"><option value="agent">Agent</option><option value="ask">Ask</option><option value="plan">Plan</option></select></label>
      <div class="form-actions"><span v-if="createError" class="inline-error">{{ createError }}</span><button type="button" class="button" @click="showCreate = false">Cancel</button><button class="button button--primary" :disabled="creating">{{ creating ? 'Creating…' : 'Create session' }}</button></div>
    </form>
    <section>
      <div class="section-heading"><div><span class="eyebrow">Recent activity</span><h2>Sessions</h2></div><span>{{ sessions.length }} total</span></div>
      <div class="session-table">
        <RouterLink v-for="session in sessions" :key="session.id" class="session-row" :to="`/gateways/${gatewayId}/projects/${projectId}/sessions/${session.id}`">
          <StatusDot :status="session.state" />
          <div><strong>{{ session.title ?? 'Untitled session' }}</strong><small>{{ session.provider }} · {{ session.model ?? 'default model' }}</small></div>
          <span class="session-mode">{{ session.mode ?? 'default' }}</span>
          <time>{{ new Date(session.updatedAt).toLocaleDateString() }}</time><span>→</span>
        </RouterLink>
      </div>
      <div v-if="!sessions.length && !state.pending.value.has(`sessions:${projectId}`)" class="empty-state"><span class="empty-orbit">✦</span><h2>No sessions yet</h2><p>Create one to start working in this project.</p></div>
    </section>
  </div>
</template>
