import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NewConversationEvent, SessionEventEnvelope } from '../conversationEventStore'
import { FileConversationEventStore } from '../fileConversationEventStore'
import { MemoryConversationEventStore } from '../memoryConversationEventStore'

interface TestEvent {
    text: string
}

const temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
        recursive: true,
        force: true,
    })))
})

describe.each([
    ['memory', async () => new MemoryConversationEventStore<TestEvent>()],
    ['file', async () => {
        const directory = await makeTemporaryDirectory()
        return new FileConversationEventStore<TestEvent>(join(directory, 'events.jsonl'))
    }],
] as const)('%s ConversationEventStore', (_name, createStore) => {
    it('allocates monotonic sequences independently per session', async () => {
        const store = await createStore()

        const [first, second, otherSession] = await Promise.all([
            store.append(makeEvent('event-1', 'session-a')),
            store.append(makeEvent('event-2', 'session-a')),
            store.append(makeEvent('event-3', 'session-b')),
        ])

        expect([first.seq, second.seq, otherSession.seq]).toEqual([1, 2, 1])
        await store.close()
    })

    it('deduplicates identical retries by eventId and by session sequence', async () => {
        const store = await createStore()
        const original = await store.append(makeEvent('event-1', 'session-a'))

        const byEventId = await store.append(makeEvent('event-1', 'session-a'))
        const bySequence = await store.appendEnvelope(original)

        expect(byEventId).toEqual(original)
        expect(bySequence).toEqual(original)
        expect((await store.list('session-a')).events).toEqual([original])
        await store.close()
    })

    it('rejects conflicting idempotency and sequence collisions', async () => {
        const store = await createStore()
        await store.append(makeEvent('event-1', 'session-a'))

        await expect(store.append({
            ...makeEvent('event-1', 'session-b'),
            event: { text: 'different payload' },
        })).rejects.toThrow('Conflicting eventId')
        await expect(store.appendEnvelope({
            ...envelope('event-2', 'session-a', 1),
            event: { text: 'another payload' },
        })).rejects.toThrow('Conflicting sequence')
        await store.close()
    })

    it('lists from an exclusive cursor with bounded pages', async () => {
        const store = await createStore()
        for (let index = 1; index <= 5; index += 1) {
            await store.append(makeEvent(`event-${index}`, 'session-a'))
        }

        const firstPage = await store.list('session-a', { after: 1, limit: 2 })
        const secondPage = await store.list('session-a', { after: firstPage.cursor, limit: 2 })

        expect(firstPage.events.map((event) => event.seq)).toEqual([2, 3])
        expect(firstPage).toMatchObject({ cursor: 3, hasMore: true })
        expect(secondPage.events.map((event) => event.seq)).toEqual([4, 5])
        expect(secondPage).toMatchObject({ cursor: 5, hasMore: false })
        await store.close()
    })

    it('rejects a new non-monotonic explicit sequence without poisoning later appends', async () => {
        const store = await createStore()
        await store.appendEnvelope(envelope('event-2', 'session-a', 2))

        await expect(store.appendEnvelope(envelope('event-1', 'session-a', 1))).rejects.toThrow(
            'is not greater than the last sequence',
        )
        await expect(store.append(makeEvent('event-3', 'session-a'))).resolves.toMatchObject({ seq: 3 })
        await store.close()
    })
})

describe('FileConversationEventStore recovery', () => {
    it('serializes concurrent appends and recovers sequence allocation after reopen', async () => {
        const directory = await makeTemporaryDirectory()
        const filePath = join(directory, 'events.jsonl')
        const store = new FileConversationEventStore<TestEvent>(filePath)

        const appended = await Promise.all(Array.from({ length: 20 }, (_, index) => (
            store.append(makeEvent(`event-${index}`, 'session-a'))
        )))
        await store.close()

        expect(appended.map((event) => event.seq)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
        expect((await readFile(filePath, 'utf8')).trim().split('\n')).toHaveLength(20)

        const reopened = new FileConversationEventStore<TestEvent>(filePath)
        await expect(reopened.append(makeEvent('event-20', 'session-a'))).resolves.toMatchObject({ seq: 21 })
        expect((await reopened.list('session-a', { after: 18 })).events.map((event) => event.seq)).toEqual([19, 20, 21])
        await reopened.close()
    })

    it('discards a torn trailing write and continues from the last durable record', async () => {
        const directory = await makeTemporaryDirectory()
        const filePath = join(directory, 'events.jsonl')
        const durable = envelope('event-1', 'session-a', 1)
        await writeFile(filePath, `${JSON.stringify(durable)}\n{"schemaVersion":1,"eventId":`, 'utf8')

        const store = new FileConversationEventStore<TestEvent>(filePath)
        await expect(store.append(makeEvent('event-2', 'session-a'))).resolves.toMatchObject({ seq: 2 })
        await store.close()

        const lines = (await readFile(filePath, 'utf8')).trim().split('\n')
        expect(lines).toHaveLength(2)
        expect(lines.map((line) => JSON.parse(line).seq)).toEqual([1, 2])
    })

    it('fails recovery for corruption in a completed journal record', async () => {
        const directory = await makeTemporaryDirectory()
        const filePath = join(directory, 'events.jsonl')
        await writeFile(filePath, `${JSON.stringify(envelope('event-1', 'session-a', 1))}\nnot-json\n`, 'utf8')

        const store = new FileConversationEventStore<TestEvent>(filePath)
        await expect(store.list('session-a')).rejects.toThrow('journal record at line 2')
        await store.close().catch(() => undefined)
    })
})

function makeEvent(eventId: string, sessionId: string): NewConversationEvent<TestEvent> {
    return {
        gatewayId: 'gateway-1',
        projectId: 'project-1',
        sessionId,
        eventId,
        timestamp: '2026-07-16T10:00:00.000Z',
        event: { text: eventId },
    }
}

function envelope(eventId: string, sessionId: string, seq: number): SessionEventEnvelope<TestEvent> {
    return {
        ...makeEvent(eventId, sessionId),
        schemaVersion: 1,
        seq,
    }
}

async function makeTemporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'codever-event-store-'))
    temporaryDirectories.push(directory)
    return directory
}
