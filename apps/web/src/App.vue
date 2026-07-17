<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppNavigation from './components/AppNavigation.vue'
import PwaUpdateBanner from './components/PwaUpdateBanner.vue'
import { navigateToParent } from './navigation'

const route = useRoute()
const router = useRouter()
const depth = computed(() => route.name === 'session' ? 3 : route.name === 'project' ? 2 : 1)
const showBack = computed(() => depth.value > 1 || route.name === 'gateway')
const isPublicEntry = computed(() => route.name === 'onboarding' || route.name === 'login')
</script>

<template>
  <div class="app-shell" :class="[`route-depth-${depth}`, { 'app-shell--entry': isPublicEntry }]">
    <PwaUpdateBanner />
    <header v-if="!isPublicEntry" class="mobile-header">
      <button v-if="showBack" class="icon-button" aria-label="Go back" @click="navigateToParent(router)">←</button>
      <span v-else />
      <RouterLink class="mobile-brand" to="/projects"><span class="brand-mark">C</span> Codever</RouterLink>
      <span class="client-status"><span class="status-dot status-dot--connected" />Connected</span>
    </header>
    <AppNavigation v-if="!isPublicEntry" />
    <main class="main-stage"><RouterView /></main>
    <nav v-if="!isPublicEntry" class="mobile-tabs" aria-label="Primary navigation">
      <RouterLink to="/projects"><span>▣</span><strong>Projects</strong></RouterLink>
      <RouterLink to="/machines"><span>⌘</span><strong>Computers</strong></RouterLink>
      <RouterLink to="/settings"><span>⚙</span><strong>Settings</strong></RouterLink>
    </nav>
  </div>
</template>
