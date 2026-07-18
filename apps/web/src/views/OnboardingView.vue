<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import RelayProfileForm from '../components/RelayProfileForm.vue'
import { clientSession } from '../state/clientSession'

const route = useRoute()
const router = useRouter()
const editing = computed(() => route.query.edit === '1' && Boolean(clientSession.activeProfile.value))
</script>

<template>
  <main class="entry-page">
    <section class="entry-card">
      <div class="entry-brand"><span class="brand-mark">C</span><span>Codever</span></div>
      <span class="eyebrow">{{ editing ? 'Connection settings' : 'First-time setup' }}</span>
      <h1>{{ editing ? 'Edit Codever server' : 'Connect to Codever' }}</h1>
      <p class="entry-copy">Enter the server address you received from your Codever deployment. Computers can be authorized after this connection is ready.</p>
      <RelayProfileForm
        :profile="editing ? clientSession.activeProfile.value : undefined"
        :submit-label="editing ? 'Save and return' : 'Continue'"
        @saved="router.replace('/login')"
        @cancel="router.replace('/login')"
      />
    </section>
  </main>
</template>
