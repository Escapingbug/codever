<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppNavigation from './components/AppNavigation.vue'
import PwaUpdateBanner from './components/PwaUpdateBanner.vue'

const route = useRoute()
const router = useRouter()
const depth = computed(() => route.name === 'session' ? 3 : route.name === 'project' ? 2 : 1)
const showBack = computed(() => depth.value > 1)
</script>

<template>
  <div class="app-shell" :class="`route-depth-${depth}`">
    <PwaUpdateBanner />
    <header class="mobile-header">
      <button v-if="showBack" class="icon-button" aria-label="Go back" @click="router.back()">←</button>
      <RouterLink class="mobile-brand" to="/gateways"><span class="brand-mark">C</span> Codever</RouterLink>
      <span class="connection-pill">Relay</span>
    </header>
    <AppNavigation />
    <main class="main-stage">
      <RouterView />
    </main>
  </div>
</template>
