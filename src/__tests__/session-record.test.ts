import { describe, expect, it, vi } from 'vitest'
import { createTopicSession, createTopicSessionRecord } from '@/bridge/topicSession'
import type { ChannelMessage, ChannelPort, DecisionRequest, DecisionResponse, SessionStatus } from '@/bridge/channelPort'
import type { AgentEvent, ProviderCommand } from '@/providers/types'
import type { AgentProvider, AgentQueryConfig, AgentQueryHandle } from '@/providers/provider'

const configMocks = vi.hoisted(() => ({
    saveTopicState: vi.fn(),
}))

vi.mock('@/config', () => ({
    config: {
        saveTopicState: configMocks.saveTopicState,
    },
}))

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function createProvider(events: AgentEvent[]): AgentProvider {
    return {
        name: 'mock-provider',
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

function createChannel(): ChannelPort & {
    sent: ChannelMessage[]
    statuses: SessionStatus[]
    decisions: DecisionRequest[]
} {
    const sent: ChannelMessage[] = []
    const statuses: SessionStatus[] = []
    const decisions: DecisionRequest[] = []
    return {
        sent,
        statuses,
        decisions,
        send: vi.fn(async (message) => {
            sent.push(message)
            return { messageId: sent.length }
        }),
        requestDecision: vi.fn(async (request): Promise<DecisionResponse> => {
            decisions.push(request)
            return { value: request.options[0]?.value ?? '' }
        }),
        notifyStatus: vi.fn((status) => {
            statuses.push(status)
        }),
    }
}

describe('SessionRecord metadata boundary', () => {
    it('contains session metadata without runtime execution APIs', () => {
        const record = createTopicSessionRecord({
            cwd: '/repo',
            providerName: 'mock-provider',
            groupChatId: -100,
            messageThreadId: 10,
            model: 'sonnet',
            timeoutSeconds: 240,
            providerSettings: { permissionMode: 'approve-all' },
            conversationId: 'provider-session',
        })

        expect(record.cwd).toBe('/repo')
        expect(record.providerName).toBe('mock-provider')
        expect(record.model).toBe('sonnet')
        expect(record.timeoutSeconds).toBe(240)
        expect(record.providerSettings).toEqual({ permissionMode: 'approve-all' })
        expect(record.conversationId).toBe('provider-session')
        expect('processInput' in record).toBe(false)
        expect('waitForPermission' in record).toBe(false)
        expect('resolvePermission' in record).toBe(false)
    })

    it('TopicSession routes execution through SemanticSessionRuntime', async () => {
        const provider = createProvider([
            { kind: 'text', text: 'runtime response' },
            { kind: 'result', status: 'success' },
        ])
        const channel = createChannel()
        const record = createTopicSessionRecord({
            cwd: '/repo',
            providerName: provider.name,
            groupChatId: -100,
            messageThreadId: 10,
        })
        const topicSession = createTopicSession({ sessionRecord: record, provider, channelPort: channel })

        topicSession.receiveInput({ text: 'hello', username: 'alice' })
        await delay(30)

        expect(provider.startQuery).toHaveBeenCalledWith('hello', expect.objectContaining({
            cwd: '/repo',
            sessionId: undefined,
        }))
        expect(channel.sent.map(message => message.text)).toEqual(['runtime response'])
        expect(channel.statuses.map(status => status.state)).toEqual(['querying', 'idle'])
    })

    it('runtime updates provider session and available commands on the metadata record', async () => {
        const commands: ProviderCommand[] = [
            { name: 'review', description: 'Review current diff', inputHint: null },
        ]
        const provider = createProvider([
            { kind: 'session_init', sessionId: 'provider-session-2' },
            { kind: 'commands_update', commands },
            { kind: 'result', status: 'success' },
        ])
        const channel = createChannel()
        const record = createTopicSessionRecord({
            cwd: '/repo',
            providerName: provider.name,
            groupChatId: -100,
            messageThreadId: 10,
        })
        const topicSession = createTopicSession({ sessionRecord: record, provider, channelPort: channel })

        await topicSession.dispatch({ kind: 'user_message', text: 'hello', source: 'channel' })

        expect(record.conversationId).toBe('provider-session-2')
        expect(record.availableCommands).toEqual(commands)
    })
})
