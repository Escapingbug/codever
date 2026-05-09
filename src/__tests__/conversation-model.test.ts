import { describe, it, expect } from 'vitest'
import { ConversationModel, type ToolUseState, type ToolResultState } from '@/middleware/conversationModel'
import type { AgentToolUseEvent, AgentToolResultEvent, AgentTextEvent, AgentEvent } from '@/providers/types'

function toolUse(overrides: Partial<AgentToolUseEvent> & { toolUseId: string; toolName: string }): AgentToolUseEvent {
    return {
        kind: 'tool_use',
        input: {},
        ...overrides,
    }
}

function toolResult(overrides: Partial<AgentToolResultEvent> & { toolUseId: string }): AgentToolResultEvent {
    return {
        kind: 'tool_result',
        output: '',
        isError: false,
        ...overrides,
    }
}

describe('ConversationModel — applyEvent', () => {
    it('stores tool_use event in toolUseMap', () => {
        const model = new ConversationModel()
        model.applyEvent(toolUse({ toolUseId: 'c1', toolName: 'Bash' }))
        const state = model.getToolState('c1')
        expect(state).toBeDefined()
        expect(state!.toolName).toBe('Bash')
        expect(state!.status).toBe('pending')
    })

    it('stores tool_result event in toolResultMap', () => {
        const model = new ConversationModel()
        model.applyEvent(toolUse({ toolUseId: 'c1', toolName: 'Bash' }))
        model.applyEvent(toolResult({ toolUseId: 'c1', output: 'ok' }))
        const result = model.getToolResultState('c1')
        expect(result).toBeDefined()
        expect(result!.output).toBe('ok')
        expect(result!.toolName).toBe('Bash')
    })

    it('ignores tool_use events without toolUseId', () => {
        const model = new ConversationModel()
        model.applyEvent(toolUse({ toolUseId: '' as any, toolName: 'Bash' }))
        expect(model.getToolState('')).toBeUndefined()
    })

    it('ignores tool_result events without toolUseId', () => {
        const model = new ConversationModel()
        model.applyEvent(toolResult({ toolUseId: '', output: 'ok' }))
        expect(model.getToolResultState('')).toBeUndefined()
    })

    it('ignores non-tool events', () => {
        const model = new ConversationModel()
        model.applyEvent({ kind: 'text', text: 'hello' } as AgentTextEvent)
        expect(model.getToolName('any')).toBeUndefined()
    })

    it('updates status from pending to running on subsequent tool_use', () => {
        const model = new ConversationModel()
        model.applyEvent(toolUse({ toolUseId: 'c1', toolName: 'Bash', status: 'pending' }))
        model.applyEvent(toolUse({ toolUseId: 'c1', toolName: 'Bash', status: 'running' }))
        expect(model.getToolState('c1')!.status).toBe('running')
    })

    it('does not regress completed status on late tool_use', () => {
        const model = new ConversationModel()
        model.applyEvent(toolUse({ toolUseId: 'c1', toolName: 'Bash', status: 'pending' }))
        model.applyEvent(toolResult({ toolUseId: 'c1', output: 'ok' }))
        model.applyEvent(toolUse({ toolUseId: 'c1', toolName: 'Bash', status: 'running' }))
        expect(model.getToolState('c1')!.status).toBe('completed')
    })

    it('does not regress failed status on late tool_use', () => {
        const model = new ConversationModel()
        model.applyEvent(toolUse({ toolUseId: 'c1', toolName: 'Bash', status: 'pending' }))
        model.applyEvent(toolResult({ toolUseId: 'c1', output: 'err', isError: true }))
        model.applyEvent(toolUse({ toolUseId: 'c1', toolName: 'Bash', status: 'pending' }))
        expect(model.getToolState('c1')!.status).toBe('failed')
    })

    it('updates toolKind and locations on subsequent tool_use', () => {
        const model = new ConversationModel()
        model.applyEvent(toolUse({ toolUseId: 'c1', toolName: 'Bash', status: 'pending' }))
        model.applyEvent(toolUse({
            toolUseId: 'c1',
            toolName: 'Bash',
            status: 'running',
            toolKind: 'execute',
            locations: [{ path: 'src/foo.ts', line: 10 }],
        }))
        const state = model.getToolState('c1')!
        expect(state.toolKind).toBe('execute')
        expect(state.locations).toEqual([{ path: 'src/foo.ts', line: 10 }])
    })

    it('sets tool_result toolName from event.toolName when available', () => {
        const model = new ConversationModel()
        model.applyEvent(toolResult({ toolUseId: 'c1', output: 'ok', toolName: 'Bash' }))
        expect(model.getToolResultState('c1')!.toolName).toBe('Bash')
    })

    it('falls back to toolUseMap for tool_result toolName when event.toolName absent', () => {
        const model = new ConversationModel()
        model.applyEvent(toolUse({ toolUseId: 'c1', toolName: 'Read' }))
        model.applyEvent(toolResult({ toolUseId: 'c1', output: 'contents' }))
        expect(model.getToolResultState('c1')!.toolName).toBe('Read')
    })

    it('preserves structuredOutput on tool_result', () => {
        const model = new ConversationModel()
        model.applyEvent(toolUse({ toolUseId: 'c1', toolName: 'Bash' }))
        model.applyEvent(toolResult({
            toolUseId: 'c1',
            output: 'file.txt',
            structuredOutput: { exitCode: 0, stdout: 'file.txt' },
        }))
        expect(model.getToolResultState('c1')!.structuredOutput).toEqual({ exitCode: 0, stdout: 'file.txt' })
    })
})

describe('ConversationModel — lifecycle reduction', () => {
    it('pending → running → completed', () => {
        const model = new ConversationModel()
        model.applyEvent(toolUse({ toolUseId: 'c1', toolName: 'Bash', status: 'pending' }))
        expect(model.getToolState('c1')!.status).toBe('pending')

        model.applyEvent(toolUse({ toolUseId: 'c1', toolName: 'Bash', status: 'running' }))
        expect(model.getToolState('c1')!.status).toBe('running')

        model.applyEvent(toolResult({ toolUseId: 'c1', output: 'file.txt' }))
        expect(model.getToolState('c1')!.status).toBe('completed')
    })

    it('pending → failed', () => {
        const model = new ConversationModel()
        model.applyEvent(toolUse({ toolUseId: 'c1', toolName: 'Bash', status: 'pending' }))
        model.applyEvent(toolResult({ toolUseId: 'c1', output: 'error', isError: true }))
        expect(model.getToolState('c1')!.status).toBe('failed')
    })

    it('pending → running → failed', () => {
        const model = new ConversationModel()
        model.applyEvent(toolUse({ toolUseId: 'c1', toolName: 'Bash', status: 'pending' }))
        model.applyEvent(toolUse({ toolUseId: 'c1', toolName: 'Bash', status: 'running' }))
        model.applyEvent(toolResult({ toolUseId: 'c1', output: 'error', isError: true }))
        expect(model.getToolState('c1')!.status).toBe('failed')
    })
})

describe('ConversationModel — getToolName', () => {
    it('returns toolName from tool_result (highest priority)', () => {
        const model = new ConversationModel()
        model.applyEvent(toolUse({ toolUseId: 'c1', toolName: 'Read' }))
        model.applyEvent(toolResult({ toolUseId: 'c1', output: 'ok', toolName: 'Bash' }))
        expect(model.getToolName('c1')).toBe('Bash')
    })

    it('returns toolName from tool_use when no tool_result yet', () => {
        const model = new ConversationModel()
        model.applyEvent(toolUse({ toolUseId: 'c1', toolName: 'Read' }))
        expect(model.getToolName('c1')).toBe('Read')
    })

    it('returns undefined for unknown toolUseId', () => {
        const model = new ConversationModel()
        expect(model.getToolName('unknown')).toBeUndefined()
    })
})
