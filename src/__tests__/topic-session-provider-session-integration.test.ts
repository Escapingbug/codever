import { describe, expect, it, vi } from 'vitest'
import { createTopicSession } from '@/bridge/topicSession'
import { SessionManager } from '@/bridge/sessionManager'
import type { AgentProvider } from '@/providers/provider'
import type { AgentEvent } from '@/providers/types'
import type { ChannelPort } from '@/bridge/channelPort'

const configMocks = vi.hoisted(() => ({
    saveTopicState: vi.fn(),
}))

vi.mock('@/config', () => ({
    config: {
        saveTopicState: configMocks.saveTopicState,
    },
}))

async function* events(items: AgentEvent[]) {
    for (const item of items) yield item
}

function createProvider(items: AgentEvent[] = []): AgentProvider {
    return {
        name: 'mock-acp',
        isReady: vi.fn(() => true),
        getInitError: vi.fn(() => null),
        startQuery: vi.fn(() => ({
            events: events(items),
            interrupt: vi.fn(async () => {}),
        })),
    } as any
}

function createQueryLoop() {
    return {
        id: 'query-loop-1',
        cwd: '/repo',
        groupChatId: -100,
        messageThreadId: 10,
        providerName: 'mock-acp',
        model: 'sonnet',
        providerSettings: { permissionMode: 'default' },
        conversationId: null as string | null,
        setConversationId: vi.fn(function (this: any, sessionId: string | null) {
            this.conversationId = sessionId
        }),
        destroy: vi.fn(async () => {}),
    } as any
}

function createChannelPort(): ChannelPort & { sent: string[] } {
    const port = {
        sent: [] as string[],
        send: vi.fn(async (message) => {
            port.sent.push(message.text)
            return { messageId: port.sent.length }
        }),
        edit: vi.fn(async () => {}),
        requestDecision: vi.fn(async () => ({ value: 'allow' })),
        notifyStatus: vi.fn(),
    }
    return port
}

describe('TopicSession provider session integration', () => {
    it('records provider session ids from session_init and makes them discoverable by SessionManager', async () => {
        const provider = createProvider([
            { kind: 'session_init', sessionId: 'provider-session-1' } as any,
            { kind: 'text', text: 'hello from provider', isFinal: true } as any,
            { kind: 'result', status: 'success' } as any,
        ])
        const queryLoop = createQueryLoop()
        const channelPort = createChannelPort()
        const topicSession = createTopicSession({
            queryLoop,
            provider,
            channelPort,
            pipeline: {} as any,
        })
        const manager = new SessionManager()
        manager.registerTopicSession('-100:10', topicSession)

        topicSession.receiveInput({ text: 'hello', username: 'alice' })
        await new Promise(resolve => setTimeout(resolve, 20))

        expect(queryLoop.setConversationId).toHaveBeenCalledWith('provider-session-1')
        expect(configMocks.saveTopicState).toHaveBeenCalledWith('-100:10', { conversationId: 'provider-session-1' })
        expect(manager.getTopicSessionByConversationId('provider-session-1')).toBe(topicSession)
        expect(channelPort.sent.join('\n')).toContain('hello from provider')
    })

    it('dispatches scheduled messages through the same runtime path as channel user messages', async () => {
        const provider = createProvider([
            { kind: 'text', text: 'scheduled response', isFinal: true } as any,
            { kind: 'result', status: 'success' } as any,
        ])
        const topicSession = createTopicSession({
            queryLoop: createQueryLoop(),
            provider,
            channelPort: createChannelPort(),
            pipeline: {} as any,
        })

        await topicSession.dispatch({
            kind: 'scheduled_message',
            text: 'time to check status',
            source: 'scheduler',
        })

        expect(provider.startQuery).toHaveBeenCalledWith('time to check status', expect.objectContaining({
            cwd: '/repo',
            model: 'sonnet',
            providerSettings: { permissionMode: 'default' },
        }))
    })
})
