<script setup lang="ts">
import { ref } from 'vue'
import { clientSession, friendlyCodeverError } from '../state/clientSession'
const props = defineProps<{ domain?: string; submitLabel?: string }>()
const emit = defineEmits<{ saved: []; cancel: [] }>()
const domain = ref(props.domain ?? '')
const error = ref('')
function submit(): void {
  try { clientSession.configureServer(domain.value); emit('saved') }
  catch (cause) { error.value = friendlyCodeverError(cause) }
}
</script>
<template>
  <form class="server-form" @submit.prevent="submit">
    <label>Server domain<input v-model="domain" required inputmode="url" autocomplete="url" placeholder="rd.anciety.my.id" /></label>
    <p class="form-help">Enter only the domain. Codever uses standard HTTPS and Matrix encryption automatically.</p>
    <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
    <div class="form-actions">
      <button v-if="props.domain" type="button" class="button" @click="emit('cancel')">Cancel</button>
      <button class="button button--primary" :disabled="!domain.trim()">{{ submitLabel ?? 'Continue' }}</button>
    </div>
  </form>
</template>
