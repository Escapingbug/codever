<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useCodeverState } from '../state/codeverState'
import StatusDot from './StatusDot.vue'

const route = useRoute()
const state = useCodeverState()
const gatewayId = computed(() => String(route.params.gatewayId ?? ''))
const projectId = computed(() => String(route.params.projectId ?? ''))
const projects = computed(() => state.projectsByGateway[gatewayId.value] ?? [])
const sessions = computed(() => state.sessionsByProject[projectId.value] ?? [])
const gatewayLink = (id: string) => `/gateways/${id}`

onMounted(() => state.loadGateways())
watch(gatewayId, (id) => { if (id) void state.loadProjects(id) }, { immediate: true })
watch(projectId, (id) => { if (id) void state.loadSessions(id) }, { immediate: true })
</script>

<template>
  <aside class="nav-rail nav-rail--gateways">
    <RouterLink class="brand" to="/gateways" aria-label="Codever gateways">
      <span class="brand-mark">C</span>
      <span>Codever</span>
    </RouterLink>
    <div class="rail-heading">
      <span>Gateways</span>
      <button class="icon-button" title="Refresh gateways" @click="state.loadGateways">↻</button>
    </div>
    <div v-if="state.errors.gateways" class="inline-error">{{ state.errors.gateways }}</div>
    <nav class="nav-list" aria-label="Gateways">
      <RouterLink
        v-for="gateway in state.gateways.value"
        :key="gateway.id"
        class="nav-item"
        :class="{ 'nav-item--active': gateway.id === gatewayId }"
        :to="gatewayLink(gateway.id)"
      >
        <StatusDot :status="gateway.status" />
        <span class="nav-item-copy">
          <strong>{{ gateway.name }}</strong>
          <small>{{ gateway.platform }} · {{ gateway.version }}</small>
        </span>
      </RouterLink>
    </nav>
  </aside>

  <aside v-if="gatewayId" class="nav-rail nav-rail--sessions">
    <div class="rail-heading rail-heading--large">
      <div>
        <small>Workspace</small>
        <strong>{{ state.gateways.value.find((item) => item.id === gatewayId)?.name ?? 'Gateway' }}</strong>
      </div>
    </div>
    <nav class="project-list" aria-label="Projects and sessions">
      <section v-for="project in projects" :key="project.id" class="project-group">
        <RouterLink
          class="project-link"
          :class="{ 'project-link--active': project.id === projectId }"
          :to="`/gateways/${gatewayId}/projects/${project.id}`"
        >
          <span>⌘</span>
          <span>
            <strong>{{ project.name }}</strong>
            <small>{{ project.repoIdentity ?? project.rootPath }}</small>
          </span>
        </RouterLink>
        <div v-if="project.id === projectId" class="session-links">
          <RouterLink
            v-for="session in sessions"
            :key="session.id"
            class="session-link"
            :to="`/gateways/${gatewayId}/projects/${project.id}/sessions/${session.id}`"
          >
            <StatusDot :status="session.state" />
            <span>
              <strong>{{ session.title ?? 'Untitled session' }}</strong>
              <small>{{ session.provider }}<template v-if="session.model"> · {{ session.model }}</template></small>
            </span>
          </RouterLink>
          <span v-if="!sessions.length" class="nav-empty">No sessions yet</span>
        </div>
      </section>
    </nav>
  </aside>
</template>
