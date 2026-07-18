import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, type ClientGatewayRequestFrame } from '@codever/protocol'
import { consumeConcurrently, requestUsesDurableLedger } from '../jetstreamGatewayWorker'

describe('Gateway JetStream command liveness', () => {
    it('does not let one paused command prevent a later command from running', async () => {
        const first = deferred<void>()
        const second = deferred<void>()
        const loop = consumeConcurrently(values('slow', 'cancel'), 2, async value => {
            if (value === 'slow') await first.promise
            else second.resolve()
        })

        await expect(second.promise).resolves.toBeUndefined()
        first.resolve()
        await loop
    })

    it('does not persist replayable read responses in the mutation ledger', () => {
        expect(requestUsesDurableLedger(frame({ kind: 'events.list', sessionId: 'session-1', limit: 20 }))).toBe(false)
        expect(requestUsesDurableLedger(frame({
            kind: 'session.cancel', sessionId: 'session-1', input: { reason: 'stop' },
        }))).toBe(true)
    })
})

function frame(payload: ClientGatewayRequestFrame['payload']): ClientGatewayRequestFrame {
    return {
        version: PROTOCOL_VERSION,
        type: 'client.gateway.request',
        requestId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        payload,
    }
}

async function* values(...items: string[]): AsyncIterable<string> {
    yield* items
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    const promise = new Promise<T>(settle => { resolve = settle })
    return { promise, resolve }
}
