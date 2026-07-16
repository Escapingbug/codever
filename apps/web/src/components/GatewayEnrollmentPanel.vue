<script setup lang="ts">
import type { EnrolledGatewayKeyDto, GatewayEnrollmentDto } from '@codever/protocol'
import { computed, onMounted, ref } from 'vue'
import { clientSession, friendlyRelayError } from '../state/clientSession'

const code = ref('')
const pending = ref<GatewayEnrollmentDto[]>([])
const enrolled = ref<EnrolledGatewayKeyDto[]>([])
const selected = ref<GatewayEnrollmentDto>()
const bootstrapComplete = ref(true)
const busy = ref(false)
const error = ref('')
const canManage = computed(() => clientSession.activeAuth.value?.user.roles.some(role => role === 'admin' || role === 'gateway_admin'))

onMounted(() => { if (canManage.value) void refresh() })

async function refresh(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const [requests, keys] = await Promise.all([clientSession.api.listGatewayEnrollments(), clientSession.api.listEnrolledGateways()])
    pending.value = requests.enrollments
    bootstrapComplete.value = requests.bootstrapComplete
    enrolled.value = keys
  } catch (cause) { error.value = friendlyRelayError(cause) } finally { busy.value = false }
}

async function find(): Promise<void> {
  busy.value = true
  error.value = ''
  try { selected.value = await clientSession.api.getGatewayEnrollment(code.value) }
  catch (cause) { error.value = friendlyRelayError(cause) }
  finally { busy.value = false }
}

async function approve(request: GatewayEnrollmentDto): Promise<void> {
  if (!request.code || !confirm(`Approve ${request.name}\n\nFingerprint: ${request.fingerprint}`)) return
  busy.value = true
  error.value = ''
  try {
    await clientSession.api.approveGatewayEnrollment(request.code, { fingerprint: request.fingerprint, name: request.name, platform: request.platform })
    selected.value = undefined
    code.value = ''
    await refresh()
  } catch (cause) { error.value = friendlyRelayError(cause) } finally { busy.value = false }
}

async function reject(request: GatewayEnrollmentDto): Promise<void> {
  if (!request.code || !confirm(`Reject pairing request from ${request.name}?`)) return
  busy.value = true
  try { await clientSession.api.rejectGatewayEnrollment(request.code, 'Rejected from Codever client'); selected.value = undefined; await refresh() }
  catch (cause) { error.value = friendlyRelayError(cause) } finally { busy.value = false }
}

async function revoke(gateway: EnrolledGatewayKeyDto): Promise<void> {
  if (!confirm(`Revoke ${gateway.name}? It will be disconnected immediately.`)) return
  busy.value = true
  try { await clientSession.api.revokeEnrolledGateway(gateway.gatewayId); await refresh() }
  catch (cause) { error.value = friendlyRelayError(cause) } finally { busy.value = false }
}
</script>

<template>
  <section class="settings-section enrollment-panel">
    <div class="section-heading"><div><span class="eyebrow">Trust</span><h2>Gateway pairing</h2></div><button class="button" :disabled="busy || !canManage" @click="refresh">Refresh</button></div>
    <p v-if="!canManage" class="offline-banner">Gateway pairing requires the <strong>gateway_admin</strong> or <strong>admin</strong> role.</p>
    <template v-else>
      <p v-if="!bootstrapComplete" class="offline-banner"><strong>First Gateway requires local approval.</strong> Run the enrollment approval command on the Relay host. Client approval becomes available after bootstrap.</p>
      <form class="pairing-form" @submit.prevent="find"><label>Pairing code<input v-model="code" maxlength="9" autocomplete="one-time-code" autocapitalize="characters" placeholder="ABCD-2345" /></label><button class="button button--primary" :disabled="busy || code.replace(/[\s-]/g, '').length !== 8">Find Gateway</button></form>
      <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
      <article v-if="selected" class="pairing-confirmation">
        <div><span class="eyebrow">Confirm identity</span><h3>{{ selected.name }}</h3><p>{{ selected.platform }} · {{ selected.gatewayId }}</p></div>
        <code>{{ selected.fingerprint }}</code>
        <div class="form-actions"><button class="button button--danger" :disabled="busy" @click="reject(selected)">Reject</button><button class="button button--primary" :disabled="busy || !bootstrapComplete" @click="approve(selected)">Approve Gateway</button></div>
      </article>
      <div v-if="pending.length" class="profile-list"><article v-for="request in pending" :key="request.enrollmentId" class="profile-card"><div><strong>{{ request.name }}</strong><small>{{ request.platform }} · {{ request.code }}</small><small>{{ request.fingerprint }}</small></div><button class="button" @click="selected = request">Review</button></article></div>
      <div class="section-heading section-heading--sub"><div><span class="eyebrow">Enrolled</span><h3>Trusted Gateways</h3></div></div>
      <div class="profile-list"><article v-for="gateway in enrolled" :key="gateway.gatewayId" class="profile-card"><div><strong>{{ gateway.name }}</strong><small>{{ gateway.platform }} · {{ gateway.enabled ? 'trusted' : 'revoked' }}</small><small>{{ gateway.fingerprint }}</small></div><button v-if="gateway.enabled" class="button button--danger" :disabled="busy" @click="revoke(gateway)">Revoke</button></article></div>
    </template>
  </section>
</template>
