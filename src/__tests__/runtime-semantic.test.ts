import { describe, expect, it } from 'vitest'
import { createProviderSemanticAdapter, DefaultProviderSemanticAdapter } from '@/runtime/providerAdapter'
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

describe('ACP provider semantics', () => {
    const context = { sessionId: 's1', turnId: 't1', provider: 'codebuddy' }

    it('maps standard session info fields into silent session metadata', () => {
        const adapter = createProviderSemanticAdapter('acp')
        const events = adapter.toConversationEvents({
            kind: 'raw',
            providerName: 'acp',
            rawMessage: {
                sessionUpdate: 'session_info_update',
                title: 'Investigate authentication timeout',
                updatedAt: '2026-08-25T10:00:00Z',
                _meta: { projectName: 'api-server' },
            },
        }, { ...context, provider: 'acp' })

        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
            kind: 'session_metadata_update',
            title: 'Investigate authentication timeout',
            updatedAt: '2026-08-25T10:00:00Z',
            providerMeta: { projectName: 'api-server' },
        })
    })

    it('normalizes CodeBuddy team metadata into a team state update', () => {
        const adapter = createProviderSemanticAdapter('codebuddy')
        const events = adapter.toConversationEvents({
            kind: 'raw',
            providerName: 'acp',
            rawMessage: {
                sessionUpdate: 'session_info_update',
                _meta: {
                    'codebuddy.ai/teamUpdate': {
                        type: 'member_status_change',
                        teamName: 'security-review',
                        isAutoTeam: true,
                        members: [{
                            name: 'researcher',
                            description: 'Analyze the attack surface',
                            status: 'running',
                            taskId: 'task-1',
                            sessionId: 'member-session-1',
                            tokenUsage: {
                                inputTokens: 1000,
                                outputTokens: 500,
                                lastContextWindow: 42000,
                            },
                            toolCallCount: 5,
                        }],
                    },
                },
            },
        }, context)

        expect(events.map(event => event.kind)).toEqual([
            'session_metadata_update',
            'team_state_update',
        ])
        expect(events[1]).toMatchObject({
            kind: 'team_state_update',
            action: 'member_status_change',
            teamName: 'security-review',
            isAutoTeam: true,
            members: [{
                name: 'researcher',
                status: 'running',
                taskId: 'task-1',
                sessionId: 'member-session-1',
                tokenUsage: {
                    inputTokens: 1000,
                    outputTokens: 500,
                    lastContextWindow: 42000,
                },
                toolCallCount: 5,
            }],
        })
        expect(events[0].meta.id).not.toBe(events[1].meta.id)
    })

    it('keeps malformed CodeBuddy team metadata silent without inventing a team', () => {
        const adapter = createProviderSemanticAdapter('codebuddy')
        const events = adapter.toConversationEvents({
            kind: 'raw',
            providerName: 'acp',
            rawMessage: {
                sessionUpdate: 'session_info_update',
                _meta: {
                    'codebuddy.ai/teamUpdate': {
                        type: 'member_status_change',
                        members: [{ status: 'running' }],
                    },
                },
            },
        }, context)

        expect(events.map(event => event.kind)).toEqual(['session_metadata_update'])
    })

    it('suppresses only known empty CodeBuddy housekeeping tool calls', () => {
        const adapter = createProviderSemanticAdapter('codebuddy')
        const started = adapter.toConversationEvents({
            kind: 'tool_use',
            toolName: 'tool_call',
            toolUseId: 'status-1',
            input: undefined,
            displayTitle: 'Static Update',
            status: 'running',
        }, context)
        const completed = adapter.toConversationEvents({
            kind: 'tool_result',
            toolUseId: 'status-1',
            output: '',
            isError: false,
        }, context)
        const realTool = adapter.toConversationEvents({
            kind: 'tool_use',
            toolName: 'tool_call',
            toolUseId: 'real-1',
            input: undefined,
            displayTitle: 'Deploy application',
            status: 'running',
        }, context)

        expect(started[0]).toMatchObject({ kind: 'provider_raw' })
        expect(completed[0]).toMatchObject({ kind: 'provider_raw' })
        expect(realTool[0]).toMatchObject({
            kind: 'tool',
            displayTitle: 'Deploy application',
        })
    })
})
