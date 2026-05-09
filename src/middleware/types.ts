import type { AgentEvent } from '@/providers/types'
import type { QueryLoopEvent } from '@/core/types'

export type MiddlewareOutput = AgentEvent

export interface MiddlewareContext {
    sessionId: string
    queryId: string
    verboseLevel: 0 | 1 | 2
    providerSettings: Record<string, unknown>
    timeoutSeconds: number
    bus: {
        emit(event: QueryLoopEvent): void
    }
}

export interface MiddlewareResult {
    formatted: string | null
    event: MiddlewareOutput
}

export interface Middleware {
    readonly name: string
    process(event: MiddlewareOutput, context: MiddlewareContext): MiddlewareResult | null
}

export type MiddlewareFn = (event: MiddlewareOutput, context: MiddlewareContext) => MiddlewareResult | null

export interface SendableMessage {
    text: string
    chatId: number
    messageThreadId?: number
    replyMarkup?: unknown
}
