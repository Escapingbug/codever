<script setup lang="ts">
import { computed, onMounted } from 'vue'
import StatusDot from '../components/StatusDot.vue'
import { gatewayAccessState } from '../gatewayAccess'
import { useCodeverState } from '../state/codeverState'

const state = useCodeverState()
const hasLoadedProjects = (id: string) => Object.prototype.hasOwnProperty.call(state.projectsByGateway, id)
const machines = computed(() => state.gateways.value.map(gateway => ({
  gateway,
  access: gatewayAccessState({
    loaded: hasLoadedProjects(gateway.id),
    pending: state.pending.value.has(`projects:${gateway.id}`),
    error: state.errors[`projects:${gateway.id}`],
  }),
  projectCount: state.projectsByGateway[gateway.id]?.length ?? 0,
})).sort((a, b) => {
  const rank = { 'authorization-required': 0, error: 1, ready: 2, checking: 3 }
  return rank[a.access] - rank[b.access] || Number(b.gateway.status === 'online') - Number(a.gateway.status === 'online')
}))

onMounted(() => state.loadWorkspace())
</script>

<template>
  <div class="page page--overview machines-page">
    <header class="page-header page-header--compact">
      <div><span class="eyebrow">Workspace</span><h1>Computers</h1><p>Manage the computers that run your coding agents.</p></div>
      <button class="button" :disabled="state.pending.value.has('gateways')" @click="state.loadWorkspace">{{ state.pending.value.has('gateways') ? 'Checking…' : 'Refresh' }}</button>
    </header>
    <div v-if="state.errors.gateways" class="error-banner"><strong>Could not find computers.</strong> {{ state.errors.gateways }}</div>
    <div v-if="machines.length" class="gateway-grid">
      <RouterLink v-for="item in machines" :key="item.gateway.id" class="gateway-card machine-card" :class="`machine-card--${item.access}`" :to="{ name: 'gateway', params: { gatewayId: item.gateway.id } }">
        <span class="gateway-card-icon" aria-hidden="true">◎</span>
        <span class="gateway-card-copy">
          <span><strong>{{ item.gateway.name }}</strong><StatusDot :status="item.gateway.status" :label="item.gateway.status" /></span>
          <small>{{ item.gateway.platform }} · Codever {{ item.gateway.version }}</small>
          <span v-if="item.access === 'authorization-required'" class="machine-access machine-access--setup">Authorization required</span>
          <span v-else-if="item.access === 'checking'" class="machine-access">Checking access…</span>
          <span v-else-if="item.access === 'error'" class="machine-access machine-access--error">Needs attention</span>
          <span v-else class="machine-access">{{ item.projectCount }} project{{ item.projectCount === 1 ? '' : 's' }}</span>
        </span>
        <span class="card-arrow">{{ item.access === 'authorization-required' ? 'Review →' : 'Open →' }}</span>
      </RouterLink>
    </div>
    <div v-else-if="state.pending.value.has('gateways')" class="empty-state"><span class="loader" /><h2>Looking for computers</h2><p>Computers connected to your Codever server will appear here.</p></div>
    <div v-else class="empty-state"><span class="empty-orbit" aria-hidden="true">◎</span><h2>No computers found</h2><p>Start a Codever Gateway on a computer and connect it to this server, then refresh.</p><button class="button button--primary" @click="state.loadWorkspace">Refresh</button></div>
  </div>
</template>
