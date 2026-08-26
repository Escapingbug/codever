import { describe, expect, it, vi } from 'vitest'
import { AcpClientManager } from '@/providers/acp/AcpClientManager'
import { mapSessionUpdate } from '@/providers/acp/eventAdapter'
import {
    addCodebuddyAnswersToPermissionResponse,
    parseCodebuddyAskUserQuestion,
    resolveCodebuddyPermissionToolName,
} from '../askUserQuestion'

describe('CodeBuddy AskUserQuestion ACP bridge', () => {
    it('parses the documented question schema', () => {
        const parsed = parseCodebuddyAskUserQuestion('AskUserQuestion', {
            questions: [{
                header: 'Database',
                question: 'Which database should we use?',
                options: [
                    { label: 'PostgreSQL', description: 'Relational database' },
                    { label: 'MongoDB', description: 'Document database' },
                ],
                multiSelect: false,
            }],
        })

        expect(parsed?.questions).toEqual([{
            header: 'Database',
            question: 'Which database should we use?',
            options: [
                { label: 'PostgreSQL', description: 'Relational database' },
                { label: 'MongoDB', description: 'Document database' },
            ],
            multiSelect: false,
        }])
    })

    it('reads the real tool name from CodeBuddy ACP metadata', () => {
        expect(resolveCodebuddyPermissionToolName({
            toolCallId: 'q-1',
            _meta: { 'codebuddy.ai/toolName': 'AskUserQuestion' },
        })).toBe('AskUserQuestion')
    })

    it('normalizes AskUserQuestion tool calls without discarding raw questions', () => {
        const events = mapSessionUpdate({
            sessionUpdate: 'tool_call',
            toolCallId: 'q-1',
            title: 'AskUserQuestion',
            status: 'in_progress',
            rawInput: {
                questions: [{
                    header: 'Database',
                    question: 'Which database?',
                    options: [{ label: 'PostgreSQL' }, { label: 'MongoDB' }],
                    multiSelect: false,
                }],
            },
        })

        expect(events[0]).toMatchObject({
            kind: 'tool_use',
            toolName: 'AskUserQuestion',
            input: { questions: expect.any(Array) },
        })
    })

    it('adds collected answers to the CodeBuddy permission response', () => {
        const response = addCodebuddyAnswersToPermissionResponse(
            { outcome: { outcome: 'selected', optionId: 'proceed_once' } },
            {
                behavior: 'allow',
                updatedInput: {
                    questions: [],
                    answers: { 'Which database?': 'PostgreSQL' },
                },
            },
        ) as unknown as Record<string, unknown>

        expect(response.answers).toEqual({ 'Which database?': 'PostgreSQL' })
    })

    it('recovers rawInput and tool name from the preceding tool update', async () => {
        const permissionHandler = {
            handleToolCall: vi.fn(async (_toolName: string, input: unknown) => ({
                behavior: 'allow' as const,
                updatedInput: {
                    ...(input as Record<string, unknown>),
                    answers: { 'Which database?': 'PostgreSQL' },
                },
            })),
            reset: vi.fn(),
        }
        const manager = new AcpClientManager({
            command: 'unused',
            args: [],
            resolvePermissionToolName: resolveCodebuddyPermissionToolName,
            mapPermissionResponse: addCodebuddyAnswersToPermissionResponse,
        })
        manager.setPermissionHandler(permissionHandler)

        const client = (manager as any).createClientHandler()
        await client.sessionUpdate({
            sessionId: 'session-1',
            update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'question-1',
                title: 'Ask user question',
                status: 'in_progress',
                rawInput: {
                    questions: [{
                        question: 'Which database?',
                        header: 'Database',
                        options: [{ label: 'PostgreSQL' }, { label: 'MongoDB' }],
                        multiSelect: false,
                    }],
                },
                _meta: { 'codebuddy.ai/toolName': 'AskUserQuestion' },
            },
        })

        const response = await client.requestPermission({
            sessionId: 'session-1',
            toolCall: {
                toolCallId: 'question-1',
                title: 'Ask user question',
            },
            options: [
                { optionId: 'proceed_once', kind: 'allow_once', name: 'Proceed' },
                { optionId: 'cancel', kind: 'reject_once', name: 'Cancel' },
            ],
        })

        expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
            'AskUserQuestion',
            expect.objectContaining({ questions: expect.any(Array) }),
            expect.any(Object),
        )
        expect(response).toMatchObject({
            outcome: { outcome: 'selected', optionId: 'proceed_once' },
            answers: { 'Which database?': 'PostgreSQL' },
        })
        expect((manager as any).permissionToolContexts.size).toBe(0)
    })
})
