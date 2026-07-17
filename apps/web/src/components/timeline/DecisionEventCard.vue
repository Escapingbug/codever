<script setup lang="ts">
import type { ConversationEvent, JsonValue } from '@codever/protocol'

type Request = Extract<ConversationEvent, { kind: 'decision_request' }>
type Resolution = Extract<ConversationEvent, { kind: 'decision_resolved' }>

defineProps<{
  request: Request
  resolution?: Resolution
  disabled?: boolean
  submitting?: boolean
}>()

const emit = defineEmits<{ resolve: [value: JsonValue] }>()
</script>

<template>
  <article class="event-card decision-card">
    <div class="decision-heading">
      <span class="decision-icon">?</span>
      <div><small>Decision required</small><h3>{{ request.title }}</h3></div>
    </div>
    <p v-if="request.body">{{ request.body }}</p>
    <div v-if="resolution" class="decision-resolved">Resolved · {{ resolution.optionId ?? 'custom response' }}</div>
    <div v-else class="decision-options">
      <button
        v-for="option in request.options"
        :key="option.id"
        class="button"
        :class="[`button--${option.style ?? 'default'}`]"
        :disabled="disabled || submitting"
        @click.stop="emit('resolve', option.value)"
      >{{ option.label }}</button>
    </div>
    <small v-if="disabled && !resolution" class="offline-copy">Reconnect to answer this decision.</small>
  </article>
</template>
