import { describe, expect, it, vi } from 'vitest'
import { SemanticSessionRuntime } from '@/runtime/semanticSessionRuntime'
import type { AgentProvider, AgentQueryConfig, AgentQueryHandle } from '@/providers/provider'
import type { AgentEvent } from '@/providers/types'
import type { ChannelMessage, ChannelPort, SessionStatus } from '@/bridge/channelPort'

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

function createChannel(sent: ChannelMessage[], statuses: SessionStatus[]): ChannelPort {
    return {
        send: vi.fn(async (message) => {
            sent.push(message)
            return { messageId: sent.length }
        }),
        edit: vi.fn(async (_messageId, message) => {
            sent.push({ ...message, text: `EDIT:${message.text}` })
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

    it('projects tool updates as send then edit through the outbox', async () => {
        const sent: ChannelMessage[] = []
        const statuses: SessionStatus[] = []
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
            channelPort: createChannel(sent, statuses),
            providerSettings: { verboseLevel: 2 },
        })

        await runtime.dispatch({ kind: 'user_message', text: 'run tests', source: 'channel' })

        expect(sent).toHaveLength(2)
        expect(sent[0].text).toContain('npm test')
        expect(sent[1].text).toContain('EDIT:')
        expect(sent[1].text).toContain('passed')
    })

    it('suppresses successful tool output at normal verbose level', async () => {
        const sent: ChannelMessage[] = []
        const statuses: SessionStatus[] = []
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
            channelPort: createChannel(sent, statuses),
            providerSettings: { verboseLevel: 1 },
        })

        await runtime.dispatch({ kind: 'user_message', text: 'run tests', source: 'channel' })

        expect(sent).toHaveLength(2)
        expect(sent[0].text).toContain('npm test')
        expect(sent[1].text).toContain('EDIT:')
        expect(sent[1].text).toContain('npm test')
        expect(sent[1].text).not.toContain('passed')
    })
})
