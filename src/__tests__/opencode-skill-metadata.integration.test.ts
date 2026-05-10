import { describe, expect, it } from 'vitest'
import { mapSessionUpdate } from '@/providers/acp/eventAdapter'
import { DefaultProviderSemanticAdapter } from '@/runtime/providerAdapter'
import { ChannelProjector } from '@/runtime/channelProjector'

describe('opencode Skill metadata rendering - full integration', () => {
    it('renders Skill metadata as key-value pairs, not raw JSON', () => {
        const adapter = new DefaultProviderSemanticAdapter('opencode')
        const context = { sessionId: 's1', turnId: 't1', provider: 'opencode' }
        const projector = new ChannelProjector()

        // ============================================
        // Phase 1: ACP tool_call initial event (pending)
        // ============================================
        const toolCallStart = {
            sessionUpdate: 'tool_call' as const,
            toolCallId: 'skill-1',
            title: 'skill',
            kind: 'other' as const,
            status: 'pending' as const,
            locations: [],
            rawInput: { name: 'loca' }
        }

        // Step 1: mapSessionUpdate (eventAdapter.ts)
        const agentEvents1 = mapSessionUpdate(toolCallStart)
        expect(agentEvents1).toHaveLength(1)
        expect(agentEvents1[0].kind).toBe('tool_use')

        // Step 2: DefaultProviderSemanticAdapter.toConversationEvents (providerAdapter.ts)
        const convEvents1 = adapter.toConversationEvents(agentEvents1[0], context)
        expect(convEvents1).toHaveLength(1)
        expect(convEvents1[0].kind).toBe('tool')

        // Step 3: ChannelProjector.project (channelProjector.ts)
        const projected1 = projector.project(convEvents1[0])
        expect(projected1).toHaveLength(1)

        const html1 = projected1[0].message.text
        expect(html1).toContain('Skill')
        expect(html1).toContain('loca')

        // ============================================
        // Phase 2: ACP tool_call_update completed event
        // ============================================
        const toolCallCompleted = {
            sessionUpdate: 'tool_call_update' as const,
            toolCallId: 'skill-1',
            status: 'completed' as const,
            title: 'Loaded skill: loca',
            kind: 'other' as const,
            rawInput: { name: 'loca' },
            rawOutput: {
                output: [],
                metadata: { name: 'loca', dir: '/tmp/loca' }
            },
            content: []
        }

        // Step 1: mapSessionUpdate (eventAdapter.ts)
        const agentEvents2 = mapSessionUpdate(toolCallCompleted)
        expect(agentEvents2).toHaveLength(1)
        expect(agentEvents2[0].kind).toBe('tool_result')

        // Verify that extractToolOutput correctly formats metadata
        const toolResultEvent = agentEvents2[0] as Extract<typeof agentEvents2[0], { kind: 'tool_result' }>
        expect(toolResultEvent.output).toBe('name: loca\ndir: /tmp/loca')

        // Step 2: DefaultProviderSemanticAdapter.toConversationEvents (providerAdapter.ts)
        const convEvents2 = adapter.toConversationEvents(agentEvents2[0], context)
        expect(convEvents2).toHaveLength(1)
        expect(convEvents2[0].kind).toBe('tool')

        const toolEvent = convEvents2[0] as Extract<typeof convEvents2[0], { kind: 'tool' }>
        expect(toolEvent.phase).toBe('completed')
        expect(toolEvent.output).toBe('name: loca\ndir: /tmp/loca')

        // Step 3: ChannelProjector.project (channelProjector.ts) with verboseLevel 2
        // verboseLevel 2 is needed to include tool output in the rendered HTML
        const projected2 = projector.project(toolEvent, { verboseLevel: 2 })
        expect(projected2).toHaveLength(1)

        const html2 = projected2[0].message.text

        // ============================================
        // Assertions: metadata rendered as key-value
        // ============================================
        expect(html2).toContain('name: loca')
        expect(html2).toContain('dir: /tmp/loca')

        // Should NOT contain raw JSON wrappers
        expect(html2).not.toContain('"metadata"')
        expect(html2).not.toContain('"output"')
        expect(html2).not.toContain('"output":[]')
        expect(html2).not.toContain('{"output"')

        // Verify the output is rendered as formatted text, not JSON
        expect(html2).toMatch(/name: loca/)
        expect(html2).toMatch(/dir: \/tmp\/loca/)
    })

    it('handles Skill tool with empty metadata gracefully', () => {
        const adapter = new DefaultProviderSemanticAdapter('opencode')
        const context = { sessionId: 's1', turnId: 't1', provider: 'opencode' }

        const toolCallCompleted = {
            sessionUpdate: 'tool_call_update' as const,
            toolCallId: 'skill-2',
            status: 'completed' as const,
            title: 'Loaded skill: empty',
            kind: 'other' as const,
            rawInput: { name: 'empty-skill' },
            rawOutput: {
                output: [],
                metadata: {}
            },
            content: []
        }

        const agentEvents = mapSessionUpdate(toolCallCompleted)
        expect(agentEvents).toHaveLength(1)

        const convEvents = adapter.toConversationEvents(agentEvents[0], context)
        expect(convEvents).toHaveLength(1)

        const toolEvent = convEvents[0] as Extract<typeof convEvents[0], { kind: 'tool' }>
        // With empty metadata, formatMetadata returns empty string
        expect(toolEvent.output).toBe('')
    })

    it('handles Skill tool with output array containing text and metadata', () => {
        const adapter = new DefaultProviderSemanticAdapter('opencode')
        const context = { sessionId: 's1', turnId: 't1', provider: 'opencode' }

        const toolCallCompleted = {
            sessionUpdate: 'tool_call_update' as const,
            toolCallId: 'skill-3',
            status: 'completed' as const,
            title: 'Loaded skill: with-output',
            kind: 'other' as const,
            rawInput: { name: 'with-output' },
            rawOutput: {
                output: ['some output text'],
                metadata: { name: 'with-output', version: '1.0' }
            },
            content: []
        }

        const agentEvents = mapSessionUpdate(toolCallCompleted)
        expect(agentEvents).toHaveLength(1)

        const toolResultEvent = agentEvents[0] as Extract<typeof agentEvents[0], { kind: 'tool_result' }>
        // When metadata exists, formatMetadata takes precedence over output array
        expect(toolResultEvent.output).toBe('name: with-output\nversion: 1.0')
    })

    it('handles Skill tool with only output array (no metadata)', () => {
        const adapter = new DefaultProviderSemanticAdapter('opencode')
        const context = { sessionId: 's1', turnId: 't1', provider: 'opencode' }

        const toolCallCompleted = {
            sessionUpdate: 'tool_call_update' as const,
            toolCallId: 'skill-4',
            status: 'completed' as const,
            title: 'Loaded skill: no-metadata',
            kind: 'other' as const,
            rawInput: { name: 'no-metadata' },
            rawOutput: {
                output: ['some output text']
            },
            content: []
        }

        const agentEvents = mapSessionUpdate(toolCallCompleted)
        expect(agentEvents).toHaveLength(1)

        const toolResultEvent = agentEvents[0] as Extract<typeof agentEvents[0], { kind: 'tool_result' }>
        // When no metadata and output is array, falls back to JSON.stringify of rawOutput
        expect(toolResultEvent.output).toBe('{"output":["some output text"]}')
    })
})
