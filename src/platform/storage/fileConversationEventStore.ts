import { mkdir, open, readFile, truncate, type FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
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

/** Durable JSON Lines event journal. One instance serializes all appends to its file. */
export class FileConversationEventStore<T = unknown> implements ConversationEventStore<T> {
    private readonly index = createEventIndex<T>()
    private mutationQueue: Promise<void> = Promise.resolve()
    private initialization?: Promise<void>
    private handle?: FileHandle
    private closed = false

    constructor(private readonly filePath: string) {}

    async append(event: NewConversationEvent<T>): Promise<SessionEventEnvelope<T>> {
        return this.serializeMutation(async () => {
            await this.initialize()
            const duplicate = findDuplicateNew(this.index, event)
            if (duplicate) return cloneEnvelope(duplicate)

            return this.appendEnvelopeNow({
                ...event,
                schemaVersion: 1,
                seq: (this.index.lastSeq.get(event.sessionId) ?? 0) + 1,
            })
        })
    }

    async appendMany(events: NewConversationEvent<T>[]): Promise<SessionEventEnvelope<T>[]> {
        return this.serializeMutation(async () => {
            await this.initialize()
            const results: SessionEventEnvelope<T>[] = []
            for (const event of events) {
                const duplicate = findDuplicateNew(this.index, event)
                if (duplicate) {
                    results.push(cloneEnvelope(duplicate))
                    continue
                }
                results.push(await this.appendEnvelopeNow({
                    ...event,
                    schemaVersion: 1,
                    seq: (this.index.lastSeq.get(event.sessionId) ?? 0) + 1,
                }, false))
            }
            if (events.length) await this.handle!.sync()
            return results
        })
    }

    async appendEnvelope(event: SessionEventEnvelope<T>): Promise<SessionEventEnvelope<T>> {
        return this.serializeMutation(async () => {
            await this.initialize()
            return this.appendEnvelopeNow(event)
        })
    }

    async list(
        sessionId: string,
        options?: ListConversationEventsOptions,
    ): Promise<ConversationEventPage<T>> {
        await this.mutationQueue
        await this.initialize()
        const page = listFromIndex(this.index, sessionId, options)
        return { ...page, events: page.events.map(cloneEnvelope) }
    }

    async close(): Promise<void> {
        await this.mutationQueue
        if (this.closed) return
        this.closed = true
        try {
            await this.initialization
        } finally {
            await this.handle?.close()
            this.handle = undefined
        }
    }

    private async initialize(): Promise<void> {
        if (this.closed) throw new Error('Conversation event store is closed')
        if (!this.initialization) {
            this.initialization = this.loadJournal()
        }
        await this.initialization
    }

    private async loadJournal(): Promise<void> {
        await mkdir(dirname(this.filePath), { recursive: true })
        this.handle = await open(this.filePath, 'a+')
        try {
            const contents = await readFile(this.filePath, 'utf8')
            if (contents.length === 0) return

            const lastNewline = contents.lastIndexOf('\n')
            const completePrefix = lastNewline === -1 ? '' : contents.slice(0, lastNewline + 1)
            const trailing = lastNewline === contents.length - 1 ? '' : contents.slice(lastNewline + 1)

            for (const [lineIndex, line] of completePrefix.split('\n').entries()) {
                if (!line) continue
                this.recoverLine(line, lineIndex + 1)
            }

            if (trailing) {
                try {
                    this.recoverLine(trailing, completePrefix.split('\n').length)
                    await this.handle.appendFile('\n', 'utf8')
                    await this.handle.sync()
                } catch {
                    await this.handle.close()
                    this.handle = undefined
                    await truncate(this.filePath, Buffer.byteLength(completePrefix, 'utf8'))
                    this.handle = await open(this.filePath, 'a+')
                }
            }
        } catch (error) {
            await this.handle?.close()
            this.handle = undefined
            throw error
        }
    }

    private recoverLine(line: string, lineNumber: number): void {
        let value: unknown
        try {
            value = JSON.parse(line)
            assertEnvelope(value)
        } catch (error) {
            throw new Error(`Invalid conversation event journal record at line ${lineNumber}`, { cause: error })
        }

        const envelope = value as SessionEventEnvelope<T>
        if (findDuplicate(this.index, envelope)) return
        assertCanAppendSequence(this.index, envelope)
        addToIndex(this.index, envelope)
    }

    private async appendEnvelopeNow(event: SessionEventEnvelope<T>, synchronize = true): Promise<SessionEventEnvelope<T>> {
        const candidate = cloneEnvelope(event)
        assertEnvelope(candidate)
        const duplicate = findDuplicate(this.index, candidate)
        if (duplicate) return cloneEnvelope(duplicate)

        assertCanAppendSequence(this.index, candidate)
        const serialized = JSON.stringify(candidate)
        if (serialized === undefined) throw new TypeError('Conversation event envelope is not JSON serializable')
        const persisted: unknown = JSON.parse(serialized)
        assertEnvelope(persisted)
        const envelope = persisted as SessionEventEnvelope<T>

        await this.handle!.appendFile(`${serialized}\n`, 'utf8')
        if (synchronize) await this.handle!.sync()
        addToIndex(this.index, envelope)
        return cloneEnvelope(envelope)
    }

    private serializeMutation<R>(operation: () => R | Promise<R>): Promise<R> {
        const result = this.mutationQueue.then(operation)
        this.mutationQueue = result.then(() => undefined, () => undefined)
        return result
    }
}
