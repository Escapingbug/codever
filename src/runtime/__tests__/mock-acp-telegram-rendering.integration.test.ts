import { describe, it, expect, beforeEach } from 'vitest'
import { mapSessionUpdate } from '@/providers/acp/eventAdapter'
import { createProviderSemanticAdapter, type ProviderSemanticAdapter } from '../providerAdapter'
import { ChannelProjector } from '../channelProjector'
import type { ConversationEvent } from '../semantic'
import type { ChannelMessage } from '@/bridge/channelPort'

/**
 * Mock Telegram outbox that records send/edit operations
 * Simulates the deliver logic in SemanticSessionRuntime
 */
class MockTelegramOutbox {
    public sends: Array<{ message: ChannelMessage; toolUseId?: string }> = []
    public edits: Array<{ messageId: string | number; message: ChannelMessage }> = []
    private messageIdCounter = 0
    private toolMessageIds = new Map<string, string | number>()

    /** Simulate deliver logic from SemanticSessionRuntime */
    async deliver(message: ChannelMessage, toolUseId?: string, isToolEvent = false): Promise<void> {
        if (isToolEvent && toolUseId && this.toolMessageIds.has(toolUseId)) {
            // Edit existing message
            const existingMessageId = this.toolMessageIds.get(toolUseId)!
            this.edits.push({ messageId: existingMessageId, message })
            // Update message ID in case it changed
            const newMessageId = `msg-${++this.messageIdCounter}`
            this.toolMessageIds.set(toolUseId, newMessageId)
        } else {
            // Send new message
            const newMessageId = `msg-${++this.messageIdCounter}`
            this.sends.push({ message, toolUseId })
            if (isToolEvent && toolUseId) {
                this.toolMessageIds.set(toolUseId, newMessageId)
            }
        }
    }

    clear(): void {
        this.sends = []
        this.edits = []
        this.messageIdCounter = 0
        this.toolMessageIds.clear()
    }

    /** Get the last sent or edited text for a toolUseId */
    getLastTextForTool(toolUseId: string): string | null {
        // Check edits first (most recent)
        for (let i = this.edits.length - 1; i >= 0; i--) {
            const edit = this.edits[i]
            // Find which toolUseId this edit belongs to (approximate)
            if (this.toolMessageIds.get(toolUseId) === edit.messageId) {
                return edit.message.text
            }
        }
        // Check sends
        for (let i = this.sends.length - 1; i >= 0; i--) {
            const send = this.sends[i]
            if (send.toolUseId === toolUseId) {
                return send.message.text
            }
        }
        return null
    }
}

/**
 * Integration test: ACP SessionUpdate -> mapSessionUpdate -> ProviderSemanticAdapter -> ChannelProjector -> MockTelegramOutbox
 *
 * This test simulates the real rendering pipeline without actual Telegram/ACP connections.
 */
describe('Integration: ACP -> Semantic Adapter -> Projector -> Telegram Rendering', () => {
    let adapter: ProviderSemanticAdapter
    let projector: ChannelProjector
    let outbox: MockTelegramOutbox
    let turnId: string

    beforeEach(() => {
        adapter = createProviderSemanticAdapter('opencode' as any)
        projector = new ChannelProjector()
        outbox = new MockTelegramOutbox()
        turnId = 'test-turn-1'
    })

    /** Helper to convert ACP SessionUpdate to projected messages */
    async function processAcpUpdate(
        acpUpdate: any,
        context: { sessionId: string; turnId: string; provider: string },
    ): Promise<Array<{ text: string; isToolEvent: boolean; toolUseId?: string }>> {
        const agentEvents = mapSessionUpdate(acpUpdate as any)
        const results: Array<{ text: string; isToolEvent: boolean; toolUseId?: string }> = []

        for (const agentEvent of agentEvents) {
            const semanticEvents = adapter.toConversationEvents(agentEvent, context)
            for (const semanticEvent of semanticEvents) {
                const projectedMessages = projector.project(semanticEvent)
                for (const projected of projectedMessages) {
                    await outbox.deliver(projected.message, projected.toolUseId, projected.isToolEvent)
                    results.push({
                        text: projected.message.text,
                        isToolEvent: projected.isToolEvent,
                        toolUseId: projected.toolUseId,
                    })
                }
            }
        }

        return results
    }

    describe('Scenario A: Tool edit not overridden by path/JSON', () => {
        it('should send then edit tool message, preserving tool name and path without JSON dump', async () => {
            // Step 1: ACP tool_call - Read with filePath input
            const toolCallUpdate = {
                sessionUpdate: 'tool_call',
                toolCallId: 'call-1',
                title: 'Read',
                rawInput: JSON.stringify({ filePath: 'src/runtime/semanticSessionRuntime.ts' }),
                status: 'pending',
            }

            const results1 = await processAcpUpdate(toolCallUpdate, {
                sessionId: 'sess-1',
                turnId,
                provider: 'opencode',
            })

            // Should have 1 send (not edit)
            expect(outbox.sends.length).toBe(1)
            expect(outbox.edits.length).toBe(0)

            const firstMessage = outbox.sends[0].message.text
            expect(firstMessage).toContain('Read')
            expect(firstMessage).toContain('semanticSessionRuntime.ts')

            // Step 2: ACP tool_call_update - completed, title changed to path (ACF behavior)
            const toolCallUpdate2 = {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'call-1',
                title: 'src/runtime/semanticSessionRuntime.ts', // ACP sends path as title in update
                status: 'completed',
                rawOutput: 'file content here',
            }

            const results2 = await processAcpUpdate(toolCallUpdate2, {
                sessionId: 'sess-1',
                turnId,
                provider: 'opencode',
            })

            // Should have 1 edit (not another send)
            expect(outbox.edits.length).toBe(1)

            const editedMessage = outbox.edits[0].message.text

            // Key assertions:
            // 1. Should still contain "Read" (canonical tool name preserved)
            expect(editedMessage).toContain('Read')

            // 2. Should contain the path
            expect(editedMessage).toContain('semanticSessionRuntime.ts')

            // 3. Should NOT contain JSON dump of input ({ "filePath": ...)
            expect(editedMessage).not.toContain('<pre>{')
            expect(editedMessage).not.toContain('"filePath"')

            // 4. Should NOT contain the fallback pattern "🔧 src/runtime..." (path as tool name)
            expect(editedMessage).not.toMatch(/🔧\s*<b>src\/runtime/)
        })

        it('should handle Edit tool with path in displayTitle', async () => {
            // Step 1: tool_call with Edit
            const toolCallUpdate = {
                sessionUpdate: 'tool_call',
                toolCallId: 'call-2',
                title: 'Edit',
                rawInput: JSON.stringify({ filePath: 'src/runtime/channelProjector.ts' }),
                status: 'pending',
            }

            await processAcpUpdate(toolCallUpdate, {
                sessionId: 'sess-1',
                turnId,
                provider: 'opencode',
            })

            expect(outbox.sends.length).toBe(1)
            expect(outbox.sends[0].message.text).toContain('Edit')

            // Step 2: tool_call_update with path as title
            const toolCallUpdate2 = {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'call-2',
                title: 'src/runtime/channelProjector.ts',
                status: 'completed',
                rawOutput: 'edited successfully',
            }

            await processAcpUpdate(toolCallUpdate2, {
                sessionId: 'sess-1',
                turnId,
                provider: 'opencode',
            })

            expect(outbox.edits.length).toBe(1)
            const editedMessage = outbox.edits[0].message.text

            // Should preserve "Edit" tool name
            expect(editedMessage).toContain('Edit')

            // Should show path
            expect(editedMessage).toContain('channelProjector.ts')

            // Should not JSON dump
            expect(editedMessage).not.toContain('<pre>{')
        })

        it('should render Cursor ACP file tool parameters from locations when rawInput is absent', async () => {
            const readCall = {
                sessionUpdate: 'tool_call',
                toolCallId: 'call-cursor-read',
                title: 'Read',
                kind: 'read',
                status: 'pending',
                locations: [{ path: 'src/providers/acp/eventAdapter.ts' }],
            }

            await processAcpUpdate(readCall, {
                sessionId: 'sess-1',
                turnId,
                provider: 'agent',
            })

            expect(outbox.sends.length).toBe(1)
            const message = outbox.sends[0].message.text
            expect(message).toContain('Read')
            expect(message).toContain('src/providers/acp/eventAdapter.ts')
        })

        it('should render Cursor ACP file parameters when locations arrive in a later update', async () => {
            const readCall = {
                sessionUpdate: 'tool_call',
                toolCallId: 'call-cursor-read-late-location',
                title: 'Read',
                kind: 'read',
                status: 'pending',
                rawInput: {},
            }
            const readUpdate = {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'call-cursor-read-late-location',
                title: null,
                status: 'in_progress',
                locations: [{ path: 'src/runtime/channelProjector.ts' }],
            }

            await processAcpUpdate(readCall, {
                sessionId: 'sess-1',
                turnId,
                provider: 'agent',
            })
            await processAcpUpdate(readUpdate, {
                sessionId: 'sess-1',
                turnId,
                provider: 'agent',
            })

            expect(outbox.edits.length).toBe(1)
            const message = outbox.edits[0].message.text
            expect(message).toContain('Read')
            expect(message).toContain('src/runtime/channelProjector.ts')
        })

        it('should render Cursor ACP terminal command when rawInput arrives on completed update', async () => {
            const terminalCall = {
                sessionUpdate: 'tool_call',
                toolCallId: 'call-cursor-terminal',
                title: 'Terminal',
                kind: 'execute',
                status: 'pending',
            }
            const terminalDone = {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'call-cursor-terminal',
                title: 'Terminal',
                kind: 'execute',
                status: 'completed',
                rawInput: { command: 'npm run typecheck' },
                rawOutput: 'ok',
            }

            await processAcpUpdate(terminalCall, {
                sessionId: 'sess-1',
                turnId,
                provider: 'agent',
            })
            await processAcpUpdate(terminalDone, {
                sessionId: 'sess-1',
                turnId,
                provider: 'agent',
            })

            expect(outbox.edits.length).toBeGreaterThan(0)
            const message = outbox.edits[outbox.edits.length - 1].message.text
            expect(message).toContain('npm run typecheck')
            expect(message).not.toContain('<b>Terminal</b>')
        })

        it('should render Cursor ACP terminal string command when rawInput arrives in a later update', async () => {
            const terminalCall = {
                sessionUpdate: 'tool_call',
                toolCallId: 'call-cursor-terminal-string',
                title: 'Terminal',
                kind: 'execute',
                status: 'pending',
                rawInput: {},
            }
            const terminalUpdate = {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'call-cursor-terminal-string',
                title: null,
                status: 'in_progress',
                rawInput: 'npm test',
            }

            await processAcpUpdate(terminalCall, {
                sessionId: 'sess-1',
                turnId,
                provider: 'agent',
            })
            await processAcpUpdate(terminalUpdate, {
                sessionId: 'sess-1',
                turnId,
                provider: 'agent',
            })

            expect(outbox.edits.length).toBe(1)
            const message = outbox.edits[0].message.text
            expect(message).toContain('npm test')
            expect(message).not.toContain('<b>Terminal</b>')
        })

        it('should render Cursor ACP grep query when provider uses query field in a later update', async () => {
            const grepCall = {
                sessionUpdate: 'tool_call',
                toolCallId: 'call-cursor-grep-query',
                title: 'Grep',
                kind: 'search',
                status: 'pending',
                rawInput: {},
            }
            const grepUpdate = {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'call-cursor-grep-query',
                title: null,
                status: 'in_progress',
                rawInput: { query: 'normalizeToolInput' },
            }

            await processAcpUpdate(grepCall, {
                sessionId: 'sess-1',
                turnId,
                provider: 'agent',
            })
            await processAcpUpdate(grepUpdate, {
                sessionId: 'sess-1',
                turnId,
                provider: 'agent',
            })

            expect(outbox.edits.length).toBe(1)
            const message = outbox.edits[0].message.text
            expect(message).toContain('Grep')
            expect(message).toContain('normalizeToolInput')
        })
    })

    describe('Scenario B: Commands/plan not JSON dump', () => {
        it('should NOT send message for available_commands_update (suppressed)', async () => {
            // ACP available_commands_update as a tool_call (OpenCode behavior)
            const commandsUpdate = {
                sessionUpdate: 'available_commands_update',
                availableCommands: [
                    { name: 'status', description: 'Show status', input: { hint: 'no input' } },
                    { name: 'help', description: 'Show help', input: null },
                ],
            }

            outbox.clear()
            const results = await processAcpUpdate(commandsUpdate, {
                sessionId: 'sess-1',
                turnId,
                provider: 'opencode',
            })

            // Should NOT send any message (channelProjector returns [])
            expect(results.length).toBe(0)
            expect(outbox.sends.length).toBe(0)
        })

        it('should render plan as friendly text with content', async () => {
            // ACP plan update
            const planUpdate = {
                sessionUpdate: 'plan',
                content: '1. Do this\n2. Do that\n3. Done',
                title: 'Implementation Plan',
            }

            const results = await processAcpUpdate(planUpdate, {
                sessionId: 'sess-1',
                turnId,
                provider: 'opencode',
            })

            expect(results.length).toBe(1)
            const message = results[0].text

            // Should contain "Plan"
            expect(message).toContain('Plan')

            // Should contain the plan content
            expect(message).toContain('Do this')

            // Should NOT be a JSON dump
            expect(message).not.toContain('{"content"')
            expect(message).not.toContain('"sessionUpdate"')
        })

        it('should render plan with decision options as decision_request', async () => {
            // ACP plan update with options (decision request)
            const planUpdate = {
                sessionUpdate: 'plan',
                planId: 'plan-1',
                title: 'Implementation Plan',
                content: 'Please approve this plan',
                options: ['Approve', 'Reject'],
            }

            const results = await processAcpUpdate(planUpdate, {
                sessionId: 'sess-1',
                turnId,
                provider: 'opencode',
            })

            // Should render as decision request (with inline keyboard)
            expect(results.length).toBe(1)
            const message = results[0].text

            expect(message).toContain('Implementation Plan')
            expect(message).toContain('Please approve this plan')
        })

        it('should render ExitPlanMode plan content from Cursor-style completed output', async () => {
            const started = {
                sessionUpdate: 'tool_call',
                toolCallId: 'call-exit-plan',
                title: 'ExitPlanMode',
                rawInput: JSON.stringify({}),
                status: 'pending',
            }
            const completed = {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'call-exit-plan',
                title: 'ExitPlanMode',
                status: 'completed',
                rawOutput: JSON.stringify({
                    plan: '1. Trace Cursor provider events\n2. Include the concrete plan in the exit message',
                }),
            }

            await processAcpUpdate(started, {
                sessionId: 'sess-1',
                turnId,
                provider: 'agent',
            })
            await processAcpUpdate(completed, {
                sessionId: 'sess-1',
                turnId,
                provider: 'agent',
            })

            expect(outbox.edits.length).toBe(1)
            const message = outbox.edits[0].message.text
            expect(message).toContain('Plan')
            expect(message).toContain('Trace Cursor provider events')
            expect(message).toContain('Include the concrete plan')
            expect(message).not.toContain('Exited plan mode')
        })
    })

    describe('Scenario C: TodoWrite update preserves Tasks display', () => {
        it('should show Tasks/Todo on edit, not JSON', async () => {
            // Step 1: tool_call with TodoWrite and todos input
            const todoCall = {
                sessionUpdate: 'tool_call',
                toolCallId: 'call-3',
                title: 'TodoWrite',
                rawInput: JSON.stringify({
                    todos: [
                        { content: 'Task 1', status: 'in_progress' },
                        { content: 'Task 2', status: 'pending' },
                    ],
                }),
                status: 'pending',
            }

            await processAcpUpdate(todoCall, {
                sessionId: 'sess-1',
                turnId,
                provider: 'opencode',
            })

            expect(outbox.sends.length).toBe(1)
            const firstMessage = outbox.sends[0].message.text
            expect(firstMessage).toContain('Tasks')
            expect(firstMessage).toContain('Task 1')

            // Step 2: tool_call_update with completed status, title might be missing or same
            const todoUpdate = {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'call-3',
                title: 'TodoWrite', // or could be undefined
                status: 'completed',
                rawOutput: JSON.stringify({ success: true }),
            }

            await processAcpUpdate(todoUpdate, {
                sessionId: 'sess-1',
                turnId,
                provider: 'opencode',
            })

            expect(outbox.edits.length).toBe(1)
            const editedMessage = outbox.edits[0].message.text

            // Should still show "Tasks" or "Todo"
            expect(editedMessage).toContain('Tasks')

            // Should NOT JSON dump the output
            expect(editedMessage).not.toContain('<pre>{')
            expect(editedMessage).not.toContain('"success"')
        })

        it('should handle TodoWrite update with displayTitle instead of canonical name', async () => {
            // Some ACP implementations might send displayTitle instead of tool name in update
            const todoCall = {
                sessionUpdate: 'tool_call',
                toolCallId: 'call-4',
                title: 'TodoWrite',
                rawInput: JSON.stringify({
                    todos: [{ content: 'Write tests', status: 'in_progress' }],
                }),
                status: 'pending',
            }

            await processAcpUpdate(todoCall, {
                sessionId: 'sess-1',
                turnId,
                provider: 'opencode',
            })

            // Update with displayTitle (some ACP implementations do this)
            const todoUpdate = {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'call-4',
                title: 'TodoWrite', // Still TodoWrite, not generic
                status: 'completed',
            }

            await processAcpUpdate(todoUpdate, {
                sessionId: 'sess-1',
                turnId,
                provider: 'opencode',
            })

            const editedMessage = outbox.edits[0].message.text

            // Should show Tasks UI
            expect(editedMessage).toContain('Tasks')
            expect(editedMessage).not.toContain('🔧')
        })
    })

    describe('Additional: usage_update rendered friendly', () => {
        it('should render usage_update with token/cost info', async () => {
            const usageUpdate = {
                sessionUpdate: 'usage_update',
                inputTokens: 1000,
                outputTokens: 500,
                totalTokens: 1500,
                costUSD: 0.015,
            }

            const results = await processAcpUpdate(usageUpdate, {
                sessionId: 'sess-1',
                turnId,
                provider: 'opencode',
            })

            expect(results.length).toBe(1)
            const message = results[0].text

            expect(message).toContain('Usage')
            expect(message).toContain('1000')
            expect(message).toContain('500')
            expect(message).toContain('$0.015')

            // Should NOT be JSON dump
            expect(message).not.toContain('{"inputTokens"')
        })
    })

    describe('Edge case: tool_call_update with generic tool name should not override canonical', () => {
        it('should preserve Read tool name when update comes with path as title', async () => {
            // Initial tool_call with canonical name
            const toolCall = {
                sessionUpdate: 'tool_call',
                toolCallId: 'call-5',
                title: 'Read',
                rawInput: JSON.stringify({ filePath: 'src/main.ts' }),
                status: 'pending',
            }

            await processAcpUpdate(toolCall, {
                sessionId: 'sess-1',
                turnId,
                provider: 'opencode',
            })

            // Update with path as title (real ACP behavior)
            const toolUpdate = {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'call-5',
                title: 'src/main.ts', // Path as title in update
                status: 'in_progress',
                rawInput: JSON.stringify({ filePath: 'src/main.ts' }),
            }

            await processAcpUpdate(toolUpdate, {
                sessionId: 'sess-1',
                turnId,
                provider: 'opencode',
            })

            // Should have edited, not sent new
            expect(outbox.edits.length).toBe(1)
            const editedMessage = outbox.edits[0].message.text

            // Should still contain "Read", not JSON
            expect(editedMessage).toContain('Read')
            expect(editedMessage).not.toContain('<pre>{')
        })
    })

    describe('Issue 1: config_option_update renders [object Object]', () => {
        it('should not send message for config_option_update (suppressed by channelProjector)', async () => {
            const configUpdate = {
                sessionUpdate: 'config_option_update',
                configOptions: [
                    { name: 'maxTokens', value: 4096, description: 'Max tokens per request' },
                    { name: 'temperature', value: 0.7, description: 'Sampling temperature' },
                ],
            }

            outbox.clear()
            const results = await processAcpUpdate(configUpdate, {
                sessionId: 'sess-1',
                turnId,
                provider: 'opencode',
            })

            // Should NOT send any message (channelProjector returns [])
            expect(results.length).toBe(0)
            expect(outbox.sends.length).toBe(0)
            expect(outbox.edits.length).toBe(0)
        })

        it('should correctly render config options when formatCommandResult is called directly', () => {
            const projector = new ChannelProjector()

            // Simulate config_option_update event
            const event = {
                kind: 'command_result' as const,
                command: 'config_option_update',
                output: {
                    configOptions: [
                        { name: 'maxTokens', value: 4096, description: 'Max tokens' },
                        { name: 'temperature', value: 0.7 },
                    ],
                },
                meta: {
                    id: 'test-1',
                    sessionId: 'sess-1',
                    turnId: 'turn-1',
                    provider: 'opencode',
                    seq: 0,
                    timestamp: Date.now(),
                    sourcePhase: 'live' as const,
                },
            }

            const results = projector.project(event)
            // With our fix, config_option_update should return empty array
            expect(results.length).toBe(0)
        })

        it('should not render [object Object] when configOptions is an array', () => {
            // Test that config_option_update doesn't produce [object Object]
            // by calling project() and verifying no message is sent
            const projector = new ChannelProjector()

            const event = {
                kind: 'command_result' as const,
                command: 'config_option_update',
                output: {
                    configOptions: [
                        { name: 'maxTokens', value: 4096 },
                        { name: 'temperature', value: 0.7 },
                    ],
                },
                meta: {
                    id: 'test-1',
                    sessionId: 'sess-1',
                    turnId: 'turn-1',
                    provider: 'opencode',
                    seq: 0,
                    timestamp: Date.now(),
                    sourcePhase: 'live' as const,
                },
            }

            const results = projector.project(event)

            // Should return empty array (suppressed)
            expect(results.length).toBe(0)
        })
    })

    describe('Issue 2: available_commands_update and config_option_update should not notify user', () => {
        it('should not send message for available_commands_update (suppressed by channelProjector)', async () => {
            const commandsUpdate = {
                sessionUpdate: 'available_commands_update',
                availableCommands: [
                    { name: 'status', description: 'Show status', input: { hint: 'no input' } },
                    { name: 'help', description: 'Show help', input: null },
                ],
            }

            outbox.clear()
            const results = await processAcpUpdate(commandsUpdate, {
                sessionId: 'sess-1',
                turnId,
                provider: 'opencode',
            })

            // Should NOT send any message (channelProjector returns [])
            expect(results.length).toBe(0)
            expect(outbox.sends.length).toBe(0)
            expect(outbox.edits.length).toBe(0)
        })

        it('should suppress config_option_update in project method', async () => {
            const configUpdate = {
                sessionUpdate: 'config_option_update',
                configOptions: [
                    { name: 'model', value: 'gpt-4' },
                ],
            }

            outbox.clear()
            const results = await processAcpUpdate(configUpdate, {
                sessionId: 'sess-1',
                turnId,
                provider: 'opencode',
            })

            // Should NOT send any message
            expect(results.length).toBe(0)
            expect(outbox.sends.length).toBe(0)
        })

        it('should still render other command_result messages (e.g., plan)', async () => {
            const planUpdate = {
                sessionUpdate: 'plan',
                content: '1. Do this\n2. Do that',
            }

            outbox.clear()
            const results = await processAcpUpdate(planUpdate, {
                sessionId: 'sess-1',
                turnId,
                provider: 'opencode',
            })

            // Should still send message for plan
            expect(results.length).toBeGreaterThan(0)
            expect(outbox.sends.length).toBeGreaterThan(0)
        })
    })
})
