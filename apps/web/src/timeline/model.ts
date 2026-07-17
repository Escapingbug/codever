import type { ConversationEvent, SessionEventEnvelope } from '@codever/protocol'

export interface AssistantTimelineEntry {
  type: 'assistant'
  key: string
  text: string
  events: SessionEventEnvelope[]
  status: 'working' | 'success' | 'error' | 'cancelled' | 'max_turns'
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
  const assistants = new Map<string, AssistantTimelineEntry>()

  for (const envelope of [...envelopes].sort((a, b) => a.seq - b.seq)) {
    const event = envelope.event
    if (event.kind === 'turn_started') {
      const turnId = event.meta?.turnId
      if (turnId && !assistants.has(turnId)) {
        const entry: AssistantTimelineEntry = {
          type: 'assistant', key: envelope.eventId, text: '', events: [envelope], status: 'working',
        }
        assistants.set(turnId, entry)
        entries.push(entry)
      }
      continue
    }

    if (event.kind === 'assistant_text_delta') {
      const turnId = event.meta?.turnId
      const existing = turnId ? assistants.get(turnId) : undefined
      if (existing) {
        existing.text += event.text
        existing.events.push(envelope)
      } else {
        const entry: AssistantTimelineEntry = {
          type: 'assistant', key: envelope.eventId, text: event.text, events: [envelope],
          status: event.meta?.source === 'replay' ? 'success' : 'working',
        }
        if (turnId) assistants.set(turnId, entry)
        entries.push(entry)
      }
      continue
    }

    if (event.kind === 'turn_finished') {
      const assistant = event.meta?.turnId ? assistants.get(event.meta.turnId) : undefined
      if (assistant) {
        assistant.status = event.status
        assistant.events.push(envelope)
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

    if (
      event.kind === 'user_message'
      || event.kind === 'decision_request'
      || (event.kind === 'status' && event.level !== 'info')
    ) {
      entries.push({ type: 'event', key: envelope.eventId, envelope })
    }
  }

  return entries.filter(entry => entry.type !== 'assistant'
    || entry.text.length > 0
    || entry.status === 'working'
    || entry.status === 'error')
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
