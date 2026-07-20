<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { MatrixVerificationSnapshot } from '../api/nativeMatrixClient'
import StatusDot from '../components/StatusDot.vue'
import { gatewayNeedsVerification, isGatewayAuthorizationError } from '../gatewayAccess'
import { clientSession, friendlyCodeverError } from '../state/clientSession'
import { useCodeverState } from '../state/codeverState'

const route = useRoute()
const state = useCodeverState()
const gatewayId = computed(() => String(route.params.gatewayId))
const gateway = computed(() => state.gateways.value.find(item => item.id === gatewayId.value))
const projects = computed(() => state.projectsByGateway[gatewayId.value] ?? [])
const error = computed(() => state.errors[`projects:${gatewayId.value}`])
const needsVerification = computed(() => gatewayNeedsVerification(gateway.value))
const matrixDeviceId = computed(() => {
  const value = gateway.value?.capabilities.metadata?.matrixDeviceId
  return typeof value === 'string' ? value : ''
})
const flow = ref<MatrixVerificationSnapshot>()
const setupBusy = ref(false)
const setupError = ref('')
const approvalRequested = ref(false)
const approvalError = ref('')
let verificationTimer: ReturnType<typeof setInterval> | undefined

async function startVerification(): Promise<void> {
  if (!matrixDeviceId.value) return
  setupBusy.value = true
  setupError.value = ''
  try {
    flow.value = await clientSession.requestVerification(matrixDeviceId.value)
    startVerificationPolling()
  } catch (verificationError) {
    setupError.value = friendlyCodeverError(verificationError)
  } finally { setupBusy.value = false }
}

async function advanceVerification(): Promise<void> {
  if (!flow.value) return
  setupBusy.value = true
  setupError.value = ''
  try { flow.value = await clientSession.advanceVerification(flow.value.flowId) }
  catch (verificationError) { setupError.value = friendlyCodeverError(verificationError) }
  finally { setupBusy.value = false }
}

async function confirmVerification(matches: boolean): Promise<void> {
  if (!flow.value) return
  setupBusy.value = true
  setupError.value = ''
  try {
    flow.value = await clientSession.confirmVerification(flow.value.flowId, matches)
    if (!matches) return
    let verifiedLocally = false
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const devices = await clientSession.listMatrixDevices()
      if (devices.some(device => device.deviceId === matrixDeviceId.value && device.verified)) {
        verifiedLocally = true
        break
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    if (!verifiedLocally) throw new Error('Verification completed, but Matrix device trust has not synchronized yet.')
    // Native SAS trust is authoritative locally; the Gateway still independently
    // rejects requests until its own Matrix crypto store confirms the same trust.
    state.markGatewayMatrixVerified(gatewayId.value)
    await state.loadProjects(gatewayId.value)
    void state.loadGateways()
    stopVerificationPolling()
  } catch (verificationError) {
    setupError.value = friendlyCodeverError(verificationError)
  } finally { setupBusy.value = false }
}

async function cancelVerification(): Promise<void> {
  if (!flow.value) return
  setupBusy.value = true
  try { await clientSession.cancelVerification(flow.value.flowId); flow.value = undefined; stopVerificationPolling() }
  catch (verificationError) { setupError.value = friendlyCodeverError(verificationError) }
  finally { setupBusy.value = false }
}

function startVerificationPolling(): void {
  stopVerificationPolling()
  verificationTimer = setInterval(async () => {
    if (!flow.value) return
    try {
      const current = (await clientSession.listVerifications()).find(item => item.flowId === flow.value?.flowId)
      if (current) flow.value = current
    } catch { /* an explicit action will surface the error */ }
  }, 1_000)
}
function stopVerificationPolling(): void { if (verificationTimer) clearInterval(verificationTimer); verificationTimer = undefined }

async function requestApproval(): Promise<void> {
  const identity = clientSession.identity.value
  if (!identity) return
  approvalError.value = ''
  try {
    const key = identity.executionPublicKey as Record<string, unknown>
    if (key.kty !== 'EC' || key.crv !== 'P-256' || key.alg !== 'ES256' || key.use !== 'sig'
      || typeof key.kid !== 'string' || typeof key.x !== 'string' || typeof key.y !== 'string') throw new Error('The local execution identity is invalid')
    await state.api.requestExecutionApproval({
      gatewayId: gatewayId.value, ownerId: identity.session.deviceId, label: `Codever ${identity.session.deviceId}`,
      publicKey: { kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', kid: key.kid, x: key.x, y: key.y },
    })
    approvalRequested.value = true
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 500))
      await state.loadProjects(gatewayId.value)
      if (!state.errors[`projects:${gatewayId.value}`]) return
    }
    throw new Error('The computer did not accept this control key. Approve it on an already authorized client, then retry.')
  } catch (requestError) { approvalError.value = friendlyCodeverError(requestError) }
  finally { approvalRequested.value = false }
}

onMounted(async () => { await state.loadGateways() })
watch(gateway, value => { if (value && !gatewayNeedsVerification(value)) void state.loadProjects(value.id) }, { immediate: true })
onUnmounted(stopVerificationPolling)
</script>

<template>
  <div class="page page--overview machine-detail-page">
    <header class="page-header page-header--compact gateway-title">
      <div><RouterLink class="mobile-breadcrumb" to="/machines">Computers /</RouterLink><span class="eyebrow">Computer</span><h1>{{ gateway?.name ?? 'Computer' }}</h1><p v-if="gateway"><StatusDot :status="gateway.status" :label="gateway.status" /> · {{ gateway.platform }} · Codever {{ gateway.version }}</p></div>
    </header>

    <section v-if="needsVerification" class="settings-section authorization-card">
      <span class="eyebrow">Step 1 of 2 · Identity</span><h2>Verify this computer</h2>
      <p>Compare the emoji shown here with the computer. Until they match, Codever cannot see its projects or send it commands.</p>
      <p class="form-help">On this computer, run <code>codever verify</code> in a terminal. Then confirm the same emoji on both devices.</p>
      <p v-if="setupError" class="error-banner" role="alert">{{ setupError }}</p>
      <button v-if="!flow" class="button button--primary" :disabled="setupBusy || !matrixDeviceId" @click="startVerification">Start secure verification</button>
      <template v-else-if="flow.stage === 'present_sas'">
        <div class="verification-emoji" aria-label="Verification emoji"><span v-for="emoji in flow.emojis" :key="emoji.description" :title="emoji.description">{{ emoji.symbol }}</span></div>
        <p>Confirm only when the computer shows these emoji in this exact order.</p>
        <div class="form-actions"><button class="button" :disabled="setupBusy" @click="confirmVerification(false)">They differ</button><button class="button button--primary" :disabled="setupBusy" @click="confirmVerification(true)">They match</button></div>
      </template>
      <div v-else class="form-actions"><button class="button" :disabled="setupBusy" @click="cancelVerification">Cancel</button><button class="button button--primary" :disabled="setupBusy" @click="advanceVerification">{{ setupBusy ? 'Waiting…' : 'Continue' }}</button></div>
    </section>

    <div v-else-if="error && !isGatewayAuthorizationError(error)" class="error-banner"><strong>Secure control unavailable.</strong> {{ error }}</div>
    <section v-if="!needsVerification && isGatewayAuthorizationError(error)" class="settings-section authorization-card">
      <span class="eyebrow">Step 2 of 2 · Permission</span><h2>Authorize this client</h2><p>This computer is verified. Now allow this client’s signed control key to execute coding tasks.</p>
      <p v-if="approvalRequested">Waiting for authorization…</p><p v-if="approvalError" class="error-banner" role="alert">{{ approvalError }}</p>
      <button class="button button--primary" :disabled="approvalRequested" @click="requestApproval">Request authorization</button>
    </section>

    <section v-if="!needsVerification && !error">
      <div class="section-heading"><div><span class="eyebrow">Available here</span><h2>Projects</h2></div><span>{{ projects.length }}</span></div>
      <div v-if="projects.length" class="project-grid"><RouterLink v-for="project in projects" :key="project.id" class="project-card" :to="{ name: 'project', params: { gatewayId, projectId: project.id } }"><div><h3>{{ project.name }}</h3><small>{{ project.defaultProvider ?? 'Default provider' }}</small></div><span aria-hidden="true">→</span></RouterLink></div>
      <div v-else-if="state.pending.value.has(`projects:${gatewayId}`)" class="empty-state empty-state--compact"><span class="loader" /><h2>Loading projects</h2></div>
      <div v-else class="empty-state empty-state--compact"><h2>No projects on this computer</h2><p>Add an existing folder from Projects.</p></div>
    </section>
    <details v-if="gateway" class="machine-details"><summary>Technical details</summary><dl><div><dt>Gateway ID</dt><dd>{{ gateway.id }}</dd></div><div><dt>Matrix device</dt><dd>{{ matrixDeviceId || 'Unknown' }}</dd></div><div><dt>Last seen</dt><dd>{{ gateway.lastSeenAt ? new Date(gateway.lastSeenAt).toLocaleString() : 'Unknown' }}</dd></div></dl></details>
  </div>
</template>
