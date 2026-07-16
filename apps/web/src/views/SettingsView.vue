<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import RelayProfileForm from '../components/RelayProfileForm.vue'
import { clientSession, type RelayProfile } from '../state/clientSession'

const router = useRouter()
const editing = ref<RelayProfile>()
const adding = ref(false)

async function switchProfile(id: string): Promise<void> {
  clientSession.selectProfile(id)
  await router.replace(clientSession.isAuthenticated.value ? '/gateways' : '/login')
}

function remove(profile: RelayProfile): void {
  if (!confirm(`Delete Relay profile “${profile.name}”?`)) return
  clientSession.removeProfile(profile.id)
  if (!clientSession.hasProfiles.value) void router.replace('/onboarding')
  else if (!clientSession.isAuthenticated.value) void router.replace('/login')
}

async function logout(): Promise<void> {
  await clientSession.logout()
  await router.replace('/login')
}
</script>

<template>
  <div class="page page--overview settings-page">
    <header class="page-header"><div><span class="eyebrow">Client</span><h1>Settings</h1><p>Manage Relay connections and this device's account session.</p></div></header>

    <section class="settings-section">
      <div class="section-heading"><div><span class="eyebrow">Connections</span><h2>Relay profiles</h2></div><button class="button" @click="adding = true; editing = undefined">Add Relay</button></div>
      <RelayProfileForm v-if="adding" submit-label="Add Relay" @saved="adding = false" @cancel="adding = false" />
      <div class="profile-list">
        <article v-for="profile in clientSession.profiles.value" :key="profile.id" class="profile-card" :class="{ 'profile-card--active': profile.id === clientSession.activeProfileId.value }">
          <RelayProfileForm v-if="editing?.id === profile.id" :profile="profile" @saved="editing = undefined" @cancel="editing = undefined" />
          <template v-else>
            <div><strong>{{ profile.name }}</strong><small>{{ profile.baseUrl }}</small><span v-if="profile.id === clientSession.activeProfileId.value" class="active-badge">Active</span></div>
            <div class="profile-actions"><button v-if="profile.id !== clientSession.activeProfileId.value" class="button" @click="switchProfile(profile.id)">Switch</button><button class="button" @click="editing = profile; adding = false">Edit</button><button class="button button--danger" @click="remove(profile)">Delete</button></div>
          </template>
        </article>
      </div>
    </section>

    <section class="settings-section account-card">
      <div><span class="eyebrow">Current account</span><h2>{{ clientSession.activeAuth.value?.user.username }}</h2><p>{{ clientSession.activeAuth.value?.user.roles.join(', ') }} · expires {{ new Date(clientSession.activeAuth.value?.expiresAt ?? '').toLocaleString() }}</p></div>
      <button class="button button--danger" @click="logout">Sign out</button>
    </section>
  </div>
</template>
