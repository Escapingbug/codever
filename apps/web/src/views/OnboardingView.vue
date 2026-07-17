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
      <h1>Connect to Codever</h1>
      <p class="entry-copy">Enter the server address you received from your Codever deployment. Computers can be authorized after this connection is ready.</p>
      <RelayProfileForm submit-label="Continue" @saved="router.replace('/login')" />
    </section>
  </main>
</template>
