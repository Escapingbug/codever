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
    <header class="page-header">
      <div><span class="eyebrow">Client</span><h1>Settings</h1><p>Manage the Relay connection and native OPAQUE credential.</p></div>
    </header>
    <section class="settings-section">
      <div class="section-heading">
        <div><span class="eyebrow">Connection</span><h2>Relay</h2></div>
        <button v-if="!editing" class="button" @click="editing = true">Edit Relay</button>
      </div>
      <RelayProfileForm
        v-if="editing && clientSession.activeProfile.value"
        :profile="clientSession.activeProfile.value"
        submit-label="Save Relay"
        @saved="editing = false"
        @cancel="editing = false"
      />
      <div v-else-if="clientSession.activeProfile.value" class="profile-list">
        <article class="profile-card profile-card--active">
          <div>
            <strong>{{ clientSession.activeProfile.value.name }}</strong>
            <small>{{ clientSession.activeProfile.value.baseUrl }}</small>
            <span class="active-badge">Connected Relay</span>
          </div>
        </article>
      </div>
    </section>
    <section class="settings-section account-card">
      <div>
        <span class="eyebrow">Relay credential</span>
        <h2>{{ clientSession.activeAuth.value?.relayId }}</h2>
        <p>Client {{ clientSession.activeAuth.value?.credentialId }} · paired {{ new Date(clientSession.activeAuth.value?.createdAt ?? '').toLocaleString() }}</p>
      </div>
      <button class="button button--danger" @click="forgetCredential">Re-pair Relay</button>
    </section>
  </div>
</template>
