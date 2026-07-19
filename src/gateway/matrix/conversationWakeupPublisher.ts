import type { SessionEventEnvelope } from '@codever/protocol'

export interface ConversationWakeupPublisherOptions {
    intervalMs?: number
    publish: (event: SessionEventEnvelope) => Promise<void>
    onError?: (error: Error) => void
}

interface PendingWakeup {
    event: SessionEventEnvelope
    timer: ReturnType<typeof setTimeout>
}

/**
 * Publishes sparse Matrix wake-ups while the Gateway journal remains the
 * authoritative, lossless event stream. State, decisions, and errors bypass
 * throttling; high-volume Provider details are coalesced per Session.
 */
export class ConversationWakeupPublisher {
    private readonly intervalMs: number
    private readonly lastPublishedAt = new Map<string, number>()
    private readonly pending = new Map<string, PendingWakeup>()
    private closed = false

    constructor(private readonly options: ConversationWakeupPublisherOptions) {
        this.intervalMs = options.intervalMs ?? 5_000
    }

    accept(event: SessionEventEnvelope): void {
        if (this.closed) return
        if (isImmediateConversationWakeup(event.event)) {
            this.clearPending(event.sessionId)
            this.publishNow(event)
            return
        }
        const elapsed = Date.now() - (this.lastPublishedAt.get(event.sessionId) ?? 0)
        if (elapsed >= this.intervalMs) {
            this.publishNow(event)
            return
        }
        const existing = this.pending.get(event.sessionId)
        if (existing) {
            existing.event = event
            return
        }
        const timer = setTimeout(() => {
            const latest = this.pending.get(event.sessionId)?.event
            this.pending.delete(event.sessionId)
            if (latest && !this.closed) this.publishNow(latest)
        }, this.intervalMs - elapsed)
        this.pending.set(event.sessionId, { event, timer })
    }

    close(): void {
        this.closed = true
        for (const value of this.pending.values()) clearTimeout(value.timer)
        this.pending.clear()
    }

    private clearPending(sessionId: string): void {
        const value = this.pending.get(sessionId)
        if (value) clearTimeout(value.timer)
        this.pending.delete(sessionId)
    }

    private publishNow(event: SessionEventEnvelope): void {
        this.lastPublishedAt.set(event.sessionId, Date.now())
        void this.options.publish(event).catch(error => {
            this.options.onError?.(error instanceof Error ? error : new Error(String(error)))
        })
    }
}

export function isImmediateConversationWakeup(event: SessionEventEnvelope['event']): boolean {
    return event.kind === 'session_state' || event.kind === 'decision_request'
        || event.kind === 'decision_resolved' || (event.kind === 'status' && event.level === 'error')
}
