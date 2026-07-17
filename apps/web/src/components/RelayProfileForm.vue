<script setup lang="ts">
import { ref } from 'vue'
import { clientSession, friendlyRelayError, type RelayProfile } from '../state/clientSession'

const props = defineProps<{ profile?: RelayProfile; submitLabel?: string }>()
const emit = defineEmits<{ saved: [profile: RelayProfile]; cancel: [] }>()
const name = ref(props.profile?.name ?? '')
const baseUrl = ref(props.profile?.baseUrl ?? '')
const error = ref('')

function submit(): void {
  error.value = ''
  try {
    const profile = clientSession.saveProfile({ id: props.profile?.id, name: name.value, baseUrl: baseUrl.value })
    emit('saved', profile)
  } catch (cause) {
    error.value = friendlyRelayError(cause)
  }
}
</script>

<template>
  <form class="relay-form" @submit.prevent="submit">
    <label>Profile name<input v-model="name" required autocomplete="off" placeholder="Home Relay" /></label>
    <label>Relay base URL<input v-model="baseUrl" required inputmode="url" autocomplete="url" placeholder="http://relay.example.com:8787" /></label>
    <p class="form-help">The Relay identity is verified by OPAQUE pairing. HTTPS is optional for this native protocol.</p>
    <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
    <div class="form-actions">
      <button v-if="profile" type="button" class="button" @click="emit('cancel')">Cancel</button>
      <button class="button button--primary" :disabled="!name.trim() || !baseUrl.trim()">{{ submitLabel ?? 'Save Relay' }}</button>
    </div>
  </form>
</template>
