<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import StatusDot from '../components/StatusDot.vue'
import { useCodeverState } from '../state/codeverState'

const route = useRoute()
const state = useCodeverState()
const gatewayId = computed(() => String(route.params.gatewayId))
const gateway = computed(() => state.gateways.value.find((item) => item.id === gatewayId.value))
const projects = computed(() => state.projectsByGateway[gatewayId.value] ?? [])

onMounted(() => state.loadGateways())
watch(gatewayId, (id) => void state.loadProjects(id), { immediate: true })
</script>

<template>
  <div class="page page--overview">
    <header class="page-header gateway-title">
      <div>
        <RouterLink class="mobile-breadcrumb" to="/gateways">Gateways /</RouterLink>
        <span class="eyebrow">Gateway</span>
        <h1>{{ gateway?.name ?? 'Gateway' }}</h1>
        <p v-if="gateway"><StatusDot :status="gateway.status" :label="gateway.status" /> · {{ gateway.platform }} · v{{ gateway.version }}</p>
      </div>
    </header>
    <div v-if="gateway && gateway.status !== 'online'" class="offline-banner">
      <strong>This Gateway is {{ gateway.status }}.</strong> History may be cached, but execution controls are unavailable.
    </div>
    <section>
      <div class="section-heading"><div><span class="eyebrow">Approved roots</span><h2>Projects</h2></div></div>
      <div class="project-grid">
        <RouterLink v-for="project in projects" :key="project.id" class="project-card" :to="`/gateways/${gatewayId}/projects/${project.id}`">
          <span class="folder-icon">⌘</span>
          <div><h3>{{ project.name }}</h3><p>{{ project.repoIdentity ?? project.rootPath }}</p><small>{{ project.defaultProvider ?? 'Default provider' }}</small></div>
          <span>→</span>
        </RouterLink>
      </div>
      <div v-if="!projects.length && !state.pending.value.has(`projects:${gatewayId}`)" class="empty-state empty-state--compact">
        <h2>No projects registered</h2><p>Project roots must be approved on the Gateway.</p>
      </div>
    </section>
  </div>
</template>
