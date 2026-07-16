<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import StatusDot from '../components/StatusDot.vue'
import { useCodeverState } from '../state/codeverState'

const route = useRoute()
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

onMounted(() => state.loadGateways())
watch(gatewayId, id => void state.loadProjects(id), { immediate: true })
watch(projectId, id => void state.loadSessions(id), { immediate: true })

function providerSessionCount(provider: string): number {
  return sessions.value.filter(session => session.provider === provider && session.state !== 'closed').length
}
</script>

<template>
  <div class="page page--overview">
    <header class="page-header project-title">
      <div><span class="eyebrow">Project · {{ gateway?.name }}</span><h1>{{ project?.name ?? 'Project' }}</h1><p>{{ project?.repoIdentity ?? project?.rootPath }}</p></div>
    </header>

    <section v-if="activeSessions.length">
      <div class="section-heading"><div><span class="eyebrow">Running now</span><h2>Active sessions</h2></div><span>{{ activeSessions.length }}</span></div>
      <div class="session-table">
        <RouterLink
          v-for="session in activeSessions"
          :key="session.id"
          class="session-row"
          :to="{ name: 'session', params: { gatewayId, projectId, provider: session.provider, sessionId: session.id } }"
        >
          <StatusDot :status="session.state" />
          <div><strong>{{ session.title ?? 'Untitled session' }}</strong><small>{{ session.provider }} · {{ session.model ?? 'default model' }}</small></div>
          <span class="session-mode">{{ session.mode ?? 'default' }}</span>
          <time>{{ new Date(session.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</time><span>→</span>
        </RouterLink>
      </div>
    </section>

    <section>
      <div class="section-heading"><div><span class="eyebrow">Choose the agent first</span><h2>Providers</h2></div><span>{{ providers.length }} available</span></div>
      <div class="project-grid provider-grid">
        <RouterLink
          v-for="provider in providers"
          :key="provider"
          class="project-card provider-card"
          :to="{ name: 'provider', params: { gatewayId, projectId, provider } }"
        >
          <span class="provider-glyph">{{ provider.slice(0, 1).toUpperCase() }}</span>
          <div><h3>{{ provider }}</h3><p>Browse native history and continue existing work</p><small>{{ providerSessionCount(provider) }} connected in Codever</small></div>
          <span>→</span>
        </RouterLink>
      </div>
      <div v-if="!providers.length" class="empty-state empty-state--compact"><h2>No providers available</h2><p>This Gateway has not advertised any agent providers.</p></div>
    </section>
  </div>
</template>
