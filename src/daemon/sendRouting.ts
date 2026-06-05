import type { TopicSession } from '@/bridge/channelPort'
import type { SendRequest } from './api'

export function routeSendMessageToTopicSession(topicSession: TopicSession, req: SendRequest): void {
    void topicSession.dispatch({
        kind: 'command',
        name: 'send_message',
        args: req.message,
        source: 'mcp',
    })
}
