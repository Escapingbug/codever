import { describe, it, expect, beforeEach } from 'vitest'
import { ChannelProjector } from '../channelProjector'
import type { ConversationEvent } from '../semantic'

function makeToolEvent(overrides: Partial<Extract<ConversationEvent, { kind: 'tool' }>> & { toolCallId: string; phase: 'started' | 'updated' | 'completed' | 'failed' }): Extract<ConversationEvent, { kind: 'tool' }> {
    return {
        kind: 'tool',
        toolName: 'tool_call',
        category: 'unknown',
        meta: makeMeta('default'),
        ...overrides,
    }
}

function makeMeta(toolCallId: string): Extract<ConversationEvent, { kind: 'tool' }>['meta'] {
    return {
        id: `turn-1:tool:${toolCallId}:1`,
        sessionId: 'sess-1',
        turnId: 'turn-1',
        provider: 'acp',
        seq: 1,
        timestamp: Date.now(),
        sourcePhase: 'live',
    }
}

describe('ChannelProjector — patch merge', () => {
    let projector: ChannelProjector

    beforeEach(() => {
        projector = new ChannelProjector()
    })

    it('preserves canonical toolName from started event when completed comes with generic name', () => {
        // started: toolName=Read, displayTitle undefined
        const started = makeToolEvent({
            toolCallId: 'c1',
            phase: 'started',
            toolName: 'Read',
            input: { file_path: '/src/foo.ts' },
            meta: makeMeta('c1'),
        })

        // completed: toolName=tool_call (generic), displayTitle=/src/foo.ts
        const completed = makeToolEvent({
            toolCallId: 'c1',
            phase: 'completed',
            toolName: 'tool_call',
            displayTitle: '/src/foo.ts',
            output: 'file content here',
            meta: makeMeta('c1'),
        })

        const result1 = projector.project(started)
        const result2 = projector.project(completed)

        // The final rendered message should contain "Read", not "tool_call" or "/src/foo.ts" as tool name
        const finalMessage = result2[0]?.message.text || ''
        expect(finalMessage).toContain('Read')
        expect(finalMessage).not.toContain('tool_call')
        expect(finalMessage).not.toContain('<pre>{')
    })

    it('uses displayTitle for path display when available', () => {
        const event = makeToolEvent({
            toolCallId: 'c2',
            phase: 'started',
            toolName: 'Read',
            displayTitle: '/src/bar.ts',
            input: { file_path: '/src/bar.ts' },
            meta: makeMeta('c2'),
        })

        const result = projector.project(event)
        const message = result[0]?.message.text || ''
        expect(message).toContain('/src/bar.ts')
    })

    it('does not replace canonical toolName with displayTitle', () => {
        const started = makeToolEvent({
            toolCallId: 'c3',
            phase: 'started',
            toolName: 'Edit',
            input: { file_path: '/src/baz.ts' },
            meta: makeMeta('c3'),
        })

        const updated = makeToolEvent({
            toolCallId: 'c3',
            phase: 'updated',
            toolName: 'tool_call',  // generic name in update
            displayTitle: '/src/baz.ts',
            meta: makeMeta('c3'),
        })

        projector.project(started)
        const result = projector.project(updated)
        const message = result[0]?.message.text || ''
        expect(message).toContain('Edit')
    })
})

describe('ChannelProjector — command_result friendly rendering', () => {
    let projector: ChannelProjector

    beforeEach(() => {
        projector = new ChannelProjector()
    })

    it('suppresses available_commands_update message (no send to user)', () => {
        const event: Extract<ConversationEvent, { kind: 'command_result' }> = {
            kind: 'command_result',
            command: 'available_commands_update',
            output: [
                { name: 'status', description: 'Show status', input: { hint: 'no input' } },
                { name: 'help', description: 'Show help', input: null },
            ],
            meta: {
                id: 'cmd-1',
                sessionId: 'sess-1',
                turnId: 'turn-1',
                provider: 'acp',
                seq: 1,
                timestamp: Date.now(),
                sourcePhase: 'live',
            },
        }

        const result = projector.project(event)

        // Should return empty array (suppressed)
        expect(result).toHaveLength(0)
    })

    it('renders plan command_result with content', () => {
        const event: Extract<ConversationEvent, { kind: 'command_result' }> = {
            kind: 'command_result',
            command: 'plan',
            output: {
                content: '1. Do this\n2. Do that\n3. Done',
                title: 'Implementation Plan',
            },
            meta: {
                id: 'cmd-2',
                sessionId: 'sess-1',
                turnId: 'turn-1',
                provider: 'acp',
                seq: 2,
                timestamp: Date.now(),
                sourcePhase: 'live',
            },
        }

        const result = projector.project(event)
        const message = result[0]?.message.text || ''

        expect(message).toContain('Plan')
        expect(message).toContain('Do this')
    })

    it('renders usage_update with token/cost info', () => {
        const event: Extract<ConversationEvent, { kind: 'command_result' }> = {
            kind: 'command_result',
            command: 'usage_update',
            output: {
                inputTokens: 1000,
                outputTokens: 500,
                totalTokens: 1500,
                costUSD: 0.015,
            },
            meta: {
                id: 'cmd-3',
                sessionId: 'sess-1',
                turnId: 'turn-1',
                provider: 'acp',
                seq: 3,
                timestamp: Date.now(),
                sourcePhase: 'live',
            },
        }

        const result = projector.project(event)
        const message = result[0]?.message.text || ''

        expect(message).toContain('Usage')
        expect(message).toContain('1000')
        expect(message).toContain('500')
        expect(message).toContain('$0.015')
    })

    it('renders usage_update snake_case token/cost fields', () => {
        const event: Extract<ConversationEvent, { kind: 'command_result' }> = {
            kind: 'command_result',
            command: 'usage_update',
            output: {
                input_tokens: 11,
                output_tokens: 22,
                total_tokens: 33,
                cost_usd: 0.004,
            },
            meta: {
                id: 'cmd-4',
                sessionId: 'sess-1',
                turnId: 'turn-1',
                provider: 'acp',
                seq: 4,
                timestamp: Date.now(),
                sourcePhase: 'live',
            },
        }

        const result = projector.project(event)
        const message = result[0]?.message.text || ''

        expect(message).toContain('Usage')
        expect(message).toContain('11')
        expect(message).toContain('22')
        expect(message).toContain('$0.004')
    })
})
