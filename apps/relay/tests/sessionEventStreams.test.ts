import type { SessionEventEnvelope } from '@codever/protocol'
import { InMemoryEventRepository } from '../src/memoryRepositories'
import type { EventAppendResult, EventRepository } from '../src/repositories'
import { SessionEventStreams, type EventStreamSocket } from '../src/sessionEventStreams'
import { describe, expect, it } from 'vitest'

class TestSocket implements EventStreamSocket {
    readyState = 1
    bufferedAmount = 0
    readonly sent: string[] = []
    readonly closes: Array<{ code?: number; reason?: string }> = []

    send(data: string, callback?: (error?: Error) => void): void {
        this.sent.push(data)
        callback?.()
    }

    close(code?: number, reason?: string): void {
        this.readyState = 3
        this.closes.push({ code, reason })
    }
}

describe('SessionEventStreams', () => {
    it('replays after the cursor and fans out newly appended events once', async () => {
        const repository = new InMemoryEventRepository()
        await repository.append([event(1), event(2)])
        const streams = new SessionEventStreams(repository)
        const socket = new TestSocket()

        streams.subscribe('session-1', 1, socket)
        await eventually(() => socket.sent.length === 1)
        expect(sentSequences(socket)).toEqual([2])

        await repository.append([event(3)])
        streams.publish(['session-1', 'session-1'])
        await eventually(() => socket.sent.length === 2)
        expect(sentSequences(socket)).toEqual([2, 3])
    })

    it('delivers monotonic events across intentional wire-sequence gaps', async () => {
        const repository = new InMemoryEventRepository()
        await repository.append([event(2)])
        const streams = new SessionEventStreams(repository)
        const socket = new TestSocket()

        streams.subscribe('session-1', 0, socket)
        await eventually(() => socket.sent.length === 1)
        expect(sentSequences(socket)).toEqual([2])

        await repository.append([event(4)])
        streams.publish(['session-1'])
        await eventually(() => socket.sent.length === 2)
        expect(sentSequences(socket)).toEqual([2, 4])
    })

    it('does not lose an event appended while the initial replay query is in flight', async () => {
        const repository = new PausedFirstReadRepository()
        const streams = new SessionEventStreams(repository)
        const socket = new TestSocket()

        streams.subscribe('session-1', 0, socket)
        await repository.firstReadStarted
        await repository.append([event(1)])
        streams.publish(['session-1'])
        repository.releaseFirstRead()

        await eventually(() => socket.sent.length === 1)
        expect(sentSequences(socket)).toEqual([1])
    })

    it('closes and removes a slow consumer before exceeding its byte budget', async () => {
        const repository = new InMemoryEventRepository()
        await repository.append([event(1)])
        const streams = new SessionEventStreams(repository, { maxBufferedBytes: 32 })
        const socket = new TestSocket()
        socket.bufferedAmount = 32

        streams.subscribe('session-1', 0, socket)
        await eventually(() => socket.closes.length === 1)

        expect(socket.closes[0]).toEqual({ code: 1013, reason: 'Event consumer is too slow' })
        expect(socket.sent).toEqual([])
        expect(streams.subscriberCount()).toBe(0)
    })

    it('rejects an oversized replay and releases retained subscriber state', async () => {
        const repository = new InMemoryEventRepository()
        await repository.append([event(1), event(2)])
        const streams = new SessionEventStreams(repository, { maxPendingEvents: 1 })
        const socket = new TestSocket()

        streams.subscribe('session-1', 0, socket)
        await eventually(() => socket.closes.length === 1)

        expect(socket.closes[0]).toEqual({ code: 1013, reason: 'Event cursor is too far behind' })
        expect(streams.subscriberCount('session-1')).toBe(0)
    })
})

class PausedFirstReadRepository implements EventRepository {
    private readonly repository = new InMemoryEventRepository()
    private readonly start: () => void
    private readonly release: () => void
    private first = true
    readonly firstReadStarted: Promise<void>
    private readonly firstReadReleased: Promise<void>

    constructor() {
        let start!: () => void
        let release!: () => void
        this.firstReadStarted = new Promise(resolve => { start = resolve })
        this.firstReadReleased = new Promise(resolve => { release = resolve })
        this.start = start
        this.release = release
    }

    append(events: SessionEventEnvelope[]): Promise<EventAppendResult> {
        return this.repository.append(events)
    }

    async listAfter(sessionId: string, after: number, limit?: number): Promise<SessionEventEnvelope[]> {
        if (!this.first) return this.repository.listAfter(sessionId, after, limit)
        this.first = false
        const snapshot = await this.repository.listAfter(sessionId, after, limit)
        this.start()
        await this.firstReadReleased
        return snapshot
    }

    highestSeq(sessionId: string): Promise<number> {
        return this.repository.highestSeq(sessionId)
    }

    releaseFirstRead(): void {
        this.release()
    }
}

function event(seq: number): SessionEventEnvelope {
    return {
        schemaVersion: 1,
        gatewayId: 'gateway-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        seq,
        eventId: `event-${seq}`,
        timestamp: new Date().toISOString(),
        event: { kind: 'user_message', text: `message ${seq}` },
    }
}

function sentSequences(socket: TestSocket): number[] {
    return socket.sent.map(value => {
        const frame = JSON.parse(value) as { type: 'session.event'; event: SessionEventEnvelope }
        expect(frame.type).toBe('session.event')
        return frame.event.seq
    })
}

async function eventually(check: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (check()) return
        await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('Condition was not met before timeout')
}
