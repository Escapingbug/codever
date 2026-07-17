<script setup lang="ts">
import { ref } from 'vue'
import {
  clientSession,
  DEFAULT_RELAY_PORT,
  friendlyRelayError,
  relayProfileAddress,
  type RelayProfile,
} from '../state/clientSession'

const props = defineProps<{ profile?: RelayProfile; submitLabel?: string }>()
const emit = defineEmits<{ saved: [profile: RelayProfile]; cancel: [] }>()
const initialAddress = props.profile ? relayProfileAddress(props.profile.baseUrl) : undefined
const name = ref(props.profile?.name ?? '')
const domain = ref(initialAddress?.domain ?? '')
const port = ref(initialAddress?.port ?? DEFAULT_RELAY_PORT)
const error = ref('')

function submit(): void {
  error.value = ''
  try {
    const profile = clientSession.saveProfile({
      id: props.profile?.id,
      name: name.value.trim() || domain.value.trim(),
      domain: domain.value,
      port: Number(port.value),
    })
    emit('saved', profile)
  } catch (cause) {
    error.value = friendlyRelayError(cause)
  }
}
</script>

<template>
  <form class="relay-form" @submit.prevent="submit">
    <label>Server address<input v-model="domain" required inputmode="url" autocomplete="url" placeholder="rd.anciety.my.id" /></label>
    <p class="form-help">Enter only the domain. Codever configures the secure connection automatically.</p>
    <details class="advanced-settings">
      <summary>Advanced connection settings</summary>
      <label>Server port<input v-model.number="port" required type="number" inputmode="numeric" min="1" max="65535" /></label>
      <label>Display name <span class="form-help">(optional)</span><input v-model="name" autocomplete="off" placeholder="Defaults to the domain" /></label>
      <p class="form-help">The default Codever server port is {{ DEFAULT_RELAY_PORT }}. Change it only for a custom deployment.</p>
    </details>
    <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
    <div class="form-actions">
      <button v-if="profile" type="button" class="button" @click="emit('cancel')">Cancel</button>
      <button class="button button--primary" :disabled="!domain.trim()">{{ submitLabel ?? 'Save server' }}</button>
    </div>
  </form>
</template>
