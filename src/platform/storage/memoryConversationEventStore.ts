import type {
    ConversationEventPage,
    ConversationEventStore,
    ListConversationEventsOptions,
    NewConversationEvent,
    SessionEventEnvelope,
} from './conversationEventStore'
import {
    addToIndex,
    assertCanAppendSequence,
    assertEnvelope,
    cloneEnvelope,
    createEventIndex,
    findDuplicate,
    findDuplicateNew,
    listFromIndex,
} from './storeSupport'

export class MemoryConversationEventStore<T = unknown> implements ConversationEventStore<T> {
    private readonly index = createEventIndex<T>()
    private mutationQueue: Promise<void> = Promise.resolve()

    async append(event: NewConversationEvent<T>): Promise<SessionEventEnvelope<T>> {
        return this.serializeMutation(() => {
            const duplicate = findDuplicateNew(this.index, event)
            if (duplicate) return cloneEnvelope(duplicate)

            const envelope: SessionEventEnvelope<T> = {
                ...event,
                schemaVersion: 1,
                seq: (this.index.lastSeq.get(event.sessionId) ?? 0) + 1,
            }
            return this.appendEnvelopeNow(envelope)
        })
    }

    async appendEnvelope(event: SessionEventEnvelope<T>): Promise<SessionEventEnvelope<T>> {
        return this.serializeMutation(() => this.appendEnvelopeNow(event))
    }

    async list(
        sessionId: string,
        options?: ListConversationEventsOptions,
    ): Promise<ConversationEventPage<T>> {
        await this.mutationQueue
        const page = listFromIndex(this.index, sessionId, options)
        return { ...page, events: page.events.map(cloneEnvelope) }
    }

    async close(): Promise<void> {
        await this.mutationQueue
    }

    private appendEnvelopeNow(event: SessionEventEnvelope<T>): SessionEventEnvelope<T> {
        const envelope = cloneEnvelope(event)
        assertEnvelope(envelope)
        const duplicate = findDuplicate(this.index, envelope)
        if (duplicate) return cloneEnvelope(duplicate)

        assertCanAppendSequence(this.index, envelope)
        addToIndex(this.index, envelope)
        return cloneEnvelope(envelope)
    }

    private serializeMutation<R>(operation: () => R | Promise<R>): Promise<R> {
        const result = this.mutationQueue.then(operation)
        this.mutationQueue = result.then(() => undefined, () => undefined)
        return result
    }
}
