<script setup lang="ts">
import { useRouter } from 'vue-router'
import RelayProfileForm from '../components/RelayProfileForm.vue'

const router = useRouter()
</script>

<template>
  <main class="entry-page">
    <section class="entry-card">
      <div class="entry-brand"><span class="brand-mark">C</span><span>Codever</span></div>
      <span class="eyebrow">First-time setup</span>
      <h1>Connect your Relay</h1>
      <p class="entry-copy">Add the Relay that connects this client to your remote Gateway machines. You can add more Relays later in Settings.</p>
      <RelayProfileForm submit-label="Connect Relay" @saved="router.replace('/login')" />
    </section>
  </main>
</template>
