<script setup lang="ts">
import type { ToolOutputListItemDto } from '@codever/protocol'
import { computed, inject, ref } from 'vue'
import { codeverApiKey } from '../../api/codeverApi'
import type { ToolTimelineEntry } from '../../timeline/model'

const props = defineProps<{ entry: ToolTimelineEntry; sessionId: string }>()
const api = inject(codeverApiKey)
const expanded = ref(props.entry.latest.phase === 'failed')
const loading = ref(false)
const deleted = ref(false)
const error = ref('')
const visibleOutput = ref('')
const title = computed(() => props.entry.latest.displayTitle || props.entry.latest.toolName)
const outputRef = computed(() => props.entry.latest.outputRef)
const requiresDownload = computed(() => (outputRef.value?.sizeBytes ?? 0) > 256 * 1024)

function outputRecord(): ToolOutputListItemDto {
  const output = outputRef.value
  if (!output) throw new Error('This tool result was not retained')
  return {
    ...output,
    sessionId: props.sessionId,
    toolCallId: props.entry.latest.toolCallId,
    toolName: props.entry.latest.toolName,
    createdAt: props.entry.events.at(-1)!.timestamp,
  }
}

async function viewOutput(): Promise<void> {
  if (!api || requiresDownload.value) return
  loading.value = true; error.value = ''
  try {
    const text = await (await api.downloadToolOutput(outputRecord())).text()
    try { visibleOutput.value = JSON.stringify(JSON.parse(text), null, 2) }
    catch { visibleOutput.value = text }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not load tool output'
  } finally { loading.value = false }
}

async function downloadOutput(): Promise<void> {
  if (!api || !confirm(`Download ${formatBytes(outputRef.value?.sizeBytes ?? 0)} tool output?`)) return
  loading.value = true; error.value = ''
  try {
    const blob = await api.downloadToolOutput(outputRecord())
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url; link.download = `${props.entry.latest.toolName}-result.json`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1_000)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not download tool output'
  } finally { loading.value = false }
}

async function deleteOutput(): Promise<void> {
  const output = outputRef.value
  if (!api || !output || !confirm('Delete this retained tool output from the Computer?')) return
  loading.value = true; error.value = ''
  try {
    await api.deleteToolOutputs(props.sessionId, [output.outputId])
    deleted.value = true; visibleOutput.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not delete tool output'
  } finally { loading.value = false }
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / 1024 / 1024).toFixed(1)} MiB`
}
</script>

<template>
  <article class="event-card tool-card" :class="{ 'event-card--error': entry.latest.isError || entry.latest.phase === 'failed' }">
    <button class="tool-summary" type="button" @click="expanded = !expanded">
      <span class="tool-icon">{{ entry.latest.category === 'execute' ? '›_' : entry.latest.category === 'edit' ? '±' : '◆' }}</span>
      <span><strong>{{ title }}</strong><small>{{ entry.latest.category ?? 'tool' }} · {{ entry.latest.phase }}</small></span>
      <span class="tool-phase" :class="`tool-phase--${entry.latest.phase}`">{{ entry.latest.phase }}</span>
      <span class="chevron">{{ expanded ? '⌃' : '⌄' }}</span>
    </button>
    <div v-if="expanded" class="tool-details">
      <p v-if="deleted" class="tool-output-note">Result deleted from the Computer.</p>
      <template v-else-if="outputRef">
        <p class="tool-output-note">Result retained on the Computer · {{ formatBytes(outputRef.sizeBytes) }}</p>
        <div class="tool-output-actions">
          <button v-if="!requiresDownload && !visibleOutput" type="button" :disabled="loading" @click="viewOutput">{{ loading ? 'Loading…' : 'View result' }}</button>
          <button type="button" :disabled="loading" @click="downloadOutput">Download…</button>
          <button type="button" class="danger-link" :disabled="loading" @click="deleteOutput">Delete</button>
        </div>
        <p v-if="requiresDownload" class="tool-output-note">This result is large. Confirm download to transfer it from the Computer.</p>
        <pre v-if="visibleOutput" class="tool-output-preview">{{ visibleOutput }}</pre>
      </template>
      <p v-else class="tool-output-note">Result not retained. Only the tool activity is stored.</p>
      <p v-if="error" class="inline-error">{{ error }}</p>
    </div>
  </article>
</template>
