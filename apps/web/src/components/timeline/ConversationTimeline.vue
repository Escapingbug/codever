<script setup lang="ts">
import type { JsonValue, SessionEventEnvelope } from '@codever/protocol'
import { computed } from 'vue'
import { buildTimeline, decisionResolution } from '../../timeline/model'
import MarkdownContent from '../MarkdownContent.vue'
import DecisionEventCard from './DecisionEventCard.vue'
import ToolEventCard from './ToolEventCard.vue'

const props = defineProps<{
  events: SessionEventEnvelope[]
  mutable: boolean
  submittingDecisionId?: string
}>()
const emit = defineEmits<{
  resolveDecision: [decisionId: string, value: JsonValue]
  select: [event: SessionEventEnvelope]
}>()
const entries = computed(() => buildTimeline(props.events))

const time = (timestamp: string) => new Intl.DateTimeFormat(undefined, {
  hour: '2-digit', minute: '2-digit',
}).format(new Date(timestamp))

function select(event: Event, envelope: SessionEventEnvelope): void {
  const target = event.target
  if (target instanceof Element && target.closest('button, a, input, select, textarea, summary, [role="button"]')) return
  emit('select', envelope)
}
</script>

<template>
  <div v-if="entries.length" class="timeline">
    <template v-for="entry in entries" :key="entry.key">
      <article v-if="entry.type === 'assistant'" class="message message--assistant" :data-timeline-key="entry.key" @click="select($event, entry.events[0]!)">
        <div class="message-body">
          <div class="message-meta message-meta--agent">
            <span>Agent · {{ time(entry.events[0]!.timestamp) }}</span>
            <span class="agent-reply-state" :class="`agent-reply-state--${entry.status}`">
              <i />{{ entry.status === 'working' ? 'Working' : entry.status.replace('_', ' ') }}
            </span>
          </div>
          <MarkdownContent class="assistant-copy" :content="entry.text" />
        </div>
      </article>

      <ToolEventCard v-else-if="entry.type === 'tool'" :entry="entry" :data-timeline-key="entry.key" @click="select($event, entry.events.at(-1)!)" />

      <template v-else>
        <article
          v-if="entry.envelope.event.kind === 'user_message'"
          class="message message--user"
          :data-timeline-key="entry.key"
          @click="select($event, entry.envelope)"
        >
          <div class="message-body">
            <div class="message-meta"><strong>You</strong><span>{{ time(entry.envelope.timestamp) }}</span></div>
            <div v-if="entry.envelope.event.text">{{ entry.envelope.event.text }}</div>
            <div v-if="entry.envelope.event.attachments?.length" class="message-attachments">
              <span v-for="attachment in entry.envelope.event.attachments" :key="attachment.id" class="attachment-chip">
                <strong>{{ attachment.filename }}</strong><small>{{ Math.max(1, Math.round(attachment.sizeBytes / 1024)) }} KiB</small>
              </span>
            </div>
          </div>
        </article>

        <DecisionEventCard
          v-else-if="entry.envelope.event.kind === 'decision_request'"
          :data-timeline-key="entry.key"
          :request="entry.envelope.event"
          :resolution="decisionResolution(events, entry.envelope.event.decisionId)"
          :disabled="!mutable"
          :submitting="submittingDecisionId === entry.envelope.event.decisionId"
          @resolve="emit('resolveDecision', entry.envelope.event.decisionId, $event)"
          @click="select($event, entry.envelope)"
        />

        <article
          v-else-if="entry.envelope.event.kind === 'status'"
          class="event-card status-event"
          :data-timeline-key="entry.key"
          :class="`status-event--${entry.envelope.event.level}`"
          @click="select($event, entry.envelope)"
        >
          <span>{{ entry.envelope.event.level === 'error' ? '!' : 'i' }}</span>
          <p>{{ entry.envelope.event.message }}</p>
        </article>

        <div
          v-else-if="entry.envelope.event.kind !== 'decision_resolved'"
          class="system-event"
          :data-timeline-key="entry.key"
          @click="select($event, entry.envelope)"
        >
          <span />
          <strong>{{ entry.envelope.event.kind.replaceAll('_', ' ') }}</strong>
          <small v-if="entry.envelope.event.kind === 'session_state'">{{ entry.envelope.event.state }}</small>
          <small v-else-if="entry.envelope.event.kind === 'mode_change'">{{ entry.envelope.event.mode }}</small>
          <small v-else-if="entry.envelope.event.kind === 'turn_finished'">{{ entry.envelope.event.status }}</small>
        </div>
      </template>
    </template>
  </div>
  <div v-else class="empty-state empty-state--timeline">
    <span class="empty-orbit">✦</span>
    <h2>Start the conversation</h2>
    <p>Ask the agent to explore, explain, or change this project.</p>
  </div>
</template>
