// @vitest-environment jsdom
import type { CodeverSession, ProviderSessionListDto } from '@codever/protocol'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SessionControls from '../src/components/SessionControls.vue'

const session: CodeverSession = {
  id: 'session-1', gatewayId: 'gateway-1', projectId: 'project-1', title: 'Task',
  state: 'idle', provider: 'codex', model: 'gpt-5', mode: 'agent',
  config: { permissionMode: 'workspace-write', reasoningEffort: 'medium' },
  createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z', lastEventSeq: 1,
}

const capabilities: ProviderSessionListDto = {
  projectId: 'project-1', provider: 'codex', discoverySupported: true,
  capabilities: {
    resume: true, cancel: true, changeModel: true, changeMode: true,
    fork: true, retry: true, editHistory: true, listBranches: true, attachFiles: true,
  },
  models: [{ id: 'gpt-5', name: 'GPT-5', supportedReasoningLevels: [{ effort: 'medium' }, { effort: 'high' }] }],
  permissionModes: ['workspace-write', 'read-only'], sessions: [],
}

describe('session controls', () => {
  it('renders compact composer controls and emits an updated provider configuration', async () => {
    const wrapper = mount(SessionControls, { props: { session, capabilities, compact: true } })

    expect(wrapper.classes()).toContain('session-controls--compact')
    expect(wrapper.get('.session-control--provider').text()).toContain('codex')
    expect(wrapper.find('.session-control--reasoning').exists()).toBe(true)
    expect(wrapper.find('.session-control--permissions').exists()).toBe(true)

    await wrapper.get<HTMLSelectElement>('.session-control--reasoning select').setValue('high')
    expect(wrapper.emitted('save')?.at(-1)?.[0]).toMatchObject({
      model: 'gpt-5', mode: 'agent', config: { permissionMode: 'workspace-write', reasoningEffort: 'high' },
    })
  })

  it('renders a valid saving indicator', () => {
    const wrapper = mount(SessionControls, { props: { session, capabilities, saving: true } })
    expect(wrapper.get('.control-saving').text()).toBe('Saving…')
  })
})
