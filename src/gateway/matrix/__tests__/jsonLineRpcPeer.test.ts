import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { JsonLineRpcPeer } from '../jsonLineRpcPeer'

describe('JsonLineRpcPeer', () => {
    it('matches concurrent responses by ID and forwards notifications', async () => {
        const incoming = new PassThrough()
        const outgoing = new PassThrough()
        const peer = new JsonLineRpcPeer(incoming, outgoing, 1_000)
        const notification = vi.fn()
        peer.onNotification(notification)
        const first = peer.request<{ value: number }>('first')
        const second = peer.request<{ value: number }>('second')
        const requests = await readLines(outgoing, 2)
        const firstRequest = JSON.parse(requests[0])
        const secondRequest = JSON.parse(requests[1])

        incoming.write(`${JSON.stringify({ id: secondRequest.id, result: { value: 2 } })}\n`)
        incoming.write(`${JSON.stringify({ method: 'event', params: { roomId: '!room:test' } })}\n`)
        incoming.write(`${JSON.stringify({ id: firstRequest.id, result: { value: 1 } })}\n`)

        await expect(first).resolves.toEqual({ value: 1 })
        await expect(second).resolves.toEqual({ value: 2 })
        expect(notification).toHaveBeenCalledWith({ method: 'event', params: { roomId: '!room:test' } })
        peer.close()
    })

    it('rejects pending work when the native process closes', async () => {
        const incoming = new PassThrough()
        const peer = new JsonLineRpcPeer(incoming, new PassThrough(), 1_000)
        const pending = peer.request('status')
        incoming.end()
        await expect(pending).rejects.toThrow('IPC closed')
    })
})

async function readLines(stream: PassThrough, count: number): Promise<string[]> {
    let buffer = ''
    return new Promise(resolve => {
        stream.on('data', chunk => {
            buffer += chunk.toString()
            const lines = buffer.trim().split('\n')
            if (lines.length >= count) resolve(lines.slice(0, count))
        })
    })
}
