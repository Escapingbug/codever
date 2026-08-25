import { describe, expect, it } from 'vitest'
import { DefaultProviderSemanticAdapter } from '@/runtime/providerAdapter'
import type { AgentEvent } from '@/providers/types'
import { mapSessionUpdate } from '@/providers/acp/eventAdapter'
import { ChannelProjector } from '@/runtime/channelProjector'

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
            messageId: 't1:assistant-message:1',
            meta: {
                sessionId: 's1',
                turnId: 't1',
                provider: 'test-provider',
                sourcePhase: 'live',
            },
        })
    })

    it('preserves provider message identity and creates a new fallback block after tools', () => {
        const adapter = new DefaultProviderSemanticAdapter('test-provider')
        const context = { sessionId: 's1', turnId: 't1', provider: 'test-provider' }

        const explicit = adapter.toConversationEvents(
            { kind: 'text', text: 'one', messageId: 'provider-message-1' },
            context,
        )[0]
        const firstAnonymous = adapter.toConversationEvents(
            { kind: 'text', text: 'two' },
            context,
        )[0]
        const secondAnonymous = adapter.toConversationEvents(
            { kind: 'text', text: 'three' },
            context,
        )[0]
        adapter.toConversationEvents({
            kind: 'tool_use',
            toolUseId: 'tool-1',
            toolName: 'Read',
            input: { path: 'README.md' },
        }, context)
        const afterTool = adapter.toConversationEvents(
            { kind: 'text', text: 'four' },
            context,
        )[0]
        const nextTurn = adapter.toConversationEvents(
            { kind: 'text', text: 'five' },
            { ...context, turnId: 't2' },
        )[0]

        expect(explicit).toMatchObject({ messageId: 'provider-message-1' })
        expect(firstAnonymous).toMatchObject({ messageId: 't1:assistant-message:1' })
        expect(secondAnonymous).toMatchObject({ messageId: 't1:assistant-message:1' })
        expect(afterTool).toMatchObject({ messageId: 't1:assistant-message:2' })
        expect(nextTurn).toMatchObject({ messageId: 't2:assistant-message:3' })
    })

    it('keeps the ACP message id on live text chunks', () => {
        const events = mapSessionUpdate({
            sessionUpdate: 'agent_message_chunk',
            messageId: '018f4f65-99d1-7f39-b4ef-31f676531abc',
            content: { type: 'text', text: 'delta' },
        } as Parameters<typeof mapSessionUpdate>[0])

        expect(events).toEqual([
            {
                kind: 'text',
                text: 'delta',
                messageId: '018f4f65-99d1-7f39-b4ef-31f676531abc',
            },
        ])
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

describe('ChannelProjector durable tool snapshots', () => {
    it('emits the cumulative tool group once at the turn boundary', () => {
        const projector = new ChannelProjector()
        const meta = {
            id: 'tool-1',
            sessionId: 'session-1',
            turnId: 'turn-1',
            provider: 'test',
            seq: 1,
            timestamp: 1,
            sourcePhase: 'live' as const,
        }
        projector.project({
            kind: 'tool',
            meta,
            phase: 'completed',
            toolCallId: 'tool-1',
            toolName: 'Bash',
            category: 'execute',
            input: { command: 'pnpm test' },
            output: 'complete output',
        }, { preserveNormalToolGroup: true })

        const terminal = projector.project({
            kind: 'turn_finished',
            meta: { ...meta, id: 'turn-1:result', seq: 2, timestamp: 2 },
            status: 'success',
        }, { preserveNormalToolGroup: true })

        expect(terminal).toHaveLength(1)
        expect(terminal[0]).toMatchObject({
            toolUseId: 'normal-tool-group:1',
            isToolEvent: true,
            isTerminal: true,
            isFinalToolSnapshot: true,
            message: {
                presentation: {
                    kind: 'tool_group',
                    tools: [{ id: 'tool-1', result: 'complete output' }],
                },
            },
        })
    })
})
