<script setup lang="ts">
import { applyPwaUpdate, pwaUpdateAvailable } from '../pwa/serviceWorker'
</script>

<template>
  <aside v-if="pwaUpdateAvailable" class="pwa-update" role="status">
    <span>Codever 有新版本可用。</span>
    <button class="button button--primary" type="button" @click="applyPwaUpdate">立即更新</button>
  </aside>
</template>
