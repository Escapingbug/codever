import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClientGatewayRequestFrame, ClientGatewayResponseFrame } from '@codever/protocol'
import { describe, expect, it, vi } from 'vitest'
import { GatewayRequestLedger } from '../requestLedger'

describe('GatewayRequestLedger', () => {
    it('executes concurrent retries once and maps the response to each request ID', async () => {
        const ledger = await createLedger()
        let executions = 0
        const gate = deferred<void>()
        const operation = async () => {
            executions += 1
            await gate.promise
            return completed('request-1')
        }
        const first = ledger.execute(request('request-1', 'same-key'), 'device-1', operation)
        const second = ledger.execute(request('request-2', 'same-key'), 'device-1', operation)
        gate.resolve()

        await expect(first).resolves.toMatchObject({ requestId: 'request-1', status: 'completed' })
        await expect(second).resolves.toMatchObject({ requestId: 'request-2', status: 'completed' })
        expect(executions).toBe(1)
    })

    it('replays a completed response after restart without executing again', async () => {
        const path = await ledgerPath()
        const first = await GatewayRequestLedger.open(path)
        await first.execute(request('request-1', 'durable-key'), 'device-1', async () => completed('request-1'))

        const restored = await GatewayRequestLedger.open(path)
        const operation = vi.fn(async () => completed('request-2'))
        await expect(restored.execute(request('request-2', 'durable-key'), 'device-1', operation))
            .resolves.toMatchObject({ requestId: 'request-2', status: 'completed' })
        expect(operation).not.toHaveBeenCalled()
    })

    it('rejects reuse of an idempotency key for a different payload', async () => {
        const ledger = await createLedger()
        await ledger.execute(request('request-1', 'conflict-key'), 'device-1', async () => completed('request-1'))
        const conflicting = { ...request('request-2', 'conflict-key'), payload: { kind: 'events.list', sessionId: 'session-1' } } as ClientGatewayRequestFrame

        await expect(ledger.execute(conflicting, 'device-1', async () => completed('request-2')))
            .resolves.toMatchObject({ status: 'failed', error: { code: 'idempotency_conflict' } })
    })

    it('rejects a conflicting payload while the original request is still running', async () => {
        const ledger = await createLedger()
        const gate = deferred<void>()
        const original = ledger.execute(
            request('request-1', 'running-key'),
            'device-1',
            async () => { await gate.promise; return completed('request-1') },
        )
        const conflicting = {
            ...request('request-2', 'running-key'),
            payload: { kind: 'events.list', sessionId: 'session-1' },
        } as ClientGatewayRequestFrame

        await expect(ledger.execute(conflicting, 'device-1', async () => completed('request-2')))
            .resolves.toMatchObject({ status: 'failed', error: { code: 'idempotency_conflict' } })
        gate.resolve()
        await original
    })

    it('does not re-execute an operation left pending by a previous process', async () => {
        const path = await ledgerPath()
        const first = await GatewayRequestLedger.open(path)
        void first.execute(request('request-1', 'pending-key'), 'device-1', () => new Promise(() => undefined))
        await vi.waitFor(async () => expect(await readFile(path, 'utf8')).toContain('"status": "pending"'))

        const restored = await GatewayRequestLedger.open(path)
        const operation = vi.fn(async () => completed('request-2'))
        await expect(restored.execute(request('request-2', 'pending-key'), 'device-1', operation))
            .resolves.toMatchObject({ status: 'failed', error: { code: 'idempotency_in_doubt' } })
        expect(operation).not.toHaveBeenCalled()
    })
})

async function createLedger(): Promise<GatewayRequestLedger> {
    return GatewayRequestLedger.open(await ledgerPath())
}

async function ledgerPath(): Promise<string> {
    return join(await mkdtemp(join(tmpdir(), 'codever-request-ledger-')), 'requests.json')
}

function request(requestId: string, idempotencyKey: string): ClientGatewayRequestFrame {
    return {
        version: 1,
        type: 'client.gateway.request',
        requestId,
        idempotencyKey,
        payload: { kind: 'inventory.get' },
    }
}

function completed(requestId: string): ClientGatewayResponseFrame {
    return {
        version: 1,
        type: 'gateway.client.response',
        requestId,
        status: 'completed',
        completedAt: new Date().toISOString(),
        payload: { generatedAt: new Date().toISOString(), revision: 1, projects: [], sessions: [] },
    }
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    const promise = new Promise<T>(res => { resolve = res })
    return { promise, resolve }
}
