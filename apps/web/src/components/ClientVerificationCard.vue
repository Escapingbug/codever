<script setup lang="ts">
import { computed } from 'vue'
import type { MatrixDeviceSnapshot, MatrixVerificationSnapshot } from '../api/nativeMatrixClient'

const props = defineProps<{
  flow: MatrixVerificationSnapshot
  device?: MatrixDeviceSnapshot
  busy?: boolean
}>()

defineEmits<{
  advance: []
  confirm: [matches: boolean]
  cancel: []
}>()

const title = computed(() => props.device?.displayName || props.flow.otherDeviceId || 'New Codever client')
const canAdvance = computed(() => {
  if (props.flow.stage === 'requested') return props.flow.weStarted === false
  if (props.flow.stage === 'ready') return props.flow.weStarted === true
  if (props.flow.stage === 'sas') return props.flow.weStarted === false
  return false
})
const waiting = computed(() => ['created', 'requested', 'ready', 'sas'].includes(props.flow.stage) && !canAdvance.value)
</script>

<template>
  <article class="authorization-card client-verification-card">
    <span class="eyebrow">Client verification</span>
    <h3>{{ title }}</h3>
    <p>Compare this client directly with the other signed-in client. The Gateway does not need to be opened.</p>
    <small v-if="flow.otherDeviceId">Matrix device {{ flow.otherDeviceId }}</small>

    <p v-if="waiting" class="verification-wait" role="status">Waiting for the other client…</p>
    <button v-if="canAdvance" class="button button--primary" :disabled="busy" @click="$emit('advance')">
      {{ flow.stage === 'requested' ? 'Accept verification' : 'Continue verification' }}
    </button>

    <template v-if="flow.stage === 'present_sas'">
      <div class="verification-emoji" aria-label="Client verification emoji">
        <span v-for="emoji in flow.emojis" :key="emoji.description" :title="emoji.description">{{ emoji.symbol }}</span>
      </div>
      <p>Confirm only if both clients show these emoji in the same order.</p>
      <div class="form-actions">
        <button class="button" :disabled="busy" @click="$emit('confirm', false)">They differ</button>
        <button class="button button--primary" :disabled="busy" @click="$emit('confirm', true)">They match</button>
      </div>
    </template>

    <p v-if="flow.stage === 'cancelled'" class="error-banner" role="alert">
      {{ flow.cancellation?.reason || 'Verification was cancelled.' }}
    </p>
    <p v-if="flow.stage === 'unsupported'" class="error-banner" role="alert">This client does not support SAS verification.</p>
    <button v-if="!['done', 'cancelled'].includes(flow.stage)" class="button" :disabled="busy" @click="$emit('cancel')">Cancel</button>
  </article>
</template>
