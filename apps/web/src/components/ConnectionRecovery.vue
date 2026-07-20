<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { clientSession, friendlyCodeverError } from '../state/clientSession'

const emit = defineEmits<{ recovered: [] }>()
const router = useRouter()
const password = ref('')
const busy = ref(false)
const actionError = ref('')
const visible = computed(() => clientSession.isAuthenticated.value
  && clientSession.connectionState.value === 'disconnected'
  && (clientSession.reauthenticationRequired.value || clientSession.credentialResetRequired.value))
const retryVisible = computed(() => clientSession.isAuthenticated.value && !visible.value
  && clientSession.connectionState.value !== 'connected')

async function retry(): Promise<void> {
  busy.value = true
  actionError.value = ''
  try {
    await clientSession.reconnect()
    emit('recovered')
  } catch (error) {
    actionError.value = friendlyCodeverError(error)
  } finally { busy.value = false }
}

async function renew(): Promise<void> {
  busy.value = true
  actionError.value = ''
  try {
    await clientSession.reauthenticate(password.value)
    password.value = ''
    emit('recovered')
  } catch (error) {
    actionError.value = friendlyCodeverError(error)
  } finally { busy.value = false }
}

async function signInAgain(): Promise<void> {
  busy.value = true
  actionError.value = ''
  try {
    await clientSession.logout()
    await router.replace({ name: 'login', query: { redirect: router.currentRoute.value.fullPath } })
  } catch (error) {
    actionError.value = friendlyCodeverError(error)
  } finally { busy.value = false }
}
</script>

<template>
  <div v-if="visible" class="verification-backdrop connection-recovery" role="presentation">
    <section class="settings-card verification-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-recovery-title">
      <span class="eyebrow">Secure connection</span>
      <h2 id="connection-recovery-title">{{ clientSession.credentialResetRequired.value ? 'Sign in again' : 'Reconnect Codever' }}</h2>
      <template v-if="clientSession.credentialResetRequired.value">
        <p>Android restored app data without the matching secure credential. Sign in again to repair this client.</p>
        <p class="form-help">Cached project and session views remain on this device. Gateway access stays blocked until the new Matrix device is verified.</p>
        <button class="button button--primary" :disabled="busy" @click="signInAgain">{{ busy ? 'Preparing…' : 'Continue to sign in' }}</button>
      </template>
      <form v-else class="server-form" @submit.prevent="renew">
        <p>Your saved Matrix session expired. Enter the account password once to renew this same device and keep its Gateway trust.</p>
        <label>Matrix password<input v-model="password" type="password" required autocomplete="current-password" autofocus /></label>
        <p v-if="actionError" class="error-banner" role="alert">{{ actionError }}</p>
        <button class="button button--primary" :disabled="busy">{{ busy ? 'Renewing…' : 'Renew session' }}</button>
      </form>
      <details class="machine-details"><summary>Technical details</summary><p>{{ clientSession.initializationError.value }}</p></details>
    </section>
  </div>
  <aside v-else-if="retryVisible" class="connection-retry" role="status">
    <div><strong>Secure sync is {{ clientSession.connectionState.value === 'reconnecting' ? 'reconnecting' : 'offline' }}</strong><small>{{ actionError || clientSession.initializationError.value || 'Cached work remains available while Codever reconnects.' }}</small></div>
    <button class="button" :disabled="busy || clientSession.connectionState.value === 'reconnecting'" @click="retry">{{ busy ? 'Connecting…' : 'Retry secure sync' }}</button>
  </aside>
</template>
