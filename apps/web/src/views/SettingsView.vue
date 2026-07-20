<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { MatrixDeviceSnapshot, MatrixVerificationSnapshot } from '../api/nativeMatrixClient'
import type { ExecutionRootApprovalRequest } from '../api/matrixGatewayClient'
import ClientVerificationCard from '../components/ClientVerificationCard.vue'
import ServerForm from '../components/ServerForm.vue'
import { clientSession, friendlyCodeverError } from '../state/clientSession'
import { useCodeverState } from '../state/codeverState'

const router = useRouter()
const state = useCodeverState()
const editing = ref(false)
const devices = ref<MatrixDeviceSnapshot[]>([])
const deviceError = ref('')
const verificationError = ref('')
const verifications = ref<MatrixVerificationSnapshot[]>([])
const verificationBusy = ref('')
const approvalRequests = ref<ExecutionRootApprovalRequest[]>([])
const approvalBusy = ref('')
const connectionBusy = ref(false)
let unsubscribeApprovals: (() => void) | undefined
let verificationTimer: ReturnType<typeof setInterval> | undefined
const completedVerifications = new Set<string>()

const currentDevice = computed(() => devices.value.find(device => device.current))
const otherDevices = computed(() => devices.value.filter(device => !device.current))
const unverifiedDevices = computed(() => otherDevices.value.filter(device => !device.verified))
const verifiedDevices = computed(() => otherDevices.value.filter(device => device.verified))
const clientVerifications = computed(() => {
  const clientDeviceIds = new Set(otherDevices.value.map(device => device.deviceId))
  return verifications.value.filter(flow => flow.otherDeviceId && clientDeviceIds.has(flow.otherDeviceId) && flow.stage !== 'done')
})
const activeVerificationDevices = computed(() => new Set(clientVerifications.value.map(flow => flow.otherDeviceId)))

async function signOut(): Promise<void> { await clientSession.logout(); await router.replace('/login') }
async function refreshDevices(): Promise<void> {
  deviceError.value = ''
  try { devices.value = await clientSession.listMatrixDevices() }
  catch (error) { deviceError.value = friendlyCodeverError(error) }
}
async function refreshVerifications(): Promise<void> {
  try {
    verifications.value = await clientSession.listVerifications()
    const newlyCompleted = verifications.value.filter(flow => flow.stage === 'done' && !completedVerifications.has(flow.flowId))
    for (const flow of newlyCompleted) completedVerifications.add(flow.flowId)
    if (newlyCompleted.length) await refreshDevices()
  } catch (error) { verificationError.value = friendlyCodeverError(error) }
}
function rememberVerification(flow: MatrixVerificationSnapshot): void {
  verifications.value = [...verifications.value.filter(value => value.flowId !== flow.flowId), flow]
}
async function startClientVerification(deviceId: string): Promise<void> {
  verificationBusy.value = deviceId; verificationError.value = ''
  try { rememberVerification(await clientSession.requestVerification(deviceId)) }
  catch (error) { verificationError.value = friendlyCodeverError(error) }
  finally { verificationBusy.value = '' }
}
async function advanceClientVerification(flow: MatrixVerificationSnapshot): Promise<void> {
  verificationBusy.value = flow.flowId; verificationError.value = ''
  try { rememberVerification(await clientSession.advanceVerification(flow.flowId)) }
  catch (error) { verificationError.value = friendlyCodeverError(error) }
  finally { verificationBusy.value = '' }
}
async function confirmClientVerification(flow: MatrixVerificationSnapshot, matches: boolean): Promise<void> {
  verificationBusy.value = flow.flowId; verificationError.value = ''
  try {
    rememberVerification(await clientSession.confirmVerification(flow.flowId, matches))
    if (matches) await refreshDevices()
  } catch (error) { verificationError.value = friendlyCodeverError(error) }
  finally { verificationBusy.value = '' }
}
async function cancelClientVerification(flow: MatrixVerificationSnapshot): Promise<void> {
  verificationBusy.value = flow.flowId; verificationError.value = ''
  try { await clientSession.cancelVerification(flow.flowId); await refreshVerifications() }
  catch (error) { verificationError.value = friendlyCodeverError(error) }
  finally { verificationBusy.value = '' }
}
async function retryConnection(): Promise<void> {
  connectionBusy.value = true; deviceError.value = ''
  try { await clientSession.reconnect() }
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
  void refreshVerifications()
  verificationTimer = setInterval(() => { void refreshVerifications() }, 1_000)
  try { unsubscribeApprovals = state.api.subscribeExecutionApprovals(value => { approvalRequests.value = value }) }
  catch (error) { deviceError.value = friendlyCodeverError(error) }
})
onUnmounted(() => { unsubscribeApprovals?.(); if (verificationTimer) clearInterval(verificationTimer) })
</script>

<template>
  <div class="page page--overview settings-page">
    <header class="page-header page-header--compact"><div><span class="eyebrow">Codever</span><h1>Settings</h1><p>Server connection and this client.</p></div></header>
    <section class="settings-section settings-card">
      <div class="section-heading"><div><span class="eyebrow">Connection</span><h2>Private server</h2></div><div v-if="!editing" class="form-actions"><button v-if="clientSession.connectionState.value !== 'connected' && clientSession.identity.value && !clientSession.reauthenticationRequired.value" class="button button--primary" :disabled="connectionBusy" @click="retryConnection">{{ connectionBusy ? 'Connecting…' : 'Retry connection' }}</button><button class="button" @click="editing = true">Change</button></div></div>
      <ServerForm v-if="editing && clientSession.server.value" :domain="clientSession.server.value.domain" submit-label="Save server" @saved="editing = false" @cancel="editing = false" />
      <div v-else-if="clientSession.server.value" class="server-summary"><span class="status-dot" :class="clientSession.connectionState.value === 'connected' ? 'status-dot--connected' : 'status-dot--offline'" /><div><strong>{{ clientSession.server.value.domain }}</strong><small>{{ clientSession.connectionState.value === 'connected' ? 'Encrypted sync connected' : 'Offline · cached data remains available' }}</small></div></div>
      <p v-if="clientSession.initializationError.value" class="error-banner" role="alert">{{ clientSession.initializationError.value }}</p>
    </section>

    <section v-if="clientSession.identity.value" class="settings-section settings-card">
      <div class="section-heading"><div><span class="eyebrow">This client</span><h2>Device security</h2></div><button class="button" @click="refreshDevices">Refresh</button></div>
      <p>Verify another signed-in client here, then approve its Gateway request without opening a terminal on the computer.</p>
      <p v-if="deviceError" class="error-banner" role="alert">{{ deviceError }}</p>
      <p v-if="verificationError" class="error-banner" role="alert">{{ verificationError }}</p>
      <ClientVerificationCard
        v-for="flow in clientVerifications" :key="flow.flowId" :flow="flow"
        :device="otherDevices.find(device => device.deviceId === flow.otherDeviceId)"
        :busy="verificationBusy === flow.flowId"
        @advance="advanceClientVerification(flow)" @confirm="matches => confirmClientVerification(flow, matches)"
        @cancel="cancelClientVerification(flow)"
      />
      <article v-for="request in approvalRequests" :key="request.requestId" class="authorization-card"><span class="eyebrow">Client approval requested</span><h3>{{ request.label }}</h3><p>Matrix device {{ request.senderDevice || request.ownerId }} requests permission to control {{ request.gatewayId }}.</p><details class="machine-details"><summary>Review public key</summary><code>{{ request.publicKey.kid }}</code></details><button class="button button--primary" :disabled="approvalBusy === request.requestId" @click="approveRequest(request)">Approve client</button></article>
      <div v-if="currentDevice" class="server-summary"><span class="status-dot status-dot--connected" /><div><strong>{{ currentDevice.displayName || 'This Codever client' }}</strong><small>{{ currentDevice.deviceId }} · This device</small></div></div>
      <div v-for="device in unverifiedDevices" :key="device.deviceId" class="server-summary"><span class="status-dot status-dot--offline" /><div><strong>{{ device.displayName || 'Matrix client' }}</strong><small>{{ device.deviceId }} · {{ device.verifiable ? 'Not verified' : 'No encryption keys' }}</small></div><button v-if="device.verifiable" class="button" :disabled="verificationBusy === device.deviceId || activeVerificationDevices.has(device.deviceId)" @click="startClientVerification(device.deviceId)">Verify</button></div>
      <details v-if="verifiedDevices.length" class="machine-details"><summary>Other verified clients ({{ verifiedDevices.length }})</summary><div class="device-list"><div v-for="device in verifiedDevices" :key="device.deviceId" class="server-summary"><span class="status-dot status-dot--connected" /><div><strong>{{ device.displayName || 'Matrix client' }}</strong><small>{{ device.deviceId }} · Verified</small></div></div></div></details>
      <details class="machine-details"><summary>Technical details</summary><dl><div><dt>Matrix user</dt><dd>{{ clientSession.identity.value.session.userId }}</dd></div><div><dt>Device</dt><dd>{{ clientSession.identity.value.session.deviceId }}</dd></div><div><dt>Execution key</dt><dd>{{ clientSession.identity.value.executionKeyId }}</dd></div></dl></details>
    </section>
    <section class="settings-section account-card"><div><span class="eyebrow">Security</span><h2>Sign out this client</h2><p>This does not revoke other clients or computers.</p></div><button class="button button--danger" @click="signOut">Sign out</button></section>
  </div>
</template>
