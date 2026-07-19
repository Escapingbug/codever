<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { MatrixDeviceSnapshot, MatrixVerificationSnapshot } from '../api/nativeMatrixClient'
import type { ExecutionRootApprovalRequest } from '../api/matrixGatewayClient'
import ServerForm from '../components/ServerForm.vue'
import { clientSession } from '../state/clientSession'
import { useCodeverState } from '../state/codeverState'

const router = useRouter()
const state = useCodeverState()
const editing = ref(false)
const devices = ref<MatrixDeviceSnapshot[]>([])
const verifications = ref<MatrixVerificationSnapshot[]>([])
const deviceError = ref('')
const deviceBusy = ref('')
const approvalRequests = ref<ExecutionRootApprovalRequest[]>([])
const approvalBusy = ref('')
let verificationTimer: ReturnType<typeof setInterval> | undefined
let unsubscribeApprovals: (() => void) | undefined

const visibleVerifications = computed(() => verifications.value
  .filter(value => value.stage !== 'done')
  .slice(-5))

async function signOut(): Promise<void> {
  await clientSession.logout()
  await router.replace('/login')
}

async function refreshDevices(): Promise<void> {
  deviceError.value = ''
  try {
    const [nextDevices, nextVerifications] = await Promise.all([
      clientSession.listMatrixDevices(),
      clientSession.listVerifications(),
    ])
    devices.value = nextDevices
    verifications.value = nextVerifications
  } catch (error) {
    deviceError.value = error instanceof Error ? error.message : 'Unable to load Matrix devices'
  }
}

async function refreshVerifications(): Promise<void> {
  try { verifications.value = await clientSession.listVerifications() } catch { /* shown by explicit refresh */ }
}

async function startVerification(device: MatrixDeviceSnapshot): Promise<void> {
  deviceBusy.value = device.deviceId
  deviceError.value = ''
  try {
    const flow = await clientSession.requestVerification(device.deviceId)
    verifications.value = [...verifications.value.filter(value => value.flowId !== flow.flowId), flow]
  } catch (error) {
    deviceError.value = error instanceof Error ? error.message : 'Unable to start device verification'
  } finally {
    deviceBusy.value = ''
  }
}

async function advance(flowId: string): Promise<void> {
  deviceBusy.value = flowId
  try {
    const flow = await clientSession.advanceVerification(flowId)
    verifications.value = verifications.value.map(value => value.flowId === flowId ? flow : value)
  } catch (error) {
    deviceError.value = error instanceof Error ? error.message : 'Unable to continue verification'
  } finally {
    deviceBusy.value = ''
  }
}

async function confirm(flowId: string, matches: boolean): Promise<void> {
  deviceBusy.value = flowId
  try {
    const flow = await clientSession.confirmVerification(flowId, matches)
    verifications.value = verifications.value.map(value => value.flowId === flowId ? flow : value)
    await refreshDevices()
  } catch (error) {
    deviceError.value = error instanceof Error ? error.message : 'Unable to confirm verification'
  } finally {
    deviceBusy.value = ''
  }
}

async function approveRequest(request: ExecutionRootApprovalRequest): Promise<void> {
  approvalBusy.value = request.requestId
  deviceError.value = ''
  try {
    await state.api.approveExecutionRoot(request)
  } catch (error) {
    deviceError.value = error instanceof Error ? error.message : 'Unable to approve this client'
  } finally {
    approvalBusy.value = ''
  }
}

onMounted(() => {
  if (clientSession.isAuthenticated.value) {
    void refreshDevices()
    try {
      unsubscribeApprovals = state.api.subscribeExecutionApprovals(value => { approvalRequests.value = value })
    } catch (error) {
      deviceError.value = error instanceof Error ? error.message : 'Unable to watch approval requests'
    }
    verificationTimer = setInterval(() => void refreshVerifications(), 2_000)
  }
})
onUnmounted(() => {
  if (verificationTimer) clearInterval(verificationTimer)
  unsubscribeApprovals?.()
})
</script>

<template>
  <div class="page page--overview settings-page">
    <header class="page-header page-header--compact">
      <div><span class="eyebrow">Codever</span><h1>Settings</h1><p>Account, connection and device security.</p></div>
    </header>
    <section class="settings-section settings-card">
      <div class="section-heading">
        <div><span class="eyebrow">Connection</span><h2>Private server</h2></div>
        <button v-if="!editing" class="button" @click="editing = true">Change</button>
      </div>
      <ServerForm v-if="editing && clientSession.server.value" :domain="clientSession.server.value.domain" submit-label="Save server" @saved="editing = false" @cancel="editing = false" />
      <div v-else-if="clientSession.server.value" class="server-summary">
        <span class="status-dot" :class="clientSession.connectionState.value === 'connected' ? 'status-dot--connected' : 'status-dot--offline'" />
        <div><strong>{{ clientSession.server.value.domain }}</strong><small>{{ clientSession.connectionState.value === 'connected' ? 'Encrypted sync connected' : 'Offline — cached data remains available' }}</small></div>
      </div>
    </section>

    <section v-if="clientSession.identity.value" class="settings-section settings-card">
      <div class="section-heading">
        <div><span class="eyebrow">End-to-end encryption</span><h2>Devices</h2></div>
        <button class="button" @click="refreshDevices">Refresh</button>
      </div>
      <p>Verify a new phone or computer by comparing the same emoji on both devices. Unverified devices cannot control Gateways.</p>
      <p v-if="deviceError" class="error-banner" role="alert">{{ deviceError }}</p>
      <article v-for="request in approvalRequests" :key="request.requestId" class="authorization-card">
        <span class="eyebrow">Execution approval requested</span>
        <h3>{{ request.label }}</h3>
        <p>Device {{ request.senderDevice || request.ownerId }} requests permission to control Gateway {{ request.gatewayId }}.</p>
        <details class="machine-details"><summary>Review public key</summary><code>{{ request.publicKey.kid }}</code></details>
        <button class="button button--primary" :disabled="approvalBusy === request.requestId" @click="approveRequest(request)">Approve this client</button>
      </article>
      <div class="device-list">
        <div v-for="device in devices" :key="device.deviceId" class="server-summary">
          <span class="status-dot" :class="device.verified ? 'status-dot--connected' : 'status-dot--offline'" />
          <div><strong>{{ device.displayName || device.deviceId }}</strong><small>{{ device.current ? 'This device' : device.deviceId }} · {{ device.verified ? 'Verified' : 'Not verified' }}</small></div>
          <button v-if="!device.current && !device.verified" class="button" :disabled="deviceBusy === device.deviceId" @click="startVerification(device)">Verify</button>
        </div>
      </div>
      <article v-for="flow in visibleVerifications" :key="flow.flowId" class="authorization-card">
        <span class="eyebrow">Device verification</span>
        <h3>{{ flow.otherDeviceId || 'Incoming device request' }}</h3>
        <p v-if="flow.stage === 'cancelled'">{{ flow.cancellation?.reason || 'Verification was cancelled.' }}</p>
        <template v-else-if="flow.stage === 'present_sas'">
          <div class="verification-emoji" aria-label="Verification emoji">
            <span v-for="emoji in flow.emojis" :key="emoji.description" :title="emoji.description">{{ emoji.symbol }}</span>
          </div>
          <p>Confirm only if both devices show these emoji in this order.</p>
          <div class="form-actions"><button class="button" @click="confirm(flow.flowId, false)">They differ</button><button class="button button--primary" @click="confirm(flow.flowId, true)">They match</button></div>
        </template>
        <button v-else class="button button--primary" :disabled="deviceBusy === flow.flowId" @click="advance(flow.flowId)">Continue verification</button>
      </article>
      <details class="machine-details">
        <summary>Technical details</summary>
        <dl>
          <div><dt>Matrix user</dt><dd>{{ clientSession.identity.value.session.userId }}</dd></div>
          <div><dt>Device</dt><dd>{{ clientSession.identity.value.session.deviceId }}</dd></div>
          <div><dt>Execution key</dt><dd>{{ clientSession.identity.value.executionKeyId }}</dd></div>
        </dl>
      </details>
    </section>

    <section class="settings-section account-card">
      <div><span class="eyebrow">Security</span><h2>Sign out this client</h2><p>This does not revoke other verified devices or Gateways.</p></div>
      <button class="button button--danger" @click="signOut">Sign out</button>
    </section>
  </div>
</template>
