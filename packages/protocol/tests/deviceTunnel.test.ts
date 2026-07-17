import { describe, expect, it } from 'vitest'
import {
    parseClientDeviceTunnelFrame,
    parseClientDeviceTunnelRequestFrame,
    parseDeviceTunnelFrame,
    parseGatewayDeviceTunnelFrame,
    parseGatewayFrame,
    parseRelayDeviceTunnelFrame,
} from '../src/index'

const clientFrame = (type: string, payload: unknown) => ({
    version: 1,
    type,
    messageId: 'message-1',
    payload,
})

const gatewayFrame = (type: string, payload: unknown) => ({
    version: 1,
    type,
    messageId: 'message-1',
    gatewayId: 'gateway-1',
    connectionEpoch: 'epoch-1',
    payload,
})

describe('device tunnel client and relay frames', () => {
    it('parses each client frame', () => {
        expect(parseClientDeviceTunnelRequestFrame(clientFrame('device.tunnel.open', { gatewayId: 'gateway-1' })).type)
            .toBe('device.tunnel.open')
        expect(parseClientDeviceTunnelFrame(clientFrame('device.tunnel.data', {
            tunnelId: 'tunnel-1',
            opaquePayload: 'SGVsbG8td29ybGQ_',
        })).type).toBe('device.tunnel.data')
        expect(parseClientDeviceTunnelFrame(clientFrame('device.tunnel.close', {
            tunnelId: 'tunnel-1',
            reason: 'finished',
        })).type).toBe('device.tunnel.close')
    })

    it('parses each relay frame and every close code', () => {
        expect(parseRelayDeviceTunnelFrame(clientFrame('relay.device-tunnel.opened', {
            gatewayId: 'gateway-1',
            tunnelId: 'tunnel-1',
            openedAt: '2026-07-17T10:00:00+08:00',
        })).type)
            .toBe('relay.device-tunnel.opened')
        expect(parseRelayDeviceTunnelFrame(clientFrame('relay.device-tunnel.data', {
            tunnelId: 'tunnel-1',
            opaquePayload: 'AA-_',
        })).type).toBe('relay.device-tunnel.data')

        for (const code of ['normal', 'gateway_offline', 'gateway_replaced', 'unauthorized', 'protocol_error']) {
            expect(parseRelayDeviceTunnelFrame(clientFrame('relay.device-tunnel.closed', {
                tunnelId: 'tunnel-1',
                code,
            })).payload).toMatchObject({ code })
        }
    })

    it('exports a parser for the combined client/relay union', () => {
        expect(parseDeviceTunnelFrame(clientFrame('relay.device-tunnel.closed', {
            tunnelId: 'tunnel-1',
            code: 'normal',
        })).type).toBe('relay.device-tunnel.closed')
    })

    it('rejects unknown and extra fields at every level', () => {
        expect(() => parseDeviceTunnelFrame({
            ...clientFrame('device.tunnel.open', { gatewayId: 'gateway-1' }),
            gatewayId: 'not-part-of-the-client-envelope',
        })).toThrow()
        expect(() => parseDeviceTunnelFrame(clientFrame('device.tunnel.open', {
            gatewayId: 'gateway-1',
            extra: true,
        }))).toThrow()
        expect(() => parseDeviceTunnelFrame(clientFrame('relay.device-tunnel.closed', {
            tunnelId: 'tunnel-1',
            code: 'unknown',
        }))).toThrow()
    })

    it('rejects malformed opaque payloads and enforces its bounds', () => {
        for (const opaquePayload of ['', 'abc=', 'abc+', 'abc/', 'hello world']) {
            expect(() => parseDeviceTunnelFrame(clientFrame('device.tunnel.data', {
                tunnelId: 'tunnel-1',
                opaquePayload,
            }))).toThrow()
        }

        expect(parseDeviceTunnelFrame(clientFrame('device.tunnel.data', {
            tunnelId: 'tunnel-1',
            opaquePayload: 'A'.repeat(262_144),
        })).payload).toHaveProperty('opaquePayload')
        expect(() => parseDeviceTunnelFrame(clientFrame('device.tunnel.data', {
            tunnelId: 'tunnel-1',
            opaquePayload: 'A'.repeat(262_145),
        }))).toThrow()
    })
})

describe('gateway device tunnel frames', () => {
    it('parses open, data, and close in the GatewayFrame union', () => {
        expect(parseGatewayFrame(gatewayFrame('device.tunnel.open', {
            tunnelId: 'tunnel-1',
            openedAt: '2026-07-17T10:00:00+08:00',
        })).type).toBe('device.tunnel.open')
        expect(parseGatewayFrame(gatewayFrame('device.tunnel.data', {
            tunnelId: 'tunnel-1',
            opaquePayload: 'AQID',
        })).type).toBe('device.tunnel.data')
        expect(parseGatewayFrame(gatewayFrame('device.tunnel.close', {
            tunnelId: 'tunnel-1',
            reason: 'gateway shutdown',
            code: 'gateway_offline',
        })).type).toBe('device.tunnel.close')
        expect(parseGatewayDeviceTunnelFrame(gatewayFrame('device.tunnel.data', {
            tunnelId: 'tunnel-1',
            opaquePayload: 'AQID',
        })).type).toBe('device.tunnel.data')
    })

    it('rejects invalid gateway tunnel payloads', () => {
        expect(() => parseGatewayFrame(gatewayFrame('device.tunnel.open', {
            tunnelId: 'tunnel-1',
        }))).toThrow()
        expect(() => parseGatewayFrame(gatewayFrame('device.tunnel.open', {
            tunnelId: 'tunnel-1',
            openedAt: 'not-a-date',
        }))).toThrow()
        expect(() => parseGatewayFrame(gatewayFrame('device.tunnel.data', {
            tunnelId: 'tunnel-1',
            opaquePayload: 'not base64url',
        }))).toThrow()
        expect(() => parseGatewayFrame(gatewayFrame('device.tunnel.close', {
            tunnelId: 'tunnel-1',
            code: 'not-a-close-code',
        }))).toThrow()
        expect(() => parseGatewayFrame(gatewayFrame('device.tunnel.close', {
            tunnelId: 'tunnel-1',
            extra: true,
        }))).toThrow()
    })
})
