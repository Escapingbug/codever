// @vitest-environment jsdom
import type { SessionEventEnvelope } from '@codever/protocol'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
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

const assistant: SessionEventEnvelope = {
  ...decision,
  eventId: 'assistant-1',
  event: { kind: 'assistant_text_delta', text: 'Ready', meta: { source: 'replay', turnId: 'turn-1' } },
}

describe('conversation timeline interactions', () => {
  it('resolves a decision without also opening the event inspector', async () => {
    const onInspect = vi.fn()
    const wrapper = mount(ConversationTimeline, {
      props: { events: [decision], sessionId: 'session-1', mutable: true, inspectHandler: onInspect },
    })

    await wrapper.get('.decision-options button').trigger('click')

    expect(wrapper.emitted('resolveDecision')).toEqual([['decision-1', true]])
    expect(onInspect).not.toHaveBeenCalled()

    await wrapper.get('.decision-card').trigger('click')
    expect(onInspect).not.toHaveBeenCalled()

    await wrapper.setProps({ inspectable: true })
    await wrapper.get('.decision-card').trigger('click')
    expect(onInspect).toHaveBeenCalledWith(decision)
  })

  it('selects an assistant event only while inspect mode is enabled', async () => {
    const onInspect = vi.fn()
    const wrapper = mount(ConversationTimeline, {
      props: { events: [assistant], sessionId: 'session-1', mutable: true, inspectable: true, inspectHandler: onInspect },
    })
    await wrapper.get('.message--assistant').trigger('click')
    expect(onInspect).toHaveBeenCalledWith(assistant)
  })
})
