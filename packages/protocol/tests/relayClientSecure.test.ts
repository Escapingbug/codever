import { describe, expect, it } from 'vitest'
import {
    parseRelayClientAuthAcceptedPayload,
    parseRelayClientSecureHandshakeFrame,
} from '../src/index'

const jwt = `${'a'.repeat(40)}.${'b'.repeat(80)}.${'c'.repeat(64)}`
const frame = (type: string, payload: unknown) => ({ version: 1, type, messageId: 'message-1', payload })

describe('one-time Relay client provisioning', () => {
    it('binds a client-generated NKey public key to the OPAQUE pairing start', () => {
        expect(parseRelayClientSecureHandshakeFrame(frame('client.relay-auth.start', {
            mode: 'pairing', credentialId: 'credential-1', subjectId: 'pairing-1',
            startLoginRequest: 'opaque-start', natsPublicKey: `U${'A'.repeat(55)}`,
        })).type).toBe('client.relay-auth.start')
        expect(() => parseRelayClientSecureHandshakeFrame(frame('client.relay-auth.start', {
            mode: 'credential', credentialId: 'credential-1', subjectId: 'credential-1',
            startLoginRequest: 'opaque-start', natsPublicKey: `U${'A'.repeat(55)}`,
        }))).toThrow()
    })

    it('keeps the signed NATS credential inside the OPAQUE-derived encrypted acceptance', () => {
        expect(parseRelayClientAuthAcceptedPayload({
            relayId: 'relay-1', credentialId: 'credential-1', acceptedAt: '2026-07-17T10:00:00+08:00',
            natsUserJwt: jwt, natsWebSocketUrl: 'wss://relay.example.test/nats',
        })).toMatchObject({ natsUserJwt: jwt })
    })
})
