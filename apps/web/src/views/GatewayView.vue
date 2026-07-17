<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import StatusDot from '../components/StatusDot.vue'
import { gatewayAccessState } from '../gatewayAccess'
import { useCodeverState } from '../state/codeverState'

const route = useRoute()
const state = useCodeverState()
const gatewayId = computed(() => String(route.params.gatewayId))
const gateway = computed(() => state.gateways.value.find(item => item.id === gatewayId.value))
const projects = computed(() => state.projectsByGateway[gatewayId.value] ?? [])
const projectError = computed(() => state.errors[`projects:${gatewayId.value}`])
const access = computed(() => gatewayAccessState({
  loaded: Object.prototype.hasOwnProperty.call(state.projectsByGateway, gatewayId.value),
  pending: state.pending.value.has(`projects:${gatewayId.value}`),
  error: projectError.value,
}))
const pairingCode = ref('')
const pairing = ref(false)
const pairingError = ref('')

async function pairGateway(): Promise<void> {
  pairing.value = true
  pairingError.value = ''
  try {
    await state.api.pairGateway(gatewayId.value, pairingCode.value.trim())
    pairingCode.value = ''
    await state.loadProjects(gatewayId.value)
  } catch (error) {
    pairingError.value = error instanceof Error ? error.message : 'Computer authorization failed'
  } finally {
    pairing.value = false
  }
}

onMounted(() => state.loadGateways())
watch(gatewayId, id => { if (id) void state.loadProjects(id) }, { immediate: true })
</script>

<template>
  <div class="page page--overview machine-detail-page">
    <header class="page-header page-header--compact gateway-title">
      <div>
        <RouterLink class="mobile-breadcrumb" to="/machines">Computers /</RouterLink>
        <span class="eyebrow">Computer</span>
        <h1>{{ gateway?.name ?? 'Computer' }}</h1>
        <p v-if="gateway"><StatusDot :status="gateway.status" :label="gateway.status" /> · {{ gateway.platform }} · Codever {{ gateway.version }}</p>
      </div>
    </header>

    <section v-if="access === 'checking'" class="empty-state empty-state--compact">
      <span class="loader" /><h2>Checking authorization</h2><p>Confirming that this client can securely access the computer.</p>
    </section>

    <section v-else-if="access === 'authorization-required'" class="settings-section authorization-card">
      <div class="section-heading"><div><span class="eyebrow">One-time setup</span><h2>Authorize this client</h2></div></div>
      <p>Generate a device code on <strong>{{ gateway?.name ?? 'this computer' }}</strong>, then enter it below within three minutes.</p>
      <form class="relay-form" @submit.prevent="pairGateway">
        <label>Device pairing code<input v-model="pairingCode" required autocomplete="one-time-code" autocapitalize="characters" placeholder="ABC234-DEFGH-JKLMN" /></label>
        <p class="form-help">This code authorizes only this client. It is different from the server connection code.</p>
        <p v-if="pairingError" class="error-banner" role="alert">{{ pairingError }}</p>
        <button class="button button--primary" :disabled="pairing || !pairingCode.trim()">{{ pairing ? 'Authorizing…' : 'Authorize computer' }}</button>
      </form>
    </section>

    <section v-else-if="access === 'error'" class="settings-section authorization-card authorization-card--error">
      <span class="eyebrow">Needs attention</span><h2>Could not reach this computer securely</h2><p>{{ projectError }}</p>
      <button class="button" :disabled="state.pending.value.has(`projects:${gatewayId}`)" @click="state.loadProjects(gatewayId)">Try again</button>
    </section>

    <template v-else>
      <div v-if="gateway && gateway.status !== 'online'" class="offline-banner"><strong>This computer is {{ gateway.status }}.</strong> Saved projects remain visible, but starting or continuing work requires it to be online.</div>
      <section>
        <div class="section-heading"><div><span class="eyebrow">Available here</span><h2>Projects</h2></div><span>{{ projects.length }}</span></div>
        <div v-if="projects.length" class="project-grid">
          <RouterLink v-for="project in projects" :key="project.id" class="project-card" :to="{ name: 'project', params: { gatewayId, projectId: project.id } }">
            <span class="folder-icon">▰</span><div><h3>{{ project.name }}</h3><small>{{ project.defaultProvider ?? 'Default provider' }}</small></div><span>→</span>
          </RouterLink>
        </div>
        <div v-else class="empty-state empty-state--compact"><span class="empty-orbit">▰</span><h2>No projects on this computer</h2><p>Add a project from the Projects page.</p><RouterLink class="button button--primary" to="/projects">Open Projects</RouterLink></div>
      </section>
      <details v-if="gateway" class="machine-details"><summary>Technical details</summary><dl><div><dt>Platform</dt><dd>{{ gateway.platform }}</dd></div><div><dt>Gateway ID</dt><dd>{{ gateway.id }}</dd></div><div><dt>Last seen</dt><dd>{{ gateway.lastSeenAt ? new Date(gateway.lastSeenAt).toLocaleString() : 'Unknown' }}</dd></div></dl></details>
    </template>
  </div>
</template>
