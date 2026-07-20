<script setup lang="ts">
import type { JsonValue, SessionEventEnvelope } from '@codever/protocol'
import { computed } from 'vue'
import { buildTimeline, decisionResolution } from '../../timeline/model'
import MarkdownContent from '../MarkdownContent.vue'
import DecisionEventCard from './DecisionEventCard.vue'
import ToolEventCard from './ToolEventCard.vue'
import type { PendingUserMessage } from '../../timeline/pendingMessage'

const props = defineProps<{
  events: SessionEventEnvelope[]
  pendingMessages?: PendingUserMessage[]
  mutable: boolean
  inspectable?: boolean
  inspectHandler?: (event: SessionEventEnvelope) => void
  sessionId: string
  submittingDecisionId?: string
}>()
const emit = defineEmits<{
  resolveDecision: [decisionId: string, value: JsonValue]
  openLocalFile: [path: string]
}>()
const entries = computed(() => buildTimeline(props.events))

const time = (timestamp: string) => new Intl.DateTimeFormat(undefined, {
  hour: '2-digit', minute: '2-digit',
}).format(new Date(timestamp))

function inspectFromTimeline(event: Event): void {
  if (!props.inspectable) return
  const target = event.target
  if (!(target instanceof Element)) return
  if (target.closest('button, a, input, select, textarea, summary, [role="button"]')) return
  const item = target.closest<HTMLElement>('[data-inspect-event-id]')
  const eventId = item?.dataset.inspectEventId
  const envelope = props.events.find(value => value.eventId === eventId)
  if (envelope) props.inspectHandler?.(envelope)
}
</script>

<template>
  <div
    v-if="entries.length || pendingMessages?.length"
    class="timeline"
    :class="{ 'timeline--inspectable': inspectable }"
    role="log"
    aria-live="polite"
    aria-relevant="additions text"
    @click.capture="inspectFromTimeline"
  >
    <template v-for="entry in entries" :key="entry.key">
      <article
        v-if="entry.type === 'assistant'"
        class="message message--assistant"
        :data-timeline-key="entry.key"
        :data-inspect-event-id="entry.events[0]!.eventId"
        :aria-label="`Agent response (${entry.status}): ${entry.text}`"
        role="article"
        :tabindex="inspectable ? 0 : undefined"
      >
        <div class="message-body">
          <div class="message-meta message-meta--agent">
            <span>Agent · {{ time(entry.events[0]!.timestamp) }}</span>
            <span class="agent-reply-state" :class="`agent-reply-state--${entry.status}`">
              <i />{{ entry.status === 'working' ? 'Working' : entry.status.replace('_', ' ') }}
            </span>
          </div>
          <MarkdownContent class="assistant-copy" :content="entry.text" @open-local-file="emit('openLocalFile', $event)" />
        </div>
      </article>

      <ToolEventCard v-else-if="entry.type === 'tool'" :entry="entry" :session-id="sessionId" :data-timeline-key="entry.key" :data-inspect-event-id="entry.events.at(-1)!.eventId" />

      <template v-else>
        <article
          v-if="entry.envelope.event.kind === 'user_message'"
          class="message message--user"
          :data-timeline-key="entry.key"
          :data-inspect-event-id="entry.envelope.eventId"
          :aria-label="`Your message: ${entry.envelope.event.text}`"
          role="article"
          :tabindex="inspectable ? 0 : undefined"
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
          :data-inspect-event-id="entry.envelope.eventId"
          :request="entry.envelope.event"
          :resolution="decisionResolution(events, entry.envelope.event.decisionId)"
          :disabled="!mutable"
          :submitting="submittingDecisionId === entry.envelope.event.decisionId"
          @resolve="emit('resolveDecision', entry.envelope.event.decisionId, $event)"
        />

        <article
          v-else-if="entry.envelope.event.kind === 'status'"
          class="event-card status-event"
          :data-timeline-key="entry.key"
          :data-inspect-event-id="entry.envelope.eventId"
          :class="`status-event--${entry.envelope.event.level}`"
        >
          <span>{{ entry.envelope.event.level === 'error' ? '!' : 'i' }}</span>
          <p>{{ entry.envelope.event.message }}</p>
        </article>

        <div
          v-else-if="entry.envelope.event.kind !== 'decision_resolved'"
          class="system-event"
          :data-timeline-key="entry.key"
          :data-inspect-event-id="entry.envelope.eventId"
        >
          <span />
          <strong>{{ entry.envelope.event.kind.replaceAll('_', ' ') }}</strong>
          <small v-if="entry.envelope.event.kind === 'session_state'">{{ entry.envelope.event.state }}</small>
          <small v-else-if="entry.envelope.event.kind === 'mode_change'">{{ entry.envelope.event.mode }}</small>
          <small v-else-if="entry.envelope.event.kind === 'turn_finished'">{{ entry.envelope.event.status }}</small>
        </div>
      </template>
    </template>
    <article
      v-for="message in pendingMessages ?? []"
      :key="message.clientMessageId"
      class="message message--user message--pending"
      :data-timeline-key="`pending:${message.clientMessageId}`"
      :aria-label="`Your pending message (${message.status}): ${message.text}`"
      role="article"
      tabindex="0"
    >
      <div class="message-body">
        <div class="message-meta"><strong>You</strong><span>{{ message.status === 'sending' ? 'Sending…' : 'Sent · synchronizing…' }}</span></div>
        <div v-if="message.text">{{ message.text }}</div>
        <div v-if="message.attachments.length" class="message-attachments">
          <span v-for="attachment in message.attachments" :key="attachment.id" class="attachment-chip">
            <strong>{{ attachment.filename }}</strong><small>{{ Math.max(1, Math.round(attachment.sizeBytes / 1024)) }} KiB</small>
          </span>
        </div>
      </div>
    </article>
  </div>
  <div v-else class="empty-state empty-state--timeline">
    <span class="empty-orbit">✦</span>
    <h2>Start the conversation</h2>
    <p>Ask the agent to explore, explain, or change this project.</p>
  </div>
</template>
