import { describe, expect, it, vi } from 'vitest'
import { createCursorAcpExtensionHandler } from '../cursorExtensions'
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable'
import type { AgentEvent } from '@/providers/types'
import type { AgentQueryConfig } from '@/providers/provider'

function createConfig(overrides: Partial<AgentQueryConfig> = {}): AgentQueryConfig {
    return {
        cwd: '/repo',
        signal: new AbortController().signal,
        ...overrides,
    }
}

describe('Cursor ACP extension handler', () => {
    it('renders create_plan todos and returns the selected plan outcome', async () => {
        const events = new PushableAsyncIterable<AgentEvent>()
        const requestDecision = vi.fn(async () => ({ value: 'rejected' }))
        const handler = createCursorAcpExtensionHandler(events, createConfig({
            decisionHandler: { requestDecision },
        }))

        const result = await handler.extMethod!('cursor/create_plan', {
            name: 'Implementation plan',
            overview: 'Add Cursor extension support',
            markdown: '1. Add hooks\n2. Render todos',
            todos: [
                { content: 'Add hooks', status: 'completed' },
                { content: 'Render todos', status: 'in_progress' },
            ],
        })

        expect(result).toEqual({ outcome: { outcome: 'rejected' } })
        expect(requestDecision).toHaveBeenCalledWith(expect.objectContaining({
            type: 'question',
            title: 'Implementation plan',
            details: expect.stringContaining('Add Cursor extension support'),
        }))
        await expect(events.next()).resolves.toMatchObject({
            value: {
                kind: 'tool_use',
                toolName: 'TodoWrite',
                input: {
                    todos: [
                        { content: 'Add hooks', status: 'completed' },
                        { content: 'Render todos', status: 'in_progress' },
                    ],
                },
            },
        })
    })

    it('answers cursor ask_question with selected option ids', async () => {
        const events = new PushableAsyncIterable<AgentEvent>()
        const requestDecision = vi.fn(async () => ({ value: 'q1:opt2' }))
        const handler = createCursorAcpExtensionHandler(events, createConfig({
            decisionHandler: { requestDecision },
        }))

        const result = await handler.extMethod!('cursor/ask_question', {
            title: 'Choose an approach',
            questions: [{
                id: 'q1',
                text: 'Which implementation?',
                options: [
                    { id: 'opt1', label: 'Generic runtime' },
                    { id: 'opt2', label: 'Cursor provider only' },
                ],
            }],
        })

        expect(result).toEqual({
            outcome: {
                outcome: 'answered',
                answers: [{ questionId: 'q1', selectedOptionIds: ['opt2'] }],
            },
        })
        expect(requestDecision).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Choose an approach',
            options: [
                { label: 'Generic runtime', value: 'q1:opt1' },
                { label: 'Cursor provider only', value: 'q1:opt2' },
            ],
        }))
    })

    it('renders cursor update_todos notifications as TodoWrite tool updates', async () => {
        const events = new PushableAsyncIterable<AgentEvent>()
        const handler = createCursorAcpExtensionHandler(events, createConfig())

        await handler.extNotification!('cursor/update_todos', {
            todos: [{ title: 'Document provider boundary', state: 'done' }],
        })

        await expect(events.next()).resolves.toMatchObject({
            value: {
                kind: 'tool_use',
                toolName: 'TodoWrite',
                input: { todos: [{ content: 'Document provider boundary', status: 'completed' }] },
            },
        })
    })
})
