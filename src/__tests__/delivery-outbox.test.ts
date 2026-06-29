import { describe, expect, it, vi } from 'vitest'
import { DeliveryOutbox } from '@/runtime/deliveryOutbox'
import type { ChannelPort, ChannelMessage } from '@/bridge/channelPort'

function createChannelPort(sent: string[]): ChannelPort {
    return {
        send: vi.fn(async (message: ChannelMessage) => {
            sent.push(message.text)
            return { messageId: sent.length }
        }),
        edit: vi.fn(async (_messageId, message: ChannelMessage) => {
            sent.push(`edit:${message.text}`)
        }),
        requestDecision: vi.fn(async () => ({ value: 'ok' })),
        notifyStatus: vi.fn(),
    }
}

describe('DeliveryOutbox', () => {
    it('serializes sends in enqueue order', async () => {
        const sent: string[] = []
        const outbox = new DeliveryOutbox({ channelPort: createChannelPort(sent) })

        void outbox.send({ text: 'first', format: 'plain' })
        void outbox.send({ text: 'second', format: 'plain' })
        await outbox.drain()

        expect(sent).toEqual(['first', 'second'])
        expect(outbox.list().map(r => r.status)).toEqual(['sent', 'sent'])
    })

    it('resolves deferred edits after earlier sends can publish message ids', async () => {
        const sent: string[] = []
        let messageId: number | undefined
        const outbox = new DeliveryOutbox({ channelPort: createChannelPort(sent) })

        void outbox.send({ text: 'tool started', format: 'html' }, (result) => {
            messageId = Number(result.messageId)
        })
        void outbox.editDeferred(() => messageId, { text: 'tool completed', format: 'html' })
        await outbox.drain()

        expect(sent).toEqual(['tool started', 'edit:tool completed'])
        expect(outbox.list().map(r => r.status)).toEqual(['sent', 'edited'])
    })

    it('falls back to send when an edit has no message id', async () => {
        const sent: string[] = []
        const outbox = new DeliveryOutbox({ channelPort: createChannelPort(sent) })

        await outbox.editDeferred(() => undefined, { text: 'fallback', format: 'html' })

        expect(sent).toEqual(['fallback'])
        expect(outbox.list()[0].status).toBe('sent')
    })

    it('waits for Telegram retry_after before retrying rate-limited sends', async () => {
        vi.useFakeTimers()
        try {
            const sent: string[] = []
            const channel = createChannelPort(sent)
            vi.mocked(channel.send).mockRejectedValueOnce(new Error("Call to 'sendMessage' failed! (429: Too Many Requests: retry after 34)"))
            const outbox = new DeliveryOutbox({ channelPort: channel })

            const delivery = outbox.send({ text: 'rate limited', format: 'plain' })
            await vi.advanceTimersByTimeAsync(34_000)
            const record = await delivery

            expect(record.status).toBe('sent')
            expect(channel.send).toHaveBeenCalledTimes(2)
            expect(sent).toEqual(['rate limited'])
        } finally {
            vi.useRealTimers()
        }
    })

    it('short-retries transient network send failures', async () => {
        vi.useFakeTimers()
        try {
            const sent: string[] = []
            const channel = createChannelPort(sent)
            vi.mocked(channel.send)
                .mockRejectedValueOnce(new Error("Network request for 'sendMessage' failed!"))
                .mockImplementation(async (message: ChannelMessage) => {
                    sent.push(message.text)
                    return { messageId: sent.length }
                })
            const outbox = new DeliveryOutbox({
                channelPort: channel,
                networkRetryBaseDelayMs: 10,
            })

            const delivery = outbox.send({ text: 'network recovered', format: 'plain' })
            await vi.advanceTimersByTimeAsync(10)
            const record = await delivery

            expect(record.status).toBe('sent')
            expect(channel.send).toHaveBeenCalledTimes(2)
            expect(sent).toEqual(['network recovered'])
        } finally {
            vi.useRealTimers()
        }
    })

    it('retains failed delivery text and marks it resolved after a successful retry', async () => {
        const sent: string[] = []
        const channel = createChannelPort(sent)
        vi.mocked(channel.send)
            .mockRejectedValueOnce(new Error("Network request for 'sendMessage' failed!"))
            .mockImplementation(async (message: ChannelMessage) => {
                sent.push(message.text)
                return { messageId: sent.length }
            })
        const outbox = new DeliveryOutbox({
            channelPort: channel,
            maxNetworkRetries: 0,
        })

        const failed = await outbox.send({ text: 'lost answer body', format: 'markdown' })
        expect(failed.status).toBe('failed')
        expect(outbox.find(failed.id)?.message.text).toBe('lost answer body')
        expect(outbox.getState().lastFailure).toContain(failed.id)

        const retry = await outbox.retry(failed.id)

        expect(retry).toMatchObject({ status: 'sent', retryOf: failed.id })
        expect(outbox.find(failed.id)?.resolvedBy).toBe(retry?.id)
        expect(outbox.getState().lastFailure).toBeUndefined()
        expect(sent).toEqual(['lost answer body'])
    })

    it('times out a stuck delivery and continues later sends', async () => {
        vi.useFakeTimers()
        try {
            const sent: string[] = []
            let calls = 0
            const channel = createChannelPort(sent)
            vi.mocked(channel.send).mockImplementation(async (message: ChannelMessage) => {
                calls += 1
                if (calls === 1) {
                    return await new Promise(() => {})
                }
                sent.push(message.text)
                return { messageId: calls }
            })
            const failures: string[] = []
            const outbox = new DeliveryOutbox({
                channelPort: channel,
                deliveryTimeoutMs: 100,
                onFailure: (record) => failures.push(record.error instanceof Error ? record.error.message : String(record.error)),
            })

            const stuck = outbox.send({ text: 'stuck', format: 'plain' })
            const next = outbox.send({ text: 'next', format: 'plain' })

            await vi.advanceTimersByTimeAsync(100)
            await expect(stuck).resolves.toMatchObject({ status: 'failed' })
            await expect(next).resolves.toMatchObject({ status: 'sent' })
            expect(sent).toEqual(['next'])
            expect(failures[0]).toContain('timed out')
        } finally {
            vi.useRealTimers()
        }
    })

    it('uses the attachment delivery timeout for queued file uploads', async () => {
        vi.useFakeTimers()
        try {
            const sent: string[] = []
            const channel = createChannelPort(sent)
            vi.mocked(channel.send).mockImplementation(async () => await new Promise(() => {}))
            const failures: string[] = []
            const outbox = new DeliveryOutbox({
                channelPort: channel,
                deliveryTimeoutMs: 100,
                attachmentDeliveryTimeoutMs: 500,
                onFailure: (record) => failures.push(record.error instanceof Error ? record.error.message : String(record.error)),
            })

            const { record, completion } = outbox.queueSend({
                text: 'large.apk',
                format: 'plain',
                attachments: [{ type: 'document', path: '/repo/large.apk', filename: 'large.apk' }],
            })

            expect(record.status).toBe('pending')
            await vi.advanceTimersByTimeAsync(100)
            expect(record.status).toBe('pending')

            await vi.advanceTimersByTimeAsync(400)
            await expect(completion).resolves.toMatchObject({ status: 'failed' })
            expect(failures[0]).toContain('500ms')
        } finally {
            vi.useRealTimers()
        }
    })

    it('does not let a rate-limited progressive edit block control sends', async () => {
        vi.useFakeTimers()
        try {
            const sent: string[] = []
            const channel = createChannelPort(sent)
            vi.mocked(channel.edit!).mockRejectedValueOnce(new Error("Call to 'editMessageText' failed! (429: Too Many Requests: retry after 40)"))
            const outbox = new DeliveryOutbox({ channelPort: channel })

            void outbox.edit(1, { text: 'streaming update', format: 'html' }, false, {
                lane: 'progressive-edit',
                coalesceKey: 'tool:1',
            })
            const control = outbox.send({ text: 'progress now', format: 'html' }, undefined, { lane: 'control' })

            await expect(control).resolves.toMatchObject({ status: 'sent' })
            expect(sent).toContain('progress now')
        } finally {
            vi.useRealTimers()
        }
    })

    it('coalesces pending progressive edits to the latest message', async () => {
        vi.useFakeTimers()
        try {
            const sent: string[] = []
            const channel = createChannelPort(sent)
            const outbox = new DeliveryOutbox({
                channelPort: channel,
                progressiveEditDebounceMs: 100,
            })

            void outbox.edit(1, { text: 'old update', format: 'html' }, false, {
                lane: 'progressive-edit',
                coalesceKey: 'tool:1',
            })
            void outbox.edit(1, { text: 'latest update', format: 'html' }, false, {
                lane: 'progressive-edit',
                coalesceKey: 'tool:1',
            })

            await vi.advanceTimersByTimeAsync(100)
            await outbox.drain()

            expect(sent).toEqual(['edit:latest update'])
            expect(outbox.list().map(record => record.status)).toEqual(['skipped', 'edited'])
        } finally {
            vi.useRealTimers()
        }
    })
})
