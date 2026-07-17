import { describe, expect, it } from 'vitest'
import { parseGatewayFrame } from '../src/index'

const base = {
    version: 1,
    messageId: 'message-1',
    gatewayId: 'gateway-1',
    connectionEpoch: 'epoch-1',
} as const

describe('secure-only Gateway frame union', () => {
    it('accepts only control metadata and opaque device tunnels', () => {
        expect(parseGatewayFrame({
            ...base,
            type: 'gateway.heartbeat',
            payload: { sentAt: '2026-07-16T10:00:00.000Z', uptimeMs: 1000 },
        }).type).toBe('gateway.heartbeat')
        expect(parseGatewayFrame({
            ...base,
            type: 'device.tunnel.data',
            payload: { tunnelId: 'tunnel-1', opaquePayload: 'ZW5jcnlwdGVk' },
        }).type).toBe('device.tunnel.data')
    })

    it.each(['gateway.inventory.snapshot', 'session.event.batch', 'command.request', 'sync.request'])(
        'rejects removed plaintext frame %s',
        type => expect(() => parseGatewayFrame({ ...base, type, payload: {} })).toThrow(),
    )

    it('rejects extra routing metadata that belongs inside E2EE', () => {
        expect(() => parseGatewayFrame({
            ...base,
            sessionId: 'session-1',
            type: 'gateway.heartbeat',
            payload: { sentAt: '2026-07-16T10:00:00.000Z', uptimeMs: 1000 },
        })).toThrow()
    })
})
