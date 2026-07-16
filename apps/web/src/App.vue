<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppNavigation from './components/AppNavigation.vue'
import PwaUpdateBanner from './components/PwaUpdateBanner.vue'
import { navigateToParent } from './navigation'
import { clientSession } from './state/clientSession'

const route = useRoute()
const router = useRouter()
const depth = computed(() => route.name === 'session' ? 3 : route.name === 'project' ? 2 : 1)
const showBack = computed(() => depth.value > 1)
const isPublicEntry = computed(() => route.name === 'onboarding' || route.name === 'login')
</script>

<template>
  <div class="app-shell" :class="[`route-depth-${depth}`, { 'app-shell--entry': isPublicEntry }]">
    <PwaUpdateBanner />
    <header v-if="!isPublicEntry" class="mobile-header">
      <button v-if="showBack" class="icon-button" aria-label="Go back" @click="navigateToParent(router)">←</button>
      <span v-else />
      <RouterLink class="mobile-brand" to="/gateways"><span class="brand-mark">C</span> Codever</RouterLink>
      <RouterLink class="connection-pill" to="/settings">{{ clientSession.activeProfile.value?.name ?? 'Relay' }}</RouterLink>
    </header>
    <AppNavigation v-if="!isPublicEntry" />
    <main class="main-stage"><RouterView /></main>
  </div>
</template>
