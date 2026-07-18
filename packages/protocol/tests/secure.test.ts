import { describe, expect, it } from 'vitest'
import {
    parseGatewaySecureHandshakeFrame,
    parseRelaySecureAuthAcceptedPayload,
    parseSecureDataFrame,
} from '../src/secure'

describe('secure transport protocol', () => {
    it('accepts bounded OPAQUE handshake frames', () => {
        expect(parseGatewaySecureHandshakeFrame({
            version: 1,
            type: 'gateway.secure-auth.start',
            messageId: 'message-1',
            payload: {
                gatewayId: 'gateway-1',
                mode: 'pairing',
                subjectId: 'ABC234',
                startLoginRequest: 'opaque-request',
                natsPublicKey: `U${'A'.repeat(55)}`,
            },
        }).type).toBe('gateway.secure-auth.start')
    })

    it('keeps accepted connection data inside an encrypted envelope', () => {
        const frame = parseGatewaySecureHandshakeFrame({
            version: 1,
            type: 'relay.secure-auth.accepted',
            messageId: 'message-2',
            payload: {
                handshakeId: 'handshake-1',
                envelope: { version: 2, channelId: 'channel-1', messageId: 'record-1', nonce: 'A'.repeat(16), ciphertext: 'A'.repeat(32) },
            },
        })
        expect(JSON.stringify(frame)).not.toContain('connectionEpoch')
        expect(() => parseRelaySecureAuthAcceptedPayload({
            gatewayId: 'gateway-1', acceptedAt: new Date().toISOString(),
            natsUserJwt: `${'a'.repeat(40)}.${'b'.repeat(80)}.${'c'.repeat(64)}`,
            natsUrl: 'tls://relay.test:4222',
        })).not.toThrow()
    })

    it('rejects plaintext application frames on the secure data schema', () => {
        expect(() => parseSecureDataFrame({
            version: 1,
            type: 'secure.data',
            messageId: 'message-3',
            gatewayId: 'gateway-1',
            envelope: { version: 2, channelId: 'channel-1', messageId: 'record-1', nonce: 'A'.repeat(16), ciphertext: 'A'.repeat(32) },
        })).toThrow()
    })

})
