import type { ConversationEvent, SessionEventEnvelope } from '@codever/protocol'

export interface AssistantTimelineEntry {
  type: 'assistant'
  key: string
  text: string
  events: SessionEventEnvelope[]
}

export interface ToolTimelineEntry {
  type: 'tool'
  key: string
  events: SessionEventEnvelope[]
  latest: Extract<ConversationEvent, { kind: 'tool' }>
}

export interface EventTimelineEntry {
  type: 'event'
  key: string
  envelope: SessionEventEnvelope
}

export type TimelineEntry = AssistantTimelineEntry | ToolTimelineEntry | EventTimelineEntry

export function buildTimeline(envelopes: SessionEventEnvelope[]): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  const tools = new Map<string, ToolTimelineEntry>()

  for (const envelope of [...envelopes].sort((a, b) => a.seq - b.seq)) {
    const event = envelope.event
    if (event.kind === 'assistant_text_delta') {
      const previous = entries.at(-1)
      const turnId = event.meta?.turnId
      if (
        previous?.type === 'assistant'
        && previous.events.at(-1)?.event.meta?.turnId === turnId
      ) {
        previous.text += event.text
        previous.events.push(envelope)
      } else {
        entries.push({ type: 'assistant', key: envelope.eventId, text: event.text, events: [envelope] })
      }
      continue
    }

    if (event.kind === 'tool') {
      const existing = tools.get(event.toolCallId)
      if (existing) {
        existing.events.push(envelope)
        existing.latest = event
      } else {
        const entry: ToolTimelineEntry = {
          type: 'tool',
          key: envelope.eventId,
          events: [envelope],
          latest: event,
        }
        tools.set(event.toolCallId, entry)
        entries.push(entry)
      }
      continue
    }

    entries.push({ type: 'event', key: envelope.eventId, envelope })
  }

  return entries
}

export function decisionResolution(
  envelopes: SessionEventEnvelope[],
  decisionId: string,
): Extract<ConversationEvent, { kind: 'decision_resolved' }> | undefined {
  for (let index = envelopes.length - 1; index >= 0; index -= 1) {
    const event = envelopes[index]?.event
    if (event?.kind === 'decision_resolved' && event.decisionId === decisionId) return event
  }
  return undefined
}
