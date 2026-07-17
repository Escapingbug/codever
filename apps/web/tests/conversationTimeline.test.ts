// @vitest-environment jsdom
import type { SessionEventEnvelope } from '@codever/protocol'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ConversationTimeline from '../src/components/timeline/ConversationTimeline.vue'

const decision: SessionEventEnvelope = {
  schemaVersion: 1,
  gatewayId: 'gateway-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  seq: 1,
  eventId: 'event-1',
  timestamp: '2026-07-17T00:00:00.000Z',
  event: {
    kind: 'decision_request',
    decisionId: 'decision-1',
    title: 'Proceed?',
    options: [{ id: 'yes', label: 'Yes', value: true }],
    required: true,
    source: 'agent',
  },
}

describe('conversation timeline interactions', () => {
  it('resolves a decision without also opening the event inspector', async () => {
    const wrapper = mount(ConversationTimeline, {
      props: { events: [decision], mutable: true },
    })

    await wrapper.get('.decision-options button').trigger('click')

    expect(wrapper.emitted('resolveDecision')).toEqual([['decision-1', true]])
    expect(wrapper.emitted('select')).toBeUndefined()

    await wrapper.get('.decision-card').trigger('click')
    expect(wrapper.emitted('select')).toEqual([[decision]])
  })
})
