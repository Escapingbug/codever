<script setup lang="ts">
import type { CodeverSession, PatchSessionConfigDto, ProviderSessionListDto } from '@codever/protocol'
import { computed, reactive, watch } from 'vue'

const props = defineProps<{
  session: CodeverSession
  capabilities?: ProviderSessionListDto
  disabled?: boolean
  saving?: boolean
  compact?: boolean
}>()
const emit = defineEmits<{ save: [patch: PatchSessionConfigDto] }>()

const form = reactive({ model: '', mode: '', permissionMode: '', reasoningEffort: '' })
const models = computed(() => props.capabilities?.models ?? [])
const reasoningLevels = computed(() => models.value
  .find(model => model.id === form.model)?.supportedReasoningLevels
  ?? models.value[0]?.supportedReasoningLevels
  ?? [])

watch(() => props.session, session => {
  form.model = session.model ?? ''
  form.mode = session.mode ?? ''
  form.permissionMode = typeof session.config.permissionMode === 'string' ? session.config.permissionMode : ''
  form.reasoningEffort = typeof session.config.reasoningEffort === 'string' ? session.config.reasoningEffort : ''
}, { immediate: true })

function save(): void {
  emit('save', {
    model: form.model || null,
    mode: form.mode || null,
    config: {
      ...props.session.config,
      permissionMode: form.permissionMode || null,
      reasoningEffort: form.reasoningEffort || null,
    },
  })
}
</script>

<template>
  <div class="session-controls" :class="{ 'session-controls--compact': compact }">
    <label class="session-control session-control--provider"><span>Provider</span><strong class="control-value">{{ session.provider }}</strong></label>
    <label class="session-control session-control--model">
      <span>Model</span>
      <select v-if="models.length" v-model="form.model" :disabled="disabled" @change="save">
        <option value="">Provider default</option>
        <option v-for="model in models" :key="model.id" :value="model.id">{{ model.name }}</option>
      </select>
      <input v-else v-model="form.model" :disabled="disabled" placeholder="Provider default" @change="save" />
    </label>
    <label v-if="reasoningLevels.length" class="session-control session-control--reasoning">
      <span>Reasoning</span>
      <select v-model="form.reasoningEffort" :disabled="disabled" @change="save">
        <option value="">Model default</option>
        <option v-for="level in reasoningLevels" :key="level.effort" :value="level.effort">{{ level.effort }}</option>
      </select>
    </label>
    <label class="session-control session-control--mode">
      <span>Mode</span>
      <select v-model="form.mode" :disabled="disabled" @change="save">
        <option value="">Default</option><option value="agent">Agent</option><option value="ask">Ask</option><option value="plan">Plan</option>
      </select>
    </label>
    <label v-if="capabilities?.permissionModes.length" class="session-control session-control--permissions">
      <span>Permissions</span>
      <select v-model="form.permissionMode" :disabled="disabled" @change="save">
        <option value="">Provider default</option>
        <option v-for="permission in capabilities.permissionModes" :key="permission" :value="permission">{{ permission }}</option>
      </select>
    </label>
    <span v-if="saving" class="control-saving">Saving…</span>
  </div>
</template>
