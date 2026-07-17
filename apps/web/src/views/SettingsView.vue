<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import RelayProfileForm from '../components/RelayProfileForm.vue'
import { clientSession } from '../state/clientSession'

const router = useRouter()
const editing = ref(false)

async function forgetCredential(): Promise<void> {
  await clientSession.logout()
  await router.replace('/login')
}
</script>

<template>
  <div class="page page--overview settings-page">
    <header class="page-header page-header--compact"><div><span class="eyebrow">Codever</span><h1>Settings</h1><p>Connection and security settings for this client.</p></div></header>
    <section class="settings-section settings-card">
      <div class="section-heading"><div><span class="eyebrow">Connection</span><h2>Codever server</h2></div><button v-if="!editing" class="button" @click="editing = true">Change server</button></div>
      <RelayProfileForm v-if="editing && clientSession.activeProfile.value" :profile="clientSession.activeProfile.value" submit-label="Save server" @saved="editing = false" @cancel="editing = false" />
      <div v-else-if="clientSession.activeProfile.value" class="server-summary">
        <span class="status-dot status-dot--connected" /><div><strong>{{ clientSession.activeProfile.value.name }}</strong><small>Connected securely</small></div>
      </div>
      <details v-if="!editing && clientSession.activeProfile.value" class="machine-details"><summary>Technical details</summary><dl><div><dt>Address</dt><dd>{{ clientSession.activeProfile.value.baseUrl }}</dd></div><div><dt>Server ID</dt><dd>{{ clientSession.activeAuth.value?.relayId ?? 'Unknown' }}</dd></div><div><dt>Client credential</dt><dd>{{ clientSession.activeAuth.value?.credentialId ?? 'Unknown' }}</dd></div></dl></details>
    </section>
    <section class="settings-section account-card">
      <div><span class="eyebrow">Security</span><h2>Reconnect this client</h2><p>Remove this client's credential and require a new one-time server code.</p></div>
      <button class="button button--danger" @click="forgetCredential">Reconnect</button>
    </section>
  </div>
</template>
