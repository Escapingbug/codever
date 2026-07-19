export interface SessionEventEnvelope<T = unknown> {
    schemaVersion: 1
    gatewayId: string
    projectId: string
    sessionId: string
    seq: number
    eventId: string
    timestamp: string
    event: T
}

export type NewConversationEvent<T = unknown> = Omit<SessionEventEnvelope<T>, 'schemaVersion' | 'seq'> & {
    schemaVersion?: 1
}

export interface ListConversationEventsOptions {
    /** Return events with a sequence strictly greater than this cursor. */
    after?: number
    limit?: number
}

export interface ConversationEventPage<T = unknown> {
    events: SessionEventEnvelope<T>[]
    /** Sequence of the last returned event, or the supplied cursor for an empty page. */
    cursor: number
    hasMore: boolean
}

export interface ConversationEventStore<T = unknown> {
    /** Append an event, allocating its next per-session sequence number. */
    append(event: NewConversationEvent<T>): Promise<SessionEventEnvelope<T>>
    /** Append a snapshot with one durability flush when the store supports batching. */
    appendMany?(events: NewConversationEvent<T>[]): Promise<SessionEventEnvelope<T>[]>

    /**
     * Append an already-sequenced event during replay or replication.
     * Existing eventId and (sessionId, seq) keys are idempotent.
     */
    appendEnvelope(event: SessionEventEnvelope<T>): Promise<SessionEventEnvelope<T>>

    list(sessionId: string, options?: ListConversationEventsOptions): Promise<ConversationEventPage<T>>
    close(): Promise<void>
}
