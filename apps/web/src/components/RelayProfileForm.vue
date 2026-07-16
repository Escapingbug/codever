<script setup lang="ts">
import { ref } from 'vue'
import { clientSession, friendlyRelayError, type RelayProfile } from '../state/clientSession'
import { DEMO_RELAY_URL } from '../api/demoRelay'

const props = defineProps<{ profile?: RelayProfile; submitLabel?: string }>()
const emit = defineEmits<{ saved: [profile: RelayProfile]; cancel: [] }>()
const name = ref(props.profile?.name ?? '')
const baseUrl = ref(props.profile?.baseUrl ?? '')
const busy = ref(false)
const status = ref('')
const error = ref('')

async function submit(): Promise<void> {
  error.value = ''
  status.value = 'Checking Relay connection…'
  busy.value = true
  try {
    await clientSession.testProfile({ baseUrl: baseUrl.value })
    const profile = clientSession.saveProfile({ id: props.profile?.id, name: name.value, baseUrl: baseUrl.value })
    status.value = 'Relay is reachable.'
    emit('saved', profile)
  } catch (cause) {
    status.value = ''
    error.value = friendlyRelayError(cause)
  } finally {
    busy.value = false
  }
}

async function useDemo(): Promise<void> {
  name.value = 'Offline preview'
  baseUrl.value = DEMO_RELAY_URL
  await submit()
}
</script>

<template>
  <form class="relay-form" @submit.prevent="submit">
    <label>Profile name<input v-model="name" required autocomplete="off" placeholder="Home workstation" /></label>
    <label>Relay base URL<input v-model="baseUrl" required inputmode="url" autocomplete="url" placeholder="https://relay.example.com" /></label>
    <p class="form-help">Codever checks <code>/health</code> before saving. Use HTTPS outside a trusted local network.</p>
    <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
    <p v-if="status" class="success-banner">{{ status }}</p>
    <div class="form-actions">
      <button v-if="!profile" type="button" class="button" :disabled="busy" @click="useDemo">Use offline demo</button>
      <button v-if="profile" type="button" class="button" :disabled="busy" @click="emit('cancel')">Cancel</button>
      <button class="button button--primary" :disabled="busy || !name.trim() || !baseUrl.trim()">{{ busy ? 'Checking…' : (submitLabel ?? 'Save Relay') }}</button>
    </div>
  </form>
</template>
