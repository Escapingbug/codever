<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useCodeverState } from '../state/codeverState'
import StatusDot from './StatusDot.vue'

const route = useRoute()
const state = useCodeverState()
const gatewayId = computed(() => String(route.params.gatewayId ?? ''))
const projectId = computed(() => String(route.params.projectId ?? ''))
const sessions = computed(() => (state.sessionsByProject[projectId.value] ?? [])
  .filter(session => session.state !== 'closed' && !session.archivedAt)
  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
const projects = computed(() => state.gateways.value.flatMap(gateway =>
  (state.projectsByGateway[gateway.id] ?? []).map(project => ({ gateway, project })),
))
const currentProject = computed(() => projects.value.find(entry =>
  entry.gateway.id === gatewayId.value && entry.project.id === projectId.value,
))

onMounted(() => state.loadWorkspace())
watch(projectId, id => { if (id) void state.loadSessions(id) }, { immediate: true })
</script>

<template>
  <aside class="nav-rail nav-rail--gateways">
    <RouterLink class="brand" to="/projects" aria-label="Codever projects"><span class="brand-mark">C</span><span>Codever</span></RouterLink>
    <nav class="primary-nav" aria-label="Primary navigation">
      <RouterLink to="/projects"><span>▣</span><strong>Projects</strong></RouterLink>
      <RouterLink to="/machines"><span>⌘</span><strong>Computers</strong></RouterLink>
      <RouterLink to="/settings"><span>⚙</span><strong>Settings</strong></RouterLink>
    </nav>
    <div class="rail-heading"><span>Recent projects</span><button class="icon-button" title="Refresh projects" @click="state.loadWorkspace">↻</button></div>
    <nav class="nav-list" aria-label="Projects">
      <RouterLink
        v-for="entry in projects"
        :key="`${entry.gateway.id}:${entry.project.id}`"
        class="nav-item"
        :class="{ 'nav-item--active': entry.project.id === projectId && entry.gateway.id === gatewayId }"
        :to="{ name: 'project', params: { gatewayId: entry.gateway.id, projectId: entry.project.id } }"
      >
        <StatusDot :status="entry.gateway.status" />
        <span class="nav-item-copy"><strong>{{ entry.project.name }}</strong><small>{{ entry.gateway.name }}</small></span>
      </RouterLink>
      <span v-if="!projects.length" class="nav-empty">Your projects will appear here</span>
    </nav>
  </aside>

  <aside v-if="currentProject" class="nav-rail nav-rail--sessions">
    <div class="rail-heading rail-heading--large"><div><small>{{ currentProject.gateway.name }}</small><strong>{{ currentProject.project.name }}</strong></div></div>
    <nav class="project-list" aria-label="Recently attached tasks">
      <RouterLink v-for="session in sessions" :key="session.id" class="session-link" :to="{ name: 'session', params: { gatewayId, projectId, sessionId: session.id } }">
        <StatusDot :status="session.state" /><span><strong>{{ session.title ?? 'Untitled session' }}</strong><small>{{ session.provider }}<template v-if="session.model"> · {{ session.model }}</template></small></span>
      </RouterLink>
      <span v-if="!sessions.length" class="nav-empty">Open a task to attach it here</span>
    </nav>
  </aside>
</template>
