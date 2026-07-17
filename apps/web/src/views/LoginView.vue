<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { clientSession, friendlyRelayError } from '../state/clientSession'

const route = useRoute()
const router = useRouter()
const pairingCode = ref('')
const busy = ref(false)
const error = ref(clientSession.initializationError.value)

async function pair(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    await clientSession.pairRelay(pairingCode.value)
    const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/')
      ? route.query.redirect : '/projects'
    await router.replace(redirect)
  } catch (cause) {
    error.value = friendlyRelayError(cause)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="entry-page">
    <section class="entry-card entry-card--narrow">
      <div class="entry-brand"><span class="brand-mark">C</span><span>Codever</span></div>
      <span class="eyebrow">Setup · Step 1 of 2</span>
      <h1>Pair this client with Relay</h1>
      <p class="entry-copy">{{ clientSession.activeProfile.value?.baseUrl }}</p>
      <p class="entry-copy">Enter the one-time <strong>Relay client code</strong>. It is valid for three minutes. Do not enter the Gateway code here.</p>
      <p class="form-help">After this succeeds, Codever shows the available Gateways and asks for a Gateway code separately.</p>
      <form class="relay-form" @submit.prevent="pair">
        <label>Relay client pairing code<input v-model="pairingCode" required autocomplete="one-time-code" autocapitalize="characters" placeholder="ABC234-DEFGH-JKLMN" /></label>
        <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
        <button class="button button--primary entry-submit" :disabled="busy">{{ busy ? 'Pairing Relay…' : 'Pair Relay' }}</button>
      </form>
    </section>
  </main>
</template>
