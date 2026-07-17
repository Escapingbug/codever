<script setup lang="ts">
import { computed, onMounted } from 'vue'
import StatusDot from '../components/StatusDot.vue'
import { useCodeverState } from '../state/codeverState'

const state = useCodeverState()
const projects = computed(() => state.gateways.value.flatMap(gateway =>
  (state.projectsByGateway[gateway.id] ?? []).map(project => ({ project, gateway })),
))
const unavailableGateways = computed(() => state.gateways.value.filter(gateway =>
  state.errors[`projects:${gateway.id}`],
))

onMounted(() => state.loadWorkspace())
</script>

<template>
  <div class="page page--overview">
    <header class="page-header">
      <div><span class="eyebrow">Your workspace</span><h1>Projects</h1><p>Continue work across every connected machine.</p></div>
      <button class="button" :disabled="state.pending.value.has('gateways')" @click="state.loadWorkspace">Refresh</button>
    </header>
    <div v-if="state.errors.gateways" class="error-banner"><strong>Relay unavailable</strong>{{ state.errors.gateways }}</div>

    <div v-if="projects.length" class="project-grid">
      <RouterLink
        v-for="entry in projects"
        :key="`${entry.gateway.id}:${entry.project.id}`"
        class="project-card"
        :to="{ name: 'project', params: { gatewayId: entry.gateway.id, projectId: entry.project.id } }"
      >
        <span class="folder-icon">◇</span>
        <div>
          <h3>{{ entry.project.name }}</h3>
          <p>{{ entry.project.repoIdentity ?? entry.project.rootPath }}</p>
          <small class="gateway-label"><StatusDot :status="entry.gateway.status" /> {{ entry.gateway.name }}</small>
        </div>
        <span class="card-arrow">→</span>
      </RouterLink>
    </div>

    <section v-if="unavailableGateways.length" class="unavailable-gateways">
      <div class="section-heading"><div><span class="eyebrow">Needs attention</span><h2>Unavailable projects</h2></div></div>
      <RouterLink v-for="gateway in unavailableGateways" :key="gateway.id" class="gateway-notice" :to="{ name: 'gateway', params: { gatewayId: gateway.id } }">
        <StatusDot :status="gateway.status" />
        <span><strong>{{ gateway.name }}</strong><small>{{ state.errors[`projects:${gateway.id}`] }}</small></span>
        <span>Pair →</span>
      </RouterLink>
    </section>

    <div v-if="!projects.length && !state.pending.value.size && !state.errors.gateways" class="empty-state">
      <span class="empty-orbit">◇</span><h2>No projects available</h2><p>Connect and pair a Gateway, then approve a project root on that machine.</p>
    </div>
  </div>
</template>
