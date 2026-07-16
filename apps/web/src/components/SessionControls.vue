<script setup lang="ts">
import type { CodeverSession, Gateway, JsonObject } from '@codever/protocol'
import { reactive, watch } from 'vue'

const props = defineProps<{
  session: CodeverSession
  gateway?: Gateway
  disabled?: boolean
  saving?: boolean
}>()
const emit = defineEmits<{ save: [config: JsonObject] }>()

const form = reactive({ provider: '', model: '', mode: '' })
watch(() => props.session, (session) => {
  form.provider = session.provider
  form.model = session.model ?? ''
  form.mode = session.mode ?? ''
}, { immediate: true })

function save(): void {
  emit('save', {
    provider: form.provider,
    model: form.model || null,
    mode: form.mode || null,
  })
}
</script>

<template>
  <div class="session-controls">
    <label>
      <span>Provider</span>
      <select v-model="form.provider" :disabled="disabled" @change="save">
        <option v-for="provider in gateway?.capabilities.providers ?? [session.provider]" :key="provider">{{ provider }}</option>
      </select>
    </label>
    <label>
      <span>Model</span>
      <input v-model="form.model" :disabled="disabled" placeholder="Default model" @change="save" />
    </label>
    <label>
      <span>Mode</span>
      <select v-model="form.mode" :disabled="disabled" @change="save">
        <option value="">Default</option>
        <option value="agent">Agent</option>
        <option value="ask">Ask</option>
        <option value="plan">Plan</option>
      </select>
    </label>
    <span v-if="saving" class="control-saving">Saving…</span>
  </div>
</template>
