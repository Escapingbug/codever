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
      <span class="eyebrow">{{ clientSession.activeProfile.value?.name }}</span>
      <h1>Pair with Relay</h1>
      <p class="entry-copy">{{ clientSession.activeProfile.value?.baseUrl }}</p>
      <p class="entry-copy">Run <code>pnpm --filter @codever/relay pair:client</code> on the Relay host, then enter the one-time code within three minutes.</p>
      <form class="relay-form" @submit.prevent="pair">
        <label>One-time pairing code<input v-model="pairingCode" required autocomplete="one-time-code" autocapitalize="characters" /></label>
        <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
        <button class="button button--primary entry-submit" :disabled="busy">{{ busy ? 'Pairing…' : 'Pair securely' }}</button>
      </form>
      <RouterLink class="text-link" to="/onboarding?add=1">Add another Relay</RouterLink>
    </section>
  </main>
</template>
