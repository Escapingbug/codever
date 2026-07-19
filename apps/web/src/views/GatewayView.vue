<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import StatusDot from '../components/StatusDot.vue'
import { clientSession } from '../state/clientSession'
import { useCodeverState } from '../state/codeverState'

const route = useRoute()
const state = useCodeverState()
const gatewayId = computed(() => String(route.params.gatewayId))
const gateway = computed(() => state.gateways.value.find(item => item.id === gatewayId.value))
const projects = computed(() => state.projectsByGateway[gatewayId.value] ?? [])
const error = computed(() => state.errors[`projects:${gatewayId.value}`])
const approvalRequested = ref(false)
const approvalError = ref('')

async function requestApproval(): Promise<void> {
  const identity = clientSession.identity.value
  if (!identity) return
  approvalError.value = ''
  try {
    const key = identity.executionPublicKey as Record<string, unknown>
    if (key.kty !== 'EC' || key.crv !== 'P-256' || key.alg !== 'ES256' || key.use !== 'sig'
      || typeof key.kid !== 'string' || typeof key.x !== 'string' || typeof key.y !== 'string') {
      throw new Error('The local execution identity is invalid')
    }
    await state.api.requestExecutionApproval({
      gatewayId: gatewayId.value,
      ownerId: identity.session.deviceId,
      label: `Codever ${identity.session.deviceId}`,
      publicKey: { kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', kid: key.kid, x: key.x, y: key.y },
    })
    approvalRequested.value = true
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 500))
      await state.loadProjects(gatewayId.value)
      if (!state.errors[`projects:${gatewayId.value}`]) return
    }
    throw new Error('The verified computer did not accept this control key. Try again.')
  } catch (requestError) {
    approvalError.value = requestError instanceof Error ? requestError.message : 'Unable to request approval'
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
    <div v-if="error" class="error-banner"><strong>Secure control unavailable.</strong> {{ error }}</div>
    <section v-if="error?.includes('unknown') || error?.includes('authorization')" class="settings-section authorization-card">
      <span class="eyebrow">Execution authorization</span>
      <h2>Authorize this client</h2>
      <p>The computer will bind this control key to the Matrix device you just verified. Unverified devices cannot add control keys.</p>
      <p v-if="approvalRequested">Authorizing this verified client…</p>
      <p v-if="approvalError" class="error-banner" role="alert">{{ approvalError }}</p>
      <button class="button button--primary" :disabled="approvalRequested" @click="requestApproval">Authorize this client</button>
      <details class="machine-details">
        <summary>Control key</summary>
        <dl>
          <div><dt>Key ID</dt><dd>{{ clientSession.identity.value?.executionKeyId }}</dd></div>
          <div><dt>Public JWK</dt><dd>{{ JSON.stringify(clientSession.identity.value?.executionPublicKey) }}</dd></div>
        </dl>
      </details>
    </section>
    <section v-if="!error">
      <div class="section-heading"><div><span class="eyebrow">Available here</span><h2>Projects</h2></div><span>{{ projects.length }}</span></div>
      <div v-if="projects.length" class="project-grid">
        <RouterLink v-for="project in projects" :key="project.id" class="project-card" :to="{ name: 'project', params: { gatewayId, projectId: project.id } }">
          <div><h3>{{ project.name }}</h3><small>{{ project.defaultProvider ?? 'Default provider' }}</small></div><span aria-hidden="true">→</span>
        </RouterLink>
      </div>
      <div v-else-if="state.pending.value.has(`projects:${gatewayId}`)" class="empty-state empty-state--compact"><span class="loader" /><h2>Loading projects</h2></div>
      <div v-else class="empty-state empty-state--compact"><h2>No projects on this computer</h2><p>Add an existing folder from Projects.</p></div>
    </section>
    <details v-if="gateway" class="machine-details">
      <summary>Technical details</summary>
      <dl>
        <div><dt>Gateway ID</dt><dd>{{ gateway.id }}</dd></div>
        <div><dt>Matrix device</dt><dd>{{ gateway.capabilities.metadata?.matrixDeviceId ?? 'Unknown' }}</dd></div>
        <div><dt>Last seen</dt><dd>{{ gateway.lastSeenAt ? new Date(gateway.lastSeenAt).toLocaleString() : 'Unknown' }}</dd></div>
      </dl>
    </details>
  </div>
</template>
