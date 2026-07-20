<script setup lang="ts">
import type { CodeverSession, PatchSessionConfigDto, ProviderSessionListDto } from '@codever/protocol'
import { computed, reactive, watch } from 'vue'

const props = defineProps<{
  session: CodeverSession
  capabilities?: ProviderSessionListDto
  loading?: boolean
  error?: string
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

function saveProviderControl(configKey: string, value: string | boolean): void {
  emit('save', {
    model: form.model || null,
    mode: form.mode || null,
    config: { ...props.session.config, [configKey]: value },
  })
}
</script>

<template>
  <div class="session-controls" :class="{ 'session-controls--compact': compact }">
    <label class="session-control session-control--provider"><span>Provider</span><strong class="control-value">{{ session.provider }}</strong></label>
    <div v-if="loading" class="session-controls-loading" role="status"><span class="loader" /><span>Loading provider controls…</span></div>
    <span v-else-if="error" class="session-controls-unavailable" role="status">Provider controls unavailable</span>
    <template v-else-if="capabilities">
    <label v-if="capabilities.capabilities.changeModel" class="session-control session-control--model">
      <span>Model</span>
      <select v-model="form.model" :disabled="disabled || !models.length" @change="save">
        <option value="">Provider default</option>
        <option v-for="model in models" :key="model.id" :value="model.id">{{ model.name }}</option>
      </select>
    </label>
    <label v-if="reasoningLevels.length" class="session-control session-control--reasoning">
      <span>Reasoning</span>
      <select v-model="form.reasoningEffort" :disabled="disabled" @change="save">
        <option value="">Model default</option>
        <option v-for="level in reasoningLevels" :key="level.effort" :value="level.effort">{{ level.effort }}</option>
      </select>
    </label>
    <label v-if="capabilities.capabilities.changeMode" class="session-control session-control--mode">
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
    <label v-for="control in capabilities.controls" :key="control.id" class="session-control session-control--provider-setting" :title="control.description">
      <span>{{ control.label }}</span>
      <input v-if="control.kind === 'toggle'" type="checkbox" :checked="session.config[control.configKey] === true" :disabled="disabled" @change="saveProviderControl(control.configKey, ($event.target as HTMLInputElement).checked)" />
      <select v-else :value="typeof session.config[control.configKey] === 'string' ? session.config[control.configKey] : ''" :disabled="disabled" @change="saveProviderControl(control.configKey, ($event.target as HTMLSelectElement).value)">
        <option value="">Provider default</option>
        <option v-for="option in control.options" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
    </label>
    </template>
    <span v-if="saving" class="control-saving">Saving…</span>
  </div>
</template>
