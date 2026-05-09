import { describe, expect, it } from 'vitest'
import { DefaultProviderSemanticAdapter } from '@/runtime/providerAdapter'
import type { AgentEvent } from '@/providers/types'

describe('DefaultProviderSemanticAdapter', () => {
    it('maps provider text into assistant text deltas', () => {
        const adapter = new DefaultProviderSemanticAdapter('test-provider')

        const events = adapter.toConversationEvents(
            { kind: 'text', text: 'hello' },
            { sessionId: 's1', turnId: 't1', provider: 'test-provider' },
        )

        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
            kind: 'assistant_text_delta',
            text: 'hello',
            meta: {
                sessionId: 's1',
                turnId: 't1',
                provider: 'test-provider',
                sourcePhase: 'live',
            },
        })
    })

    it('maps tool lifecycle events into canonical tool events', () => {
        const adapter = new DefaultProviderSemanticAdapter('test-provider')
        const toolUse: AgentEvent = {
            kind: 'tool_use',
            toolUseId: 'tool-1',
            toolName: 'Bash',
            status: 'running',
            input: { command: 'npm test' },
        }
        const toolResult: AgentEvent = {
            kind: 'tool_result',
            toolUseId: 'tool-1',
            toolName: 'Bash',
            output: 'ok',
            isError: false,
        }

        const started = adapter.toConversationEvents(toolUse, { sessionId: 's1', turnId: 't1', provider: 'test-provider' })
        const completed = adapter.toConversationEvents(toolResult, { sessionId: 's1', turnId: 't1', provider: 'test-provider' })

        expect(started[0]).toMatchObject({
            kind: 'tool',
            phase: 'updated',
            toolCallId: 'tool-1',
            toolName: 'Bash',
            category: 'execute',
        })
        expect(completed[0]).toMatchObject({
            kind: 'tool',
            phase: 'completed',
            toolCallId: 'tool-1',
            output: 'ok',
            isError: false,
        })
    })

    it('uses one stable final event id per turn result', () => {
        const adapter = new DefaultProviderSemanticAdapter('test-provider')
        const context = { sessionId: 's1', turnId: 't1', provider: 'test-provider' }

        const first = adapter.toConversationEvents({ kind: 'result', status: 'success' }, context)
        const second = adapter.toConversationEvents({ kind: 'result', status: 'success' }, context)

        expect(first[0].meta.id).toBe('t1:result')
        expect(second[0].meta.id).toBe('t1:result')
    })
})
