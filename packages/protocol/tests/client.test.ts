import { describe, expect, it } from 'vitest'
import { parseEnrollGatewayDto, parseMutationReceiptDto, parseSendMessageDto } from '../src/index'

describe('client resource DTO schemas', () => {
    it('accepts public-only Gateway enrollment payloads', () => {
        expect(parseEnrollGatewayDto({
            name: 'workstation',
            identity: {
                version: 1,
                algorithm: 'ECDSA-P256-SHA256',
                fingerprint: 'sha256:abc',
                publicKeySpkiPem: '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n',
            },
        }).name).toBe('workstation')
    })

    it('parses mutation requests and lifecycle receipts', () => {
        expect(parseSendMessageDto({ text: 'hello', sendWhenOnline: true })).toEqual({
            text: 'hello', sendWhenOnline: true,
        })
        expect(parseMutationReceiptDto({
            commandId: 'command-1', status: 'gateway_accepted', acceptedAt: '2026-07-16T10:00:00.000Z',
        }).status).toBe('gateway_accepted')
    })

    it('rejects non-JSON decision payloads', () => {
        expect(() => parseSendMessageDto({ text: '' })).toThrow()
    })
})
