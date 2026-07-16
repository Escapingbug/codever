<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ToolTimelineEntry } from '../../timeline/model'

const props = defineProps<{ entry: ToolTimelineEntry }>()
const expanded = ref(props.entry.latest.phase === 'failed')
const title = computed(() => props.entry.latest.displayTitle || props.entry.latest.toolName)
const output = computed(() => props.entry.latest.output === undefined
  ? ''
  : typeof props.entry.latest.output === 'string'
    ? props.entry.latest.output
    : JSON.stringify(props.entry.latest.output, null, 2))
</script>

<template>
  <article class="event-card tool-card" :class="{ 'event-card--error': entry.latest.isError || entry.latest.phase === 'failed' }">
    <button class="tool-summary" type="button" @click="expanded = !expanded">
      <span class="tool-icon">{{ entry.latest.category === 'execute' ? '›_' : entry.latest.category === 'edit' ? '±' : '◇' }}</span>
      <span>
        <strong>{{ title }}</strong>
        <small>{{ entry.latest.category ?? 'tool' }} · {{ entry.latest.phase }}</small>
      </span>
      <span class="tool-phase" :class="`tool-phase--${entry.latest.phase}`">{{ entry.latest.phase }}</span>
      <span class="chevron">{{ expanded ? '⌃' : '⌄' }}</span>
    </button>
    <div v-if="expanded" class="tool-details">
      <div v-if="entry.latest.input !== undefined" class="tool-section">
        <small>Input</small>
        <pre>{{ typeof entry.latest.input === 'string' ? entry.latest.input : JSON.stringify(entry.latest.input, null, 2) }}</pre>
      </div>
      <template v-for="(content, index) in entry.latest.content" :key="index">
        <div v-if="content.type === 'diff'" class="diff-view">
          <div class="diff-path">{{ content.path }}</div>
          <pre><span class="diff-remove">- {{ content.oldText }}</span>\n<span class="diff-add">+ {{ content.newText }}</span></pre>
        </div>
        <pre v-else-if="content.type === 'terminal'" class="terminal-view">{{ content.text || 'Terminal is active…' }}</pre>
        <div v-else class="tool-text">{{ content.text }}</div>
      </template>
      <div v-if="output" class="tool-section"><small>Output</small><pre>{{ output }}</pre></div>
    </div>
  </article>
</template>
