<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { clientSession, friendlyRelayError } from '../state/clientSession'
import { isDemoRelayUrl } from '../api/demoRelay'

const route = useRoute()
const router = useRouter()
const demo = isDemoRelayUrl(clientSession.activeProfile.value?.baseUrl ?? '')
const username = ref(demo ? 'demo' : '')
const password = ref(demo ? 'demo' : '')
const deviceName = ref(defaultDeviceName())
const busy = ref(false)
const error = ref(clientSession.initializationError.value)

async function login(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    await clientSession.login({ username: username.value, password: password.value, deviceName: deviceName.value || undefined })
    const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/') ? route.query.redirect : '/gateways'
    await router.replace(redirect)
  } catch (cause) {
    error.value = friendlyRelayError(cause)
  } finally {
    busy.value = false
  }
}

function defaultDeviceName(): string {
  const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent)
  return mobile ? 'Codever mobile' : 'Codever web'
}
</script>

<template>
  <main class="entry-page">
    <section class="entry-card entry-card--narrow">
      <div class="entry-brand"><span class="brand-mark">C</span><span>Codever</span></div>
      <span class="eyebrow">{{ clientSession.activeProfile.value?.name }}</span>
      <h1>Sign in to Relay</h1>
      <p class="entry-copy">{{ clientSession.activeProfile.value?.baseUrl }}</p>
      <p v-if="demo" class="success-banner">Offline demo: credentials are prefilled. No network connection is used.</p>
      <form class="relay-form" @submit.prevent="login">
        <label>Username<input v-model="username" required autocomplete="username" autocapitalize="none" /></label>
        <label>Password<input v-model="password" required type="password" autocomplete="current-password" /></label>
        <label>Device name<input v-model="deviceName" maxlength="120" autocomplete="off" /></label>
        <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
        <button class="button button--primary entry-submit" :disabled="busy">{{ busy ? 'Signing in…' : 'Sign in' }}</button>
      </form>
      <RouterLink class="text-link" to="/onboarding?add=1">Add another Relay</RouterLink>
    </section>
  </main>
</template>
