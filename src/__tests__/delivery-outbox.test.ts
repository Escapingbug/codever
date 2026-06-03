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
})
