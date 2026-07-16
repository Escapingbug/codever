<script setup lang="ts">
defineProps<{
  status: string
  label?: string
}>()
</script>

<template>
  <span class="status-label" :title="label ?? status">
    <span class="status-dot" :class="`status-dot--${status}`" aria-hidden="true" />
    <span v-if="label">{{ label }}</span>
  </span>
</template>
