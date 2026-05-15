import { describe, expect, it, vi } from 'vitest'
import { SemanticSessionRuntime } from '@/runtime/semanticSessionRuntime'
import type { AgentProvider, AgentQueryConfig, AgentQueryHandle } from '@/providers/provider'
import type { AgentEvent } from '@/providers/types'
import type { ChannelMessage, ChannelPort, SessionStatus } from '@/bridge/channelPort'

interface DeliveryOperation {
    kind: 'send' | 'edit'
    message: ChannelMessage
    messageId?: string | number
}

function createProvider(events: AgentEvent[]): AgentProvider {
    return {
        name: 'test-acp',
        startQuery: vi.fn((_prompt: string, _config: AgentQueryConfig): AgentQueryHandle => ({
            events: (async function* () {
                for (const event of events) yield event
            })(),
            interrupt: vi.fn(),
        })),
        isReady: vi.fn(() => true),
        getInitError: vi.fn(() => null),
        getAvailableModels: vi.fn(() => []),
        getAvailablePermissionModes: vi.fn(() => []),
    }
}

function createChannel(sent: ChannelMessage[], statuses: SessionStatus[], operations: DeliveryOperation[] = []): ChannelPort {
    return {
        send: vi.fn(async (message) => {
            sent.push(message)
            operations.push({ kind: 'send', message, messageId: sent.length })
            return { messageId: sent.length }
        }),
        edit: vi.fn(async (messageId, message) => {
            sent.push({ ...message, text: `EDIT:${message.text}` })
            operations.push({ kind: 'edit', message, messageId })
        }),
        requestDecision: vi.fn(async () => ({ value: 'allow' })),
        notifyStatus: vi.fn((status) => {
            statuses.push(status)
        }),
    }
}

describe('SemanticSessionRuntime', () => {
    it('runs a user message through provider semantics, journal, projector, and outbox', async () => {
        const sent: ChannelMessage[] = []
        const statuses: SessionStatus[] = []
        const provider = createProvider([
            { kind: 'session_init', sessionId: 'provider-session-1' },
            { kind: 'text', text: 'Hello ' },
            { kind: 'text', text: 'world' },
            { kind: 'result', status: 'success' },
        ])
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'test-acp',
            channelPort: createChannel(sent, statuses),
            providerSettings: { verboseLevel: 2 },
        })

        await runtime.dispatch({ kind: 'user_message', text: 'hi', source: 'channel' })

        expect(provider.startQuery).toHaveBeenCalledWith('hi', expect.objectContaining({ cwd: '/repo' }))
        expect(runtime.journal.list().map(e => e.kind)).toEqual([
            'turn_started',
            'provider_raw',
            'assistant_text_delta',
            'assistant_text_delta',
            'turn_finished',
        ])
        expect(sent.map(m => m.text)).toEqual(['Hello world'])
        expect(statuses.map(s => s.state)).toEqual(['querying', 'idle'])
    })

    it('projects verbose tool updates as one message per tool without raw output', async () => {
        const sent: ChannelMessage[] = []
        const statuses: SessionStatus[] = []
        const operations: DeliveryOperation[] = []
        const provider = createProvider([
            { kind: 'tool_use', toolUseId: 'tool-1', toolName: 'Bash', input: { command: 'npm test' }, status: 'running' },
            { kind: 'tool_result', toolUseId: 'tool-1', toolName: 'Bash', output: 'passed', isError: false },
            { kind: 'result', status: 'success' },
        ])
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'test-acp',
            channelPort: createChannel(sent, statuses, operations),
            providerSettings: { verboseLevel: 2 },
        })

        await runtime.dispatch({ kind: 'user_message', text: 'run tests', source: 'channel' })

        expect(sent).toHaveLength(2)
        expect(sent[0].text).toContain('npm test')
        expect(sent[1].text).toContain('EDIT:')
        expect(sent[1].text).toContain('npm test')
        expect(sent[1].text).not.toContain('passed')
        expect(operations.map(op => op.kind)).toEqual(['send', 'edit'])
    })

    it('aggregates normal tool updates between assistant text messages into one editable message', async () => {
        const sent: ChannelMessage[] = []
        const statuses: SessionStatus[] = []
        const operations: DeliveryOperation[] = []
        const provider = createProvider([
            { kind: 'text', text: 'First answer\n' },
            { kind: 'tool_use', toolUseId: 'tool-1', toolName: 'Bash', input: { command: 'npm test' }, status: 'running' },
            { kind: 'tool_result', toolUseId: 'tool-1', toolName: 'Bash', output: 'passed', isError: false },
            { kind: 'tool_use', toolUseId: 'tool-2', toolName: 'Read', input: { file_path: '/repo/src/app.ts' }, status: 'running' },
            { kind: 'tool_result', toolUseId: 'tool-2', toolName: 'Read', output: 'const secret = "file body"', isError: false },
            { kind: 'text', text: 'Done' },
            { kind: 'result', status: 'success' },
        ])
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'test-acp',
            channelPort: createChannel(sent, statuses, operations),
            providerSettings: { verboseLevel: 1 },
        })

        await runtime.dispatch({ kind: 'user_message', text: 'run tests', source: 'channel' })

        expect(operations.map(op => op.kind)).toEqual(['send', 'send', 'edit', 'edit', 'edit', 'send'])
        expect(operations[0].message.text).toBe('First answer\n')
        expect(operations[1].message.text).toContain('npm test')
        expect(operations[2].messageId).toBe(operations[1].messageId)
        expect(operations[3].messageId).toBe(operations[1].messageId)
        expect(operations[4].messageId).toBe(operations[1].messageId)
        expect(operations[5].message.text).toBe('Done')

        const finalToolMessage = operations[4].message.text
        expect(finalToolMessage).toContain('npm test')
        expect(finalToolMessage).toContain('Read')
        expect(finalToolMessage).toContain('/repo/src/app.ts')
        expect(finalToolMessage).not.toContain('passed')
        expect(finalToolMessage).not.toContain('const secret')
    })

    it('suppresses all tool output in quiet mode while preserving assistant text', async () => {
        const sent: ChannelMessage[] = []
        const statuses: SessionStatus[] = []
        const operations: DeliveryOperation[] = []
        const provider = createProvider([
            { kind: 'tool_use', toolUseId: 'tool-1', toolName: 'Bash', input: { command: 'npm test' }, status: 'running' },
            { kind: 'tool_result', toolUseId: 'tool-1', toolName: 'Bash', output: 'passed', isError: false },
            { kind: 'text', text: 'Only assistant text' },
            { kind: 'result', status: 'success' },
        ])
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'test-acp',
            channelPort: createChannel(sent, statuses, operations),
            providerSettings: { verboseLevel: 0 },
        })

        await runtime.dispatch({ kind: 'user_message', text: 'run quietly', source: 'channel' })

        expect(operations).toHaveLength(1)
        expect(operations[0]).toMatchObject({
            kind: 'send',
            message: { text: 'Only assistant text', format: 'markdown' },
        })
        expect(sent.map(message => message.text).join('\n')).not.toContain('npm test')
        expect(sent.map(message => message.text).join('\n')).not.toContain('passed')
    })

    it('renders ExitPlanMode plan content even in quiet mode', async () => {
        const sent: ChannelMessage[] = []
        const statuses: SessionStatus[] = []
        const operations: DeliveryOperation[] = []
        const provider = createProvider([
            { kind: 'tool_result', toolUseId: 'plan-1', toolName: 'ExitPlanMode', output: '1. Inspect\n2. Implement', isError: false },
            { kind: 'result', status: 'success' },
        ])
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'test-acp',
            channelPort: createChannel(sent, statuses, operations),
            providerSettings: { verboseLevel: 0 },
        })

        await runtime.dispatch({ kind: 'user_message', text: 'make a plan', source: 'channel' })

        expect(operations).toHaveLength(1)
        expect(operations[0].message.text).toContain('Plan')
        expect(operations[0].message.text).toContain('Inspect')
        expect(operations[0].message.text).toContain('Implement')
    })

    it('does not render concrete tool content in any verbosity mode', async () => {
        for (const verboseLevel of [0, 1, 2] as const) {
            const sent: ChannelMessage[] = []
            const statuses: SessionStatus[] = []
            const provider = createProvider([
                { kind: 'tool_use', toolUseId: 'read-1', toolName: 'Read', input: { file_path: '/repo/private.ts' }, status: 'running' },
                { kind: 'tool_result', toolUseId: 'read-1', toolName: 'Read', output: 'const password = "super-secret"', isError: false },
                { kind: 'tool_use', toolUseId: 'edit-1', toolName: 'Edit', input: { file_path: '/repo/private.ts' }, status: 'running' },
                { kind: 'tool_result', toolUseId: 'edit-1', toolName: 'Edit', output: 'diff --git a/private.ts b/private.ts\n+token = "secret"', isError: false },
                { kind: 'text', text: `mode ${verboseLevel} done` },
                { kind: 'result', status: 'success' },
            ])
            const runtime = new SemanticSessionRuntime({
                sessionId: `session-${verboseLevel}`,
                cwd: '/repo',
                provider,
                providerName: 'test-acp',
                channelPort: createChannel(sent, statuses),
                providerSettings: { verboseLevel },
            })

            await runtime.dispatch({ kind: 'user_message', text: `mode ${verboseLevel}`, source: 'channel' })

            const rendered = sent.map(message => message.text).join('\n')
            expect(rendered).not.toContain('super-secret')
            expect(rendered).not.toContain('diff --git')
            expect(rendered).not.toContain('token = "secret"')
        }
    })
})
