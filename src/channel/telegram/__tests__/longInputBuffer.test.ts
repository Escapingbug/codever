import { describe, expect, it } from 'vitest'
import { LongInputBuffer, type LongInputScope } from '@/channel/telegram/longInputBuffer'

describe('Telegram long input buffer', () => {
    const scope: LongInputScope = { topicKey: '-100:10', userId: 42 }

    it('collects chunks and reads them as one prompt without adding separators', () => {
        const buffer = new LongInputBuffer()

        expect(buffer.begin(scope, 1000).status).toBe('started')
        expect(buffer.append(scope, 'hello ', { now: 1001, messageId: 1 }).status).toBe('appended')
        expect(buffer.append(scope, 'world', { now: 1002, messageId: 2 }).status).toBe('appended')

        const result = buffer.read(scope, 1003)
        expect(result).toEqual(expect.objectContaining({
            status: 'ready',
            text: 'hello world',
        }))
        if (result.status === 'ready') {
            expect(result.stats).toEqual({
                partCount: 2,
                totalChars: 11,
                startedAt: 1000,
                updatedAt: 1002,
            })
        }
    })

    it('keeps drafts isolated by topic and user', () => {
        const buffer = new LongInputBuffer()
        const otherUser = { topicKey: '-100:10', userId: 7 }
        const otherTopic = { topicKey: '-100:11', userId: 42 }

        buffer.begin(scope, 1000)
        buffer.begin(otherUser, 1000)
        buffer.begin(otherTopic, 1000)
        buffer.append(scope, 'a', { now: 1001 })
        buffer.append(otherUser, 'b', { now: 1001 })
        buffer.append(otherTopic, 'c', { now: 1001 })

        expect(buffer.read(scope, 1002)).toEqual(expect.objectContaining({ status: 'ready', text: 'a' }))
        expect(buffer.read(otherUser, 1002)).toEqual(expect.objectContaining({ status: 'ready', text: 'b' }))
        expect(buffer.read(otherTopic, 1002)).toEqual(expect.objectContaining({ status: 'ready', text: 'c' }))
    })

    it('rejects chunks that would exceed the character limit without losing collected text', () => {
        const buffer = new LongInputBuffer({ maxChars: 5 })

        buffer.begin(scope, 1000)
        expect(buffer.append(scope, '1234', { now: 1001 }).status).toBe('appended')
        const rejected = buffer.append(scope, '56', { now: 1002 })

        expect(rejected).toEqual(expect.objectContaining({
            status: 'too_large',
            maxChars: 5,
            attemptedChars: 6,
        }))
        expect(buffer.read(scope, 1003)).toEqual(expect.objectContaining({
            status: 'ready',
            text: '1234',
        }))
    })

    it('expires inactive drafts', () => {
        const buffer = new LongInputBuffer({ ttlMs: 10 })

        buffer.begin(scope, 1000)
        buffer.append(scope, 'stale', { now: 1005 })

        expect(buffer.read(scope, 1016)).toEqual({ status: 'expired' })
        expect(buffer.read(scope, 1017)).toEqual({ status: 'inactive' })
    })

    it('cancels active drafts', () => {
        const buffer = new LongInputBuffer()

        buffer.begin(scope, 1000)
        buffer.append(scope, 'discard me', { now: 1001 })

        const cancelled = buffer.cancel(scope, 1002)
        expect(cancelled).toEqual(expect.objectContaining({ status: 'cancelled' }))
        expect(buffer.read(scope, 1003)).toEqual({ status: 'inactive' })
    })
})
