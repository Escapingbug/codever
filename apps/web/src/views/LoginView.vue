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
    const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/') ? route.query.redirect : '/projects'
    await router.replace(redirect)
  } catch (cause) {
    error.value = friendlyRelayError(cause)
  } finally {
    busy.value = false
  }
}

async function editServer(): Promise<void> {
  await router.push({ name: 'onboarding', query: { edit: '1' } })
}
</script>

<template>
  <main class="entry-page">
    <section class="entry-card entry-card--narrow">
      <div class="entry-brand"><span class="brand-mark">C</span><span>Codever</span></div>
      <span class="eyebrow">Secure connection</span><h1>Authorize this client</h1>
      <p class="entry-copy">Enter the one-time client code generated on your Codever server. It expires after three minutes.</p>
      <form class="relay-form" @submit.prevent="pair">
        <label>Client pairing code<input v-model="pairingCode" required autocomplete="one-time-code" autocapitalize="characters" placeholder="ABC234-DEFGH-JKLMN" /></label>
        <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
        <button class="button button--primary entry-submit" :disabled="busy">{{ busy ? 'Authorizing…' : 'Authorize client' }}</button>
        <button class="button" type="button" :disabled="busy" @click="editServer">Edit server</button>
      </form>
    </section>
  </main>
</template>
