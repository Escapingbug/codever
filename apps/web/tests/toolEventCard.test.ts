// @vitest-environment jsdom
import type { SessionEventEnvelope } from '@codever/protocol'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { codeverApiKey, type CodeverApi } from '../src/api/codeverApi'
import ToolEventCard from '../src/components/timeline/ToolEventCard.vue'
import { buildTimeline, type ToolTimelineEntry } from '../src/timeline/model'

const envelope = (sizeBytes?: number): SessionEventEnvelope => ({
  schemaVersion: 1, gatewayId: 'gateway-1', projectId: 'project-1', sessionId: 'session-1',
  seq: 1, eventId: 'event-1', timestamp: '2026-07-20T00:00:00.000Z',
  event: {
    kind: 'tool', phase: 'completed', toolCallId: 'tool-1', toolName: 'Bash', category: 'execute',
    ...(sizeBytes === undefined ? {} : { outputRef: {
      outputId: 'output-1', sizeBytes, sha256: 'a'.repeat(64), mediaType: 'application/json' as const,
    } }),
  },
})

function entry(sizeBytes?: number): ToolTimelineEntry {
  return buildTimeline([envelope(sizeBytes)])[0] as ToolTimelineEntry
}

describe('ToolEventCard retained output', () => {
  it('does not fetch output merely by rendering or expanding a tool event', async () => {
    const downloadToolOutput = vi.fn()
    const wrapper = mount(ToolEventCard, {
      props: { entry: entry(100), sessionId: 'session-1' },
      global: { provide: { [codeverApiKey as symbol]: { downloadToolOutput } as unknown as CodeverApi } },
    })
    expect(downloadToolOutput).not.toHaveBeenCalled()
    await wrapper.get('.tool-summary').trigger('click')
    expect(downloadToolOutput).not.toHaveBeenCalled()
  })

  it('loads a small result only after the user chooses View result', async () => {
    const downloadToolOutput = vi.fn().mockResolvedValue({ text: () => Promise.resolve('{"ok":true}') })
    const wrapper = mount(ToolEventCard, {
      props: { entry: entry(100), sessionId: 'session-1' },
      global: { provide: { [codeverApiKey as symbol]: { downloadToolOutput } as unknown as CodeverApi } },
    })
    await wrapper.get('.tool-summary').trigger('click')
    await wrapper.get('.tool-output-actions button').trigger('click')
    await vi.waitFor(() => expect(downloadToolOutput).toHaveBeenCalledOnce())
    expect(wrapper.get('.tool-output-preview').text()).toContain('"ok": true')
  })

  it('requires an explicit download decision for large results', async () => {
    const downloadToolOutput = vi.fn()
    vi.stubGlobal('confirm', vi.fn(() => false))
    const wrapper = mount(ToolEventCard, {
      props: { entry: entry(4 * 1024 * 1024), sessionId: 'session-1' },
      global: { provide: { [codeverApiKey as symbol]: { downloadToolOutput } as unknown as CodeverApi } },
    })
    await wrapper.get('.tool-summary').trigger('click')
    expect(wrapper.text()).toContain('This result is large')
    await wrapper.get('.tool-output-actions button').trigger('click')
    expect(downloadToolOutput).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
