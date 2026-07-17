import type { SessionEventEnvelope } from '@codever/protocol'
import { describe, expect, it } from 'vitest'
import { buildTimeline, decisionResolution } from '../src/timeline/model'

const envelope = (
  seq: number,
  event: SessionEventEnvelope['event'],
): SessionEventEnvelope => ({
  schemaVersion: 1,
  gatewayId: 'gateway-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  seq,
  eventId: `event-${seq}`,
  timestamp: `2026-07-16T08:00:0${seq}.000Z`,
  event,
})

describe('timeline model', () => {
  it('coalesces assistant streaming deltas and tool lifecycle updates', () => {
    const timeline = buildTimeline([
      envelope(1, { kind: 'assistant_text_delta', text: 'Hello ', meta: { source: 'live', turnId: 'turn-1' } }),
      envelope(2, { kind: 'assistant_text_delta', text: 'world', meta: { source: 'live', turnId: 'turn-1' } }),
      envelope(3, { kind: 'tool', phase: 'started', toolCallId: 'tool-1', toolName: 'read_file' }),
      envelope(4, { kind: 'status', level: 'info', message: 'Still working' }),
      envelope(5, { kind: 'tool', phase: 'completed', toolCallId: 'tool-1', toolName: 'read_file', output: 'done' }),
    ])

    expect(timeline).toHaveLength(2)
    expect(timeline[0]).toMatchObject({ type: 'assistant', text: 'Hello world' })
    expect(timeline[1]).toMatchObject({ type: 'tool', latest: { phase: 'completed' } })
  })

  it('projects lifecycle events into assistant state and hides transport details', () => {
    const timeline = buildTimeline([
      envelope(1, { kind: 'session_state', state: 'querying' }),
      envelope(2, { kind: 'turn_started', meta: { source: 'live', turnId: 'turn-1' } }),
      envelope(3, { kind: 'provider_session', provider: 'codex', providerSessionId: 'native-1' }),
      envelope(4, { kind: 'assistant_text_delta', text: 'Done', meta: { source: 'live', turnId: 'turn-1' } }),
      envelope(5, { kind: 'command_result', command: 'internal', output: 'ok' }),
      envelope(6, { kind: 'turn_finished', status: 'success', meta: { source: 'live', turnId: 'turn-1' } }),
      envelope(7, { kind: 'session_state', state: 'idle' }),
    ])

    expect(timeline).toHaveLength(1)
    expect(timeline[0]).toMatchObject({ type: 'assistant', text: 'Done', status: 'success' })
  })

  it('finds the latest resolution for a decision', () => {
    const events = [
      envelope(1, { kind: 'decision_request', decisionId: 'decision-1', title: 'Proceed?', options: [{ id: 'yes', label: 'Yes', value: true }], required: true, source: 'agent' }),
      envelope(2, { kind: 'decision_resolved', decisionId: 'decision-1', optionId: 'yes', value: true }),
    ]
    expect(decisionResolution(events, 'decision-1')?.optionId).toBe('yes')
  })
})
