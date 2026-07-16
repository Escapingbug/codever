import { afterEach, describe, expect, it, vi } from 'vitest'
import { DecisionBroker } from '../decisionBroker'
import type { GatewayDecisionEvent, GatewayDecisionRequest } from '../events'

afterEach(() => {
    vi.useRealTimers()
})

describe('DecisionBroker', () => {
    it('atomically accepts the first authorized valid response', async () => {
        const events: GatewayDecisionEvent[] = []
        const broker = new DecisionBroker({
            publish: async (event) => { events.push(event) },
            createId: () => 'decision-1',
        })
        const handle = await broker.open(request({ allowedResponderIds: ['operator-1'] }))

        await expect(broker.respond(handle.decisionId, 'allow', 'viewer-1')).resolves.toEqual({ status: 'unauthorized' })
        await expect(broker.respond(handle.decisionId, 'missing', 'operator-1')).resolves.toEqual({ status: 'invalid_option' })

        const [winner, loser] = await Promise.all([
            broker.respond(handle.decisionId, 'allow', 'operator-1'),
            broker.respond(handle.decisionId, 'deny', 'operator-1'),
        ])

        expect(winner).toMatchObject({ status: 'accepted', resolution: { value: 'allow' } })
        expect(loser).toEqual({ status: 'already_resolved' })
        await expect(handle.result).resolves.toMatchObject({ status: 'resolved', value: 'allow' })
        expect(events.map((event) => event.phase)).toEqual(['requested', 'resolved'])
    })

    it('expires and cancels decisions fail-closed', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-07-16T10:00:00.000Z'))
        let nextId = 0
        const events: GatewayDecisionEvent[] = []
        const broker = new DecisionBroker({
            publish: async (event) => { events.push(event) },
            defaultExpiryMs: 50,
            createId: () => `decision-${++nextId}`,
        })

        const expiring = await broker.open(request())
        await vi.advanceTimersByTimeAsync(50)
        await expect(expiring.result).resolves.toMatchObject({ status: 'expired' })
        await expect(broker.respond(expiring.decisionId, 'allow')).resolves.toEqual({ status: 'expired' })

        const cancelled = await broker.open(request())
        await expect(broker.cancel(cancelled.decisionId, 'turn ended')).resolves.toBe(true)
        await expect(cancelled.result).resolves.toMatchObject({ status: 'cancelled', reason: 'turn ended' })
        await expect(broker.respond(cancelled.decisionId, 'allow')).resolves.toEqual({ status: 'cancelled' })
        expect(events.map((event) => event.phase)).toEqual([
            'requested',
            'expired',
            'requested',
            'cancelled',
        ])
    })

    it('does not expose a decision when durable publication fails', async () => {
        const broker = new DecisionBroker({
            publish: async () => { throw new Error('storage unavailable') },
            createId: () => 'decision-1',
        })

        await expect(broker.open(request())).rejects.toThrow('storage unavailable')
        expect(broker.pendingCount).toBe(0)
    })
})

function request(overrides: Partial<GatewayDecisionRequest> = {}): GatewayDecisionRequest {
    return {
        type: 'permission',
        title: 'Allow tool?',
        options: [
            { id: 'allow', label: 'Allow', value: 'allow' },
            { id: 'deny', label: 'Deny', value: 'deny' },
        ],
        ...overrides,
    }
}
