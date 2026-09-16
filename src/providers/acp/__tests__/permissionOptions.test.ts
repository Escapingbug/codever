import { describe, expect, it, vi } from 'vitest'
import { AcpClientManager } from '../AcpClientManager'

describe('ACP provider-defined permission options', () => {
    it('passes provider choices to the runtime and returns the exact selected option id', async () => {
        const manager = new AcpClientManager({ command: 'unused', args: [] })
        const handleToolCall = vi.fn(async () => ({
            behavior: 'allow' as const,
            optionId: 'q0_opt_1',
        }))
        manager.setPermissionHandler({
            handleToolCall,
            reset: vi.fn(),
        })

        const client = (manager as any).createClientHandler()
        const result = await client.requestPermission({
            sessionId: 'session-1',
            toolCall: {
                toolCallId: 'question-1',
                title: 'AskUserQuestion',
                rawInput: { question: 'Choose a database' },
            },
            options: [
                { optionId: 'q0_opt_0', name: 'PostgreSQL', kind: 'allow_once' },
                { optionId: 'q0_opt_1', name: 'MongoDB', kind: 'allow_once' },
                { optionId: 'q0_skip', name: 'Skip', kind: 'reject_once' },
            ],
        })

        expect(handleToolCall).toHaveBeenCalledWith(
            'AskUserQuestion',
            { question: 'Choose a database' },
            expect.objectContaining({
                permissionOptions: [
                    { optionId: 'q0_opt_0', name: 'PostgreSQL', kind: 'allow_once' },
                    { optionId: 'q0_opt_1', name: 'MongoDB', kind: 'allow_once' },
                    { optionId: 'q0_skip', name: 'Skip', kind: 'reject_once' },
                ],
            }),
        )
        expect(result).toEqual({
            outcome: {
                outcome: 'selected',
                optionId: 'q0_opt_1',
            },
        })
    })

    it('retains permission display content from an earlier tool update when raw input does not contain the plan', async () => {
        const manager = new AcpClientManager({ command: 'unused', args: [] })
        const handleToolCall = vi.fn(async () => ({ behavior: 'allow' as const }))
        manager.setPermissionHandler({ handleToolCall, reset: vi.fn() })

        const client = (manager as any).createClientHandler()
        await client.sessionUpdate({
            sessionId: 'session-1',
            update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'exit-plan-1',
                title: 'ExitPlanMode',
                status: 'pending',
                content: [{
                    type: 'content',
                    content: { type: 'text', text: '# Plan\n1. Inspect\n2. Implement' },
                }],
            },
        })
        await client.requestPermission({
            sessionId: 'session-1',
            toolCall: {
                toolCallId: 'exit-plan-1',
                title: 'ExitPlanMode',
                rawInput: {},
            },
            options: [
                { optionId: 'approve', name: 'Approve', kind: 'allow_once' },
                { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            ],
        })

        expect(handleToolCall).toHaveBeenCalledWith(
            'ExitPlanMode',
            {},
            expect.objectContaining({
                toolCallContent: [{
                    type: 'content',
                    content: { type: 'text', text: '# Plan\n1. Inspect\n2. Implement' },
                }],
            }),
        )
    })
})
