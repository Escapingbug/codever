import { describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { ClientConnectionRegistry } from '../src/clientConnectionRegistry'
import { DeviceTunnelRegistry } from '../src/deviceTunnelRegistry'

describe('secure connection cleanup', () => {
    it('replaces only the previous socket for the same Client credential', () => {
        const registry = new ClientConnectionRegistry()
        const first = socket()
        const second = socket()
        registry.replace({ clientId: 'client-1', sessionId: 'session-1', socket: first })
        expect(registry.replace({ clientId: 'client-1', sessionId: 'session-2', socket: second }))
            .toMatchObject({ sessionId: 'session-1' })
        expect(first.close).toHaveBeenCalledWith(4001, 'Replaced by a newer Client connection')
        expect(registry.removeIfCurrent('client-1', 'session-1', first)).toBe(false)
        expect(registry.get('client-1')?.sessionId).toBe('session-2')
    })

    it('removes every tunnel owned by a disconnected Client session', () => {
        const registry = new DeviceTunnelRegistry()
        const send = vi.fn()
        const first = registry.open('gateway-1', 'session-1', send)
        const second = registry.open('gateway-2', 'session-1', send)
        registry.open('gateway-1', 'session-2', send)

        expect(registry.removeOwner('session-1')).toEqual([
            { gatewayId: 'gateway-1', tunnelId: first },
            { gatewayId: 'gateway-2', tunnelId: second },
        ])
        expect(registry.send('gateway-1', first, 'b3BhcXVl')).toBe(false)
    })
})

function socket(): WebSocket {
    return { close: vi.fn() } as unknown as WebSocket
}
