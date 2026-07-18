<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from '../markdown'

const props = defineProps<{ content: string }>()
const emit = defineEmits<{ openLocalFile: [path: string] }>()
const rendered = computed(() => renderMarkdown(props.content))

function activateLink(event: MouseEvent): void {
  const target = event.target
  if (!(target instanceof Element)) return
  const link = target.closest<HTMLAnchorElement>('a[data-codever-local-file]')
  const path = link?.dataset.codeverLocalFile
  if (!path) return
  event.preventDefault()
  event.stopPropagation()
  emit('openLocalFile', path)
}
</script>

<template>
  <div class="markdown-content" v-html="rendered" @click="activateLink" />
</template>
