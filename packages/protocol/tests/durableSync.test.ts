import { describe, expect, it } from 'vitest'
import {
    clientConsumerName,
    clientEventsSubject,
    clientInventorySubject,
    clientResponsesSubject,
    gatewayCommandsSubject,
    gatewayConsumerName,
    gatewayPairingRequestsSubject,
    parseDurableCommandEnvelope,
    parseDurablePairingRequestEnvelope,
    parseDurablePairingResponseEnvelope,
} from '../src/index'

describe('durable synchronization subjects', () => {
    it('builds deterministic, permission-friendly subjects and durable names', () => {
        expect(gatewayCommandsSubject('gateway_123')).toBe('cv.v1.gateway.gateway_123.commands')
        expect(clientResponsesSubject('device_456')).toBe('cv.v1.client.device_456.responses')
        expect(clientEventsSubject('device_456')).toBe('cv.v1.client.device_456.events')
        expect(clientInventorySubject('device_456', 'gateway_123'))
            .toBe('cv.v1.client.device_456.inventory.gateway_123')
        expect(gatewayPairingRequestsSubject('gateway_123'))
            .toBe('cv.v1.gateway.gateway_123.pairing.requests')
        expect(gatewayConsumerName('gateway_123')).toBe('gateway_gateway_123')
        expect(clientConsumerName('device_456', 'events')).toBe('client_device_456_events')
        expect(clientConsumerName('device_456', 'inventory')).toBe('client_device_456_inventory')
    })

    it('rejects subject injection', () => {
        expect(() => gatewayCommandsSubject('gateway.*')).toThrow(/gatewayId/)
        expect(() => clientResponsesSubject('device.>')).toThrow(/credentialId/)
    })
})

describe('retryable pairing envelopes', () => {
    const request = {
        version: 1 as const,
        kind: 'codever.pairing.request' as const,
        messageId: 'pair-step-1',
        pairingSessionId: 'pair-session-1',
        gatewayId: 'gateway_123',
        credentialId: 'device_456',
        createdAt: '2026-07-18T00:00:00.000Z',
        opaquePayload: 'opaque-step',
    }

    it('correlates every response to a retry-stable request message', () => {
        expect(parseDurablePairingRequestEnvelope(request)).toEqual(request)
        expect(parseDurablePairingResponseEnvelope({
            ...request,
            kind: 'codever.pairing.response',
            messageId: 'pair-response-1',
            inReplyTo: request.messageId,
        }).inReplyTo).toBe(request.messageId)
    })

    it('does not permit an injected reply subject', () => {
        expect(() => parseDurablePairingRequestEnvelope({ ...request, replySubject: 'attacker.>' })).toThrow()
    })
})

describe('durable command envelope', () => {
    it('keeps routing metadata visible while treating the application body as opaque', () => {
        const command = parseDurableCommandEnvelope({
            version: 1,
            kind: 'codever.command',
            messageId: 'message-1',
            commandId: 'command-1',
            gatewayId: 'gateway_123',
            credentialId: 'device_456',
            createdAt: '2026-07-18T00:00:00.000Z',
            expiresAt: '2026-07-18T00:03:00.000Z',
            opaquePayload: 'relay-cannot-read-this',
        })
        expect(command.opaquePayload).toBe('relay-cannot-read-this')
        expect(command.commandId).toBe('command-1')
    })

    it('rejects unknown routing fields', () => {
        expect(() => parseDurableCommandEnvelope({
            version: 1,
            kind: 'codever.command',
            messageId: 'message-1',
            commandId: 'command-1',
            gatewayId: 'gateway_123',
            credentialId: 'device_456',
            createdAt: '2026-07-18T00:00:00.000Z',
            opaquePayload: 'ciphertext',
            replySubject: 'attacker.subject',
        })).toThrow()
    })
})
