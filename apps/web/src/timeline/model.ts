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
  const assistantSegments = new Map<string, AssistantTimelineEntry[]>()
  const activeAssistants = new Map<string, AssistantTimelineEntry>()

  const createAssistant = (envelope: SessionEventEnvelope, text = ''): AssistantTimelineEntry => {
    const entry: AssistantTimelineEntry = {
      type: 'assistant', key: envelope.eventId, text, events: [envelope], status: 'working',
    }
    const turnId = envelope.event.meta?.turnId
    if (turnId) {
      const segments = assistantSegments.get(turnId) ?? []
      segments.push(entry)
      assistantSegments.set(turnId, segments)
      activeAssistants.set(turnId, entry)
    }
    entries.push(entry)
    return entry
  }

  for (const envelope of [...envelopes].sort((a, b) => a.seq - b.seq)) {
    const event = envelope.event
    if (event.kind === 'turn_started') {
      const turnId = event.meta?.turnId
      if (turnId && !assistantSegments.has(turnId)) createAssistant(envelope)
      continue
    }

    if (event.kind === 'assistant_text_delta') {
      const turnId = event.meta?.turnId
      const existing = turnId ? activeAssistants.get(turnId) : undefined
      if (existing) {
        existing.text += event.text
        existing.events.push(envelope)
      } else {
        const entry = createAssistant(envelope, event.text)
        if (event.meta?.source === 'replay') entry.status = 'success'
      }
      continue
    }

    if (event.kind === 'turn_finished') {
      const turnId = event.meta?.turnId
      const segments = turnId ? assistantSegments.get(turnId) : undefined
      if (segments?.length) {
        for (const assistant of segments) assistant.status = event.status
        segments.at(-1)!.events.push(envelope)
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
        // Text emitted after a newly inserted tool belongs after that tool in
        // the visual timeline. Later lifecycle updates still edit the original
        // tool card in place and do not create another split.
        const turnId = event.meta?.turnId
        if (turnId) activeAssistants.delete(turnId)
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
