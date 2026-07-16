<script setup lang="ts">
import type { CodeverSession, ProviderSession, ProviderSessionListDto } from '@codever/protocol'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import StatusDot from '../components/StatusDot.vue'
import { gatewayIsMutable, useCodeverState } from '../state/codeverState'

const route = useRoute()
const router = useRouter()
const state = useCodeverState()
const gatewayId = computed(() => String(route.params.gatewayId))
const projectId = computed(() => String(route.params.projectId))
const provider = computed(() => String(route.params.provider))
const gateway = computed(() => state.gateways.value.find(item => item.id === gatewayId.value))
const project = computed(() => (state.projectsByGateway[gatewayId.value] ?? []).find(item => item.id === projectId.value))
const connected = computed(() => (state.sessionsByProject[projectId.value] ?? [])
  .filter(session => session.provider === provider.value && session.state !== 'closed')
  .sort((a, b) => rank(b) - rank(a) || b.updatedAt.localeCompare(a.updatedAt)))
const discovery = ref<ProviderSessionListDto>()
const loading = ref(false)
const error = ref('')
const openingId = ref('')

onMounted(() => state.loadGateways())
watch(gatewayId, id => void state.loadProjects(id), { immediate: true })
watch(projectId, id => void state.loadSessions(id), { immediate: true })
watch([projectId, provider], () => void discover(), { immediate: true })

async function discover(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    discovery.value = await state.api.discoverProviderSessions(projectId.value, provider.value)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not discover provider sessions'
  } finally {
    loading.value = false
  }
}

async function openNative(session: ProviderSession): Promise<void> {
  if (openingId.value) return
  openingId.value = session.providerSessionId
  error.value = ''
  try {
    const bridge = session.codeverSessionId
      ? connected.value.find(item => item.id === session.codeverSessionId)
      : await state.api.createSession(projectId.value, {
          provider: provider.value,
          providerSessionId: session.providerSessionId,
          title: session.title,
          config: {},
        })
    if (!bridge) throw new Error('The connected session is no longer available')
    state.replaceSession(bridge)
    await openBridge(bridge)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not continue provider session'
  } finally {
    openingId.value = ''
  }
}

async function startNew(): Promise<void> {
  if (openingId.value || !gatewayIsMutable(gateway.value)) return
  openingId.value = '__new__'
  error.value = ''
  try {
    const session = await state.api.createSession(projectId.value, {
      provider: provider.value,
      title: `New ${provider.value} task`,
      config: {},
    })
    state.replaceSession(session)
    await openBridge(session)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not start a new task'
  } finally {
    openingId.value = ''
  }
}

async function openBridge(session: CodeverSession): Promise<void> {
  await router.push({
    name: 'session',
    params: { gatewayId: gatewayId.value, projectId: projectId.value, provider: provider.value, sessionId: session.id },
  })
}

function rank(session: CodeverSession): number {
  return session.state === 'querying' ? 3 : session.state === 'canceling' ? 2 : session.state === 'idle' ? 1 : 0
}
</script>

<template>
  <div class="page page--overview">
    <header class="page-header project-title">
      <div><span class="eyebrow">{{ gateway?.name }} · {{ project?.name }}</span><h1>{{ provider }}</h1><p>Continue the provider's native sessions directly.</p></div>
      <button class="button button--primary" :disabled="!gatewayIsMutable(gateway) || Boolean(openingId)" @click="startNew">{{ openingId === '__new__' ? 'Starting…' : '＋ New task' }}</button>
    </header>
    <div v-if="error" class="error-banner"><strong>Provider unavailable</strong>{{ error }} <button class="text-link" @click="discover">Retry</button></div>

    <section v-if="connected.length">
      <div class="section-heading"><div><span class="eyebrow">Ready to continue</span><h2>Connected sessions</h2></div><span>{{ connected.length }}</span></div>
      <div class="session-table">
        <button v-for="session in connected" :key="session.id" class="session-row session-row--button" @click="openBridge(session)">
          <StatusDot :status="session.state" />
          <div><strong>{{ session.title ?? 'Untitled session' }}</strong><small>{{ session.model ?? 'Default model' }}</small></div>
          <span class="session-mode">{{ session.state }}</span>
          <time>{{ new Date(session.updatedAt).toLocaleString() }}</time><span>→</span>
        </button>
      </div>
    </section>

    <section>
      <div class="section-heading"><div><span class="eyebrow">On this machine</span><h2>Provider history</h2></div><button class="button" :disabled="loading" @click="discover">{{ loading ? 'Scanning…' : 'Refresh' }}</button></div>
      <div v-if="discovery?.sessions.length" class="session-table">
        <button v-for="session in discovery.sessions" :key="session.providerSessionId" class="session-row session-row--button" :disabled="Boolean(openingId)" @click="openNative(session)">
          <StatusDot :status="session.state ?? 'offline'" />
          <div><strong>{{ session.title }}</strong><small>{{ session.firstMessage || session.providerSessionId }}</small></div>
          <span class="session-mode">{{ session.codeverSessionId ? 'connected' : 'native' }}</span>
          <time>{{ new Date(session.updatedAt).toLocaleString() }}</time><span>{{ openingId === session.providerSessionId ? '…' : '→' }}</span>
        </button>
      </div>
      <div v-else-if="!loading" class="empty-state empty-state--compact">
        <h2>{{ discovery?.discoverySupported === false ? 'History discovery is not supported' : 'No provider sessions found' }}</h2>
        <p>You can still start a new task with this provider.</p>
      </div>
    </section>
  </div>
</template>
