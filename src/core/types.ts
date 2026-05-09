import type { AgentEvent } from '@/providers/types'

export type QueryLoopState = 'idle' | 'querying' | 'canceling' | 'dead'

export type PermissionDecision = 'allow' | 'deny' | 'cancel'

export type QueryLoopEvent =
    | { type: 'session.created'; sessionId: string }
    | { type: 'session.destroyed'; sessionId: string }
    | { type: 'session.state_changed'; sessionId: string; from: QueryLoopState; to: QueryLoopState }
    | { type: 'query.started'; sessionId: string; queryId: string }
    | { type: 'query.event'; sessionId: string; queryId: string; event: AgentEvent }
    | { type: 'query.completed'; sessionId: string; queryId: string; result: { status: string } }
    | { type: 'query.error'; sessionId: string; queryId: string; error: unknown }
    | { type: 'query.timeout'; sessionId: string; queryId: string; elapsed: number }
    | { type: 'timeout.continue'; sessionId: string }
    | { type: 'permission.request'; sessionId: string; requestId: string; toolName: string; input: unknown }
    | { type: 'permission.respond'; sessionId: string; requestId: string; decision: PermissionDecision }
    | { type: 'message.incoming'; sessionId: string; text: string }
    | { type: 'message.outgoing'; sessionId: string; text: string }
    | { type: 'message.queued'; sessionId: string; text: string; queueSize: number }
