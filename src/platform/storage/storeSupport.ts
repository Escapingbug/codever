import type {
    ConversationEventPage,
    ListConversationEventsOptions,
    NewConversationEvent,
    SessionEventEnvelope,
} from './conversationEventStore'
import { isDeepStrictEqual } from 'node:util'

export interface EventIndex<T> {
    byEventId: Map<string, SessionEventEnvelope<T>>
    bySession: Map<string, Map<number, SessionEventEnvelope<T>>>
    lastSeq: Map<string, number>
}

export function createEventIndex<T>(): EventIndex<T> {
    return {
        byEventId: new Map(),
        bySession: new Map(),
        lastSeq: new Map(),
    }
}

export function findDuplicate<T>(
    index: EventIndex<T>,
    envelope: SessionEventEnvelope<T>,
): SessionEventEnvelope<T> | undefined {
    const byEventId = index.byEventId.get(envelope.eventId)
    if (byEventId) {
        if (!isDeepStrictEqual(byEventId, envelope)) {
            throw new Error(`Conflicting eventId ${envelope.eventId}`)
        }
        return byEventId
    }

    const bySequence = index.bySession.get(envelope.sessionId)?.get(envelope.seq)
    if (bySequence) {
        if (!isDeepStrictEqual(bySequence, envelope)) {
            throw new Error(`Conflicting sequence ${envelope.seq} for session ${envelope.sessionId}`)
        }
        return bySequence
    }

    return undefined
}

export function findDuplicateNew<T>(
    index: EventIndex<T>,
    event: NewConversationEvent<T>,
): SessionEventEnvelope<T> | undefined {
    const existing = index.byEventId.get(event.eventId)
    if (!existing) return undefined

    const comparable = {
        gatewayId: existing.gatewayId,
        projectId: existing.projectId,
        sessionId: existing.sessionId,
        eventId: existing.eventId,
        timestamp: existing.timestamp,
        event: existing.event,
    }
    const candidate = {
        gatewayId: event.gatewayId,
        projectId: event.projectId,
        sessionId: event.sessionId,
        eventId: event.eventId,
        timestamp: event.timestamp,
        event: event.event,
    }
    if (!isDeepStrictEqual(comparable, candidate)) {
        throw new Error(`Conflicting eventId ${event.eventId}`)
    }
    return existing
}

export function addToIndex<T>(index: EventIndex<T>, envelope: SessionEventEnvelope<T>): void {
    index.byEventId.set(envelope.eventId, envelope)

    let session = index.bySession.get(envelope.sessionId)
    if (!session) {
        session = new Map()
        index.bySession.set(envelope.sessionId, session)
    }
    session.set(envelope.seq, envelope)
    index.lastSeq.set(envelope.sessionId, Math.max(index.lastSeq.get(envelope.sessionId) ?? 0, envelope.seq))
}

export function assertEnvelope(value: unknown): asserts value is SessionEventEnvelope<unknown> {
    if (!value || typeof value !== 'object') {
        throw new TypeError('Conversation event envelope must be an object')
    }

    const envelope = value as Partial<SessionEventEnvelope<unknown>>
    if (
        envelope.schemaVersion !== 1
        || !isNonEmptyString(envelope.gatewayId)
        || !isNonEmptyString(envelope.projectId)
        || !isNonEmptyString(envelope.sessionId)
        || !Number.isSafeInteger(envelope.seq)
        || (envelope.seq ?? 0) < 1
        || !isNonEmptyString(envelope.eventId)
        || !isNonEmptyString(envelope.timestamp)
        || !Object.prototype.hasOwnProperty.call(envelope, 'event')
    ) {
        throw new TypeError('Invalid conversation event envelope')
    }
}

export function assertCanAppendSequence<T>(index: EventIndex<T>, envelope: SessionEventEnvelope<T>): void {
    const lastSeq = index.lastSeq.get(envelope.sessionId) ?? 0
    if (envelope.seq <= lastSeq) {
        throw new Error(
            `Sequence ${envelope.seq} is not greater than the last sequence ${lastSeq} for session ${envelope.sessionId}`,
        )
    }
}

export function listFromIndex<T>(
    index: EventIndex<T>,
    sessionId: string,
    options: ListConversationEventsOptions = {},
): ConversationEventPage<T> {
    const after = options.after ?? 0
    const limit = options.limit ?? 100
    if (!Number.isSafeInteger(after) || after < 0) {
        throw new RangeError('after must be a non-negative safe integer')
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new RangeError('limit must be a positive safe integer')
    }

    const matching = [...(index.bySession.get(sessionId)?.values() ?? [])]
        .filter((event) => event.seq > after)
        .sort((left, right) => left.seq - right.seq)
    const events = matching.slice(0, limit)

    return {
        events,
        cursor: events.at(-1)?.seq ?? after,
        hasMore: matching.length > events.length,
    }
}

export function cloneEnvelope<T>(envelope: SessionEventEnvelope<T>): SessionEventEnvelope<T> {
    return structuredClone(envelope)
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0
}
