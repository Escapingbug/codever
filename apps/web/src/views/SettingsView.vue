<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { MatrixDeviceSnapshot } from '../api/nativeMatrixClient'
import type { ExecutionRootApprovalRequest } from '../api/matrixGatewayClient'
import ServerForm from '../components/ServerForm.vue'
import { clientSession, friendlyCodeverError } from '../state/clientSession'
import { useCodeverState } from '../state/codeverState'

const router = useRouter()
const state = useCodeverState()
const editing = ref(false)
const devices = ref<MatrixDeviceSnapshot[]>([])
const deviceError = ref('')
const approvalRequests = ref<ExecutionRootApprovalRequest[]>([])
const approvalBusy = ref('')
const connectionBusy = ref(false)
const reauthenticationPassword = ref('')
let unsubscribeApprovals: (() => void) | undefined

const currentDevice = computed(() => devices.value.find(device => device.current))
const otherDevices = computed(() => devices.value.filter(device => !device.current))

async function signOut(): Promise<void> { await clientSession.logout(); await router.replace('/login') }
async function refreshDevices(): Promise<void> {
  deviceError.value = ''
  try { devices.value = await clientSession.listMatrixDevices() }
  catch (error) { deviceError.value = friendlyCodeverError(error) }
}
async function retryConnection(): Promise<void> {
  connectionBusy.value = true; deviceError.value = ''
  try { await clientSession.reconnect() }
  catch (error) { deviceError.value = friendlyCodeverError(error) }
  finally { connectionBusy.value = false }
}
async function reauthenticate(): Promise<void> {
  connectionBusy.value = true; deviceError.value = ''
  try { await clientSession.reauthenticate(reauthenticationPassword.value); reauthenticationPassword.value = '' }
  catch (error) { deviceError.value = friendlyCodeverError(error) }
  finally { connectionBusy.value = false }
}
async function approveRequest(request: ExecutionRootApprovalRequest): Promise<void> {
  approvalBusy.value = request.requestId; deviceError.value = ''
  try { await state.api.approveExecutionRoot(request) }
  catch (error) { deviceError.value = friendlyCodeverError(error) }
  finally { approvalBusy.value = '' }
}

onMounted(() => {
  if (!clientSession.isAuthenticated.value) return
  void refreshDevices()
  try { unsubscribeApprovals = state.api.subscribeExecutionApprovals(value => { approvalRequests.value = value }) }
  catch (error) { deviceError.value = friendlyCodeverError(error) }
})
onUnmounted(() => unsubscribeApprovals?.())
</script>

<template>
  <div class="page page--overview settings-page">
    <header class="page-header page-header--compact"><div><span class="eyebrow">Codever</span><h1>Settings</h1><p>Server connection and this client.</p></div></header>
    <section class="settings-section settings-card">
      <div class="section-heading"><div><span class="eyebrow">Connection</span><h2>Private server</h2></div><div v-if="!editing" class="form-actions"><button v-if="clientSession.connectionState.value !== 'connected' && clientSession.identity.value && !clientSession.reauthenticationRequired.value" class="button button--primary" :disabled="connectionBusy" @click="retryConnection">{{ connectionBusy ? 'Connecting…' : 'Retry connection' }}</button><button class="button" @click="editing = true">Change</button></div></div>
      <ServerForm v-if="editing && clientSession.server.value" :domain="clientSession.server.value.domain" submit-label="Save server" @saved="editing = false" @cancel="editing = false" />
      <div v-else-if="clientSession.server.value" class="server-summary"><span class="status-dot" :class="clientSession.connectionState.value === 'connected' ? 'status-dot--connected' : 'status-dot--offline'" /><div><strong>{{ clientSession.server.value.domain }}</strong><small>{{ clientSession.connectionState.value === 'connected' ? 'Encrypted sync connected' : 'Offline · cached data remains available' }}</small></div></div>
      <p v-if="clientSession.initializationError.value" class="error-banner" role="alert">{{ clientSession.initializationError.value }}</p>
      <form v-if="clientSession.reauthenticationRequired.value" class="server-form reauthentication-form" @submit.prevent="reauthenticate"><p class="form-help">This client session expired. Enter the Matrix password once to renew this same device without losing Gateway trust.</p><label>Matrix password<input v-model="reauthenticationPassword" type="password" required autocomplete="current-password" /></label><button class="button button--primary" :disabled="connectionBusy">{{ connectionBusy ? 'Renewing…' : 'Renew session' }}</button></form>
    </section>

    <section v-if="clientSession.identity.value" class="settings-section settings-card">
      <div class="section-heading"><div><span class="eyebrow">This client</span><h2>Device security</h2></div><button class="button" @click="refreshDevices">Refresh</button></div>
      <p>Computer setup now belongs in <RouterLink to="/machines">Computers</RouterLink>. This page only shows clients signed in to your account.</p>
      <p v-if="deviceError" class="error-banner" role="alert">{{ deviceError }}</p>
      <article v-for="request in approvalRequests" :key="request.requestId" class="authorization-card"><span class="eyebrow">Client approval requested</span><h3>{{ request.label }}</h3><p>Matrix device {{ request.senderDevice || request.ownerId }} requests permission to control {{ request.gatewayId }}.</p><details class="machine-details"><summary>Review public key</summary><code>{{ request.publicKey.kid }}</code></details><button class="button button--primary" :disabled="approvalBusy === request.requestId" @click="approveRequest(request)">Approve client</button></article>
      <div v-if="currentDevice" class="server-summary"><span class="status-dot status-dot--connected" /><div><strong>{{ currentDevice.displayName || 'This Codever client' }}</strong><small>{{ currentDevice.deviceId }} · This device</small></div></div>
      <details v-if="otherDevices.length" class="machine-details"><summary>Other signed-in clients ({{ otherDevices.length }})</summary><div class="device-list"><div v-for="device in otherDevices" :key="device.deviceId" class="server-summary"><span class="status-dot" :class="device.verified ? 'status-dot--connected' : 'status-dot--offline'" /><div><strong>{{ device.displayName || 'Matrix client' }}</strong><small>{{ device.deviceId }} · {{ device.verified ? 'Verified' : device.verifiable ? 'Not verified' : 'No encryption keys' }}</small></div></div></div></details>
      <details class="machine-details"><summary>Technical details</summary><dl><div><dt>Matrix user</dt><dd>{{ clientSession.identity.value.session.userId }}</dd></div><div><dt>Device</dt><dd>{{ clientSession.identity.value.session.deviceId }}</dd></div><div><dt>Execution key</dt><dd>{{ clientSession.identity.value.executionKeyId }}</dd></div></dl></details>
    </section>
    <section class="settings-section account-card"><div><span class="eyebrow">Security</span><h2>Sign out this client</h2><p>This does not revoke other clients or computers.</p></div><button class="button button--danger" @click="signOut">Sign out</button></section>
  </div>
</template>
