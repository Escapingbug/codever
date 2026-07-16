<script setup lang="ts">
import { onMounted } from 'vue'
import StatusDot from '../components/StatusDot.vue'
import { useCodeverState } from '../state/codeverState'

const state = useCodeverState()
onMounted(() => state.loadGateways())
</script>

<template>
  <div class="page page--overview">
    <header class="page-header">
      <div><span class="eyebrow">Your machines</span><h1>Gateways</h1></div>
      <button class="button" :disabled="state.pending.value.has('gateways')" @click="state.loadGateways">Refresh</button>
    </header>
    <div v-if="state.errors.gateways" class="error-banner"><strong>Relay unavailable</strong>{{ state.errors.gateways }}</div>
    <div v-if="state.gateways.value.length" class="gateway-grid">
      <RouterLink v-for="gateway in state.gateways.value" :key="gateway.id" class="gateway-card" :to="`/gateways/${gateway.id}`">
        <div class="gateway-card-icon">{{ gateway.platform === 'windows' ? '⊞' : gateway.platform === 'macos' ? '⌘' : '›_' }}</div>
        <div class="gateway-card-copy">
          <div><h2>{{ gateway.name }}</h2><StatusDot :status="gateway.status" :label="gateway.status" /></div>
          <p>{{ gateway.platform }} · Codever {{ gateway.version }}</p>
          <div class="capability-tags"><span v-for="provider in gateway.capabilities.providers" :key="provider">{{ provider }}</span></div>
        </div>
        <span class="card-arrow">→</span>
      </RouterLink>
    </div>
    <div v-else-if="!state.pending.value.has('gateways') && !state.errors.gateways" class="empty-state">
      <span class="empty-orbit">◎</span><h2>No gateways connected</h2><p>Enroll a Gateway with your Relay to begin.</p>
    </div>
  </div>
</template>
