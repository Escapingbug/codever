<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { clientSession, friendlyCodeverError } from '../state/clientSession'
const route = useRoute(); const router = useRouter()
const username = ref(''); const password = ref(''); const busy = ref(false)
const error = ref(clientSession.initializationError.value)
async function signIn(): Promise<void> {
  busy.value = true; error.value = ''
  try {
    await clientSession.login(username.value, password.value)
    const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/') ? route.query.redirect : '/projects'
    await router.replace(redirect)
  } catch (cause) { error.value = friendlyCodeverError(cause) }
  finally { busy.value = false }
}
</script>
<template>
  <main class="entry-page"><section class="entry-card entry-card--narrow">
    <div class="entry-brand"><span class="brand-mark">C</span><span>Codever</span></div>
    <span class="eyebrow">Private account</span><h1>Sign in to Codever</h1>
    <p class="entry-copy">Your account restores encrypted history and discovers computers. New devices still require cryptographic verification before control.</p>
    <form class="server-form" @submit.prevent="signIn">
      <label>Username<input v-model="username" required autocomplete="username" autocapitalize="none" placeholder="codever" /></label>
      <label>Password<input v-model="password" required type="password" autocomplete="current-password" /></label>
      <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
      <button class="button button--primary entry-submit" :disabled="busy">{{ busy ? 'Signing in…' : 'Sign in' }}</button>
      <button class="button" type="button" :disabled="busy" @click="router.push({ name: 'onboarding', query: { edit: '1' } })">Edit server</button>
    </form>
  </section></main>
</template>
