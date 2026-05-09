/**
 * EventRouter — routes SSE events from the shared listener to per-query PushableAsyncIterables.
 *
 * Each startQuery() call creates a PushableAsyncIterable and registers it here.
 * When SSE events arrive, the router dispatches them to the correct iterable by sessionId.
 *
 * Two binding modes:
 * - Resume (sessionId known): bind immediately on registration
 * - New session: bind later when session_init event carries the sessionId
 */

import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable'
import type { AgentEvent } from '@/providers/types'

type QueryId = string
type SessionId = string

export class EventRouter {
    /** Active query streams, keyed by sessionId */
    private routes = new Map<SessionId, PushableAsyncIterable<AgentEvent>>()

    /** Queries awaiting sessionId binding, keyed by queryId */
    private pendingBindings = new Map<QueryId, { sessionId: SessionId; pushable: PushableAsyncIterable<AgentEvent> }>()

    /** Reverse lookup: sessionId → queryId (for cleanup) */
    private sessionToQuery = new Map<SessionId, QueryId>()

    /** Track which sessions are currently busy (for interrupt wait logic) */
    private busySessions = new Set<SessionId>()

    /**
     * Register a new query stream.
     * If sessionId is known (resume), bind immediately.
     * Otherwise, wait for bindSessionId() call from session_init event.
     */
    register(queryId: QueryId, pushable: PushableAsyncIterable<AgentEvent>, sessionId?: SessionId): void {
        if (sessionId) {
            this.routes.set(sessionId, pushable)
            this.sessionToQuery.set(sessionId, queryId)
            this.pendingBindings.set(queryId, { sessionId, pushable })
        } else {
            this.pendingBindings.set(queryId, { sessionId: '', pushable })
        }
    }

    /**
     * Bind a queryId to a sessionId (called when session_init arrives).
     */
    bindSessionId(queryId: QueryId, sessionId: SessionId): void {
        const pending = this.pendingBindings.get(queryId)
        if (!pending) return

        pending.sessionId = sessionId
        this.routes.set(sessionId, pending.pushable)
        this.sessionToQuery.set(sessionId, queryId)
    }

    /**
     * Push an adapted AgentEvent to the correct query stream.
     * Returns true if the event was routed to an active query.
     */
    pushEvent(sessionId: SessionId, event: AgentEvent): boolean {
        const pushable = this.routes.get(sessionId)
        if (!pushable || pushable.done) return false
        pushable.push(event)
        return true
    }

    /**
     * Mark a session as busy (from session.status busy event).
     */
    markBusy(sessionId: SessionId): void {
        this.busySessions.add(sessionId)
    }

    /**
     * Mark a session as idle (from session.idle event).
     */
    markIdle(sessionId: SessionId): void {
        this.busySessions.delete(sessionId)
    }

    /**
     * Check if a session is currently busy.
     */
    isBusy(sessionId: SessionId): boolean {
        return this.busySessions.has(sessionId)
    }

    /**
     * End a query stream and remove its route.
     * Pushes a final result event if the stream hasn't ended yet.
     */
    endQuery(sessionId: SessionId, finalEvent?: AgentEvent): void {
        const pushable = this.routes.get(sessionId)
        if (pushable && !pushable.done) {
            if (finalEvent) {
                pushable.push(finalEvent)
            }
            pushable.end()
        }
        this.routes.delete(sessionId)
        this.busySessions.delete(sessionId)
        const queryId = this.sessionToQuery.get(sessionId)
        if (queryId) {
            this.pendingBindings.delete(queryId)
        }
        this.sessionToQuery.delete(sessionId)
    }

    /**
     * Find the pushable for a sessionId.
     */
    getPushable(sessionId: SessionId): PushableAsyncIterable<AgentEvent> | undefined {
        return this.routes.get(sessionId)
    }

    /**
     * Find the queryId for a sessionId.
     */
    getQueryId(sessionId: SessionId): QueryId | undefined {
        return this.sessionToQuery.get(sessionId)
    }

    /**
     * Check if a sessionId has an active route.
     */
    hasRoute(sessionId: SessionId): boolean {
        return this.routes.has(sessionId)
    }

    /**
     * Get all active session IDs (for server crash notification).
     */
    getActiveSessionIds(): SessionId[] {
        return [...this.routes.keys()]
    }

    /**
     * End all active queries with an error (used on server crash).
     */
    endAllWithError(message: string): void {
        for (const [sessionId, pushable] of this.routes) {
            if (!pushable.done) {
                pushable.push({ kind: 'result', status: 'error', summary: message })
                pushable.end()
            }
        }
        this.routes.clear()
        this.pendingBindings.clear()
        this.sessionToQuery.clear()
        this.busySessions.clear()
    }

    /**
     * Remove a query registration without ending the stream.
     * Used when the stream has already ended naturally.
     */
    removeRoute(sessionId: SessionId): void {
        this.routes.delete(sessionId)
        this.busySessions.delete(sessionId)
        const queryId = this.sessionToQuery.get(sessionId)
        if (queryId) {
            this.pendingBindings.delete(queryId)
        }
        this.sessionToQuery.delete(sessionId)
    }
}
