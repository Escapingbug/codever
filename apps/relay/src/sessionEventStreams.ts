import type { SessionEventEnvelope } from '@codever/protocol'
import type { EventRepository } from './repositories'

export interface SessionEventStreamOptions {
    /** Maximum bytes already queued in the WebSocket implementation. */
    maxBufferedBytes: number
    /** Maximum unsent events retained for one subscriber. */
    maxPendingEvents: number
}

export interface EventStreamSocket {
    readonly readyState: number
    readonly bufferedAmount: number
    send(data: string, callback?: (error?: Error) => void): void
    close(code?: number, reason?: string): void
}

interface Subscriber {
    readonly sessionId: string
    readonly socket: EventStreamSocket
    readonly pending: Map<number, SessionEventEnvelope>
    cursor: number
    pumping: boolean
    dirty: boolean
    closed: boolean
}

const OPEN = 1
const DEFAULT_OPTIONS: SessionEventStreamOptions = {
    maxBufferedBytes: 1024 * 1024,
    maxPendingEvents: 2_000,
}

/**
 * Coordinates replay and live delivery without a gap between registering a
 * subscriber and reading its initial cursor. Repository reads remain the
 * source of truth; notifications only wake subscribers after a durable append.
 */
export class SessionEventStreams {
    private readonly subscribers = new Map<string, Set<Subscriber>>()
    private readonly options: SessionEventStreamOptions

    constructor(
        private readonly events: EventRepository,
        options: Partial<SessionEventStreamOptions> = {},
    ) {
        this.options = { ...DEFAULT_OPTIONS, ...options }
        if (!Number.isSafeInteger(this.options.maxBufferedBytes) || this.options.maxBufferedBytes < 1) {
            throw new Error('maxBufferedBytes must be a positive safe integer')
        }
        if (!Number.isSafeInteger(this.options.maxPendingEvents) || this.options.maxPendingEvents < 1) {
            throw new Error('maxPendingEvents must be a positive safe integer')
        }
    }

    subscribe(sessionId: string, after: number, socket: EventStreamSocket): () => void {
        const subscriber: Subscriber = {
            sessionId,
            socket,
            cursor: after,
            pending: new Map(),
            pumping: false,
            dirty: false,
            closed: false,
        }
        const sessionSubscribers = this.subscribers.get(sessionId) ?? new Set<Subscriber>()
        sessionSubscribers.add(subscriber)
        this.subscribers.set(sessionId, sessionSubscribers)
        this.wake(subscriber)
        return () => this.remove(subscriber)
    }

    publish(sessionIds: Iterable<string>): void {
        for (const sessionId of new Set(sessionIds)) {
            for (const subscriber of this.subscribers.get(sessionId) ?? []) this.wake(subscriber)
        }
    }

    subscriberCount(sessionId?: string): number {
        if (sessionId !== undefined) return this.subscribers.get(sessionId)?.size ?? 0
        let count = 0
        for (const subscribers of this.subscribers.values()) count += subscribers.size
        return count
    }

    private wake(subscriber: Subscriber): void {
        if (subscriber.closed) return
        subscriber.dirty = true
        if (subscriber.pumping) return
        subscriber.pumping = true
        void this.pump(subscriber).catch(() => {
            this.close(subscriber, 1011, 'Event stream failed')
        })
    }

    private async pump(subscriber: Subscriber): Promise<void> {
        try {
            while (!subscriber.closed && subscriber.dirty) {
                subscriber.dirty = false
                const events = await this.events.listAfter(
                    subscriber.sessionId,
                    subscriber.cursor,
                    this.options.maxPendingEvents + 1,
                )
                if (subscriber.closed) return
                if (events.length > this.options.maxPendingEvents) {
                    this.close(subscriber, 1013, 'Event cursor is too far behind')
                    return
                }
                for (const event of events) {
                    if (event.seq > subscriber.cursor) subscriber.pending.set(event.seq, event)
                }
                if (subscriber.pending.size > this.options.maxPendingEvents) {
                    this.close(subscriber, 1013, 'Event consumer is too slow')
                    return
                }
                this.flush(subscriber)
            }
        } finally {
            subscriber.pumping = false
            if (!subscriber.closed && subscriber.dirty) this.wake(subscriber)
        }
    }

    private flush(subscriber: Subscriber): void {
        while (!subscriber.closed) {
            const nextSeq = lowestPendingSequence(subscriber.pending, subscriber.cursor)
            if (nextSeq === undefined) return
            const event = subscriber.pending.get(nextSeq)
            if (!event) return
            if (subscriber.socket.readyState !== OPEN) {
                this.remove(subscriber)
                return
            }
            const payload = JSON.stringify({ type: 'session.event', event })
            const payloadBytes = Buffer.byteLength(payload)
            if (payloadBytes > this.options.maxBufferedBytes
                || subscriber.socket.bufferedAmount + payloadBytes > this.options.maxBufferedBytes) {
                this.close(subscriber, 1013, 'Event consumer is too slow')
                return
            }
            try {
                subscriber.socket.send(payload, error => {
                    if (error) this.close(subscriber, 1011, 'Event delivery failed')
                })
            } catch {
                this.close(subscriber, 1011, 'Event delivery failed')
                return
            }
            subscriber.pending.delete(nextSeq)
            subscriber.cursor = nextSeq
        }
    }

    private close(subscriber: Subscriber, code: number, reason: string): void {
        if (subscriber.closed) return
        this.remove(subscriber)
        try {
            subscriber.socket.close(code, reason)
        } catch {
            // The socket is already unusable; removal above is the required cleanup.
        }
    }

    private remove(subscriber: Subscriber): void {
        if (subscriber.closed) return
        subscriber.closed = true
        subscriber.pending.clear()
        const sessionSubscribers = this.subscribers.get(subscriber.sessionId)
        sessionSubscribers?.delete(subscriber)
        if (sessionSubscribers?.size === 0) this.subscribers.delete(subscriber.sessionId)
    }
}

function lowestPendingSequence(
    pending: ReadonlyMap<number, SessionEventEnvelope>,
    after: number,
): number | undefined {
    let next: number | undefined
    for (const seq of pending.keys()) {
        if (seq > after && (next === undefined || seq < next)) next = seq
    }
    return next
}
