import { describe, expect, it } from 'vitest'
import {
    parseClientRelayGatewaysRequestFrame,
    parseClientRelaySecureDataPayload,
    parseRelayClientAuthAcceptedPayload,
    parseRelayClientSecureControlFrame,
    parseRelayClientSecureHandshakeFrame,
    parseRelayClientCredentialRegistrationFrame,
    parseRelayClientGatewaysResponseFrame,
} from '../src/index'

const frame = (type: string, payload: unknown) => ({
    version: 1,
    type,
    messageId: 'message-1',
    payload,
})

describe('relay client secure protocol', () => {
    it('parses the complete client and Relay OPAQUE authentication handshake', () => {
        expect(parseRelayClientSecureHandshakeFrame(frame('client.relay-auth.start', {
            mode: 'pairing',
            credentialId: 'credential-1',
            subjectId: 'pairing-1',
            startLoginRequest: 'opaque-start',
        })).type).toBe('client.relay-auth.start')
        expect(parseRelayClientSecureHandshakeFrame(frame('relay.client-auth.response', {
            relayId: 'relay-1',
            handshakeId: 'handshake-1',
            loginResponse: 'opaque-response',
            expiresAt: '2026-07-17T10:00:00+08:00',
            attemptsRemaining: 2,
        })).type).toBe('relay.client-auth.response')
        expect(parseRelayClientSecureHandshakeFrame(frame('client.relay-auth.finish', {
            handshakeId: 'handshake-1',
            finishLoginRequest: 'opaque-finish',
        })).type).toBe('client.relay-auth.finish')
        expect(parseRelayClientSecureHandshakeFrame(frame('relay.client-auth.accepted', {
            handshakeId: 'handshake-1',
            envelope: { version: 2, channelId: 'channel-1', messageId: 'record-1', nonce: 'A'.repeat(16), ciphertext: 'A'.repeat(16) },
        })).type).toBe('relay.client-auth.accepted')
        expect(parseRelayClientSecureHandshakeFrame(frame('relay.client-auth.rejected', {
            code: 'authentication_failed',
            message: 'bad credential',
        })).type).toBe('relay.client-auth.rejected')
    })

    it('keeps accepted details in a strict encrypted payload', () => {
        expect(parseRelayClientAuthAcceptedPayload({
            relayId: 'relay-1',
            credentialId: 'credential-1',
            acceptedAt: '2026-07-17T10:00:00+08:00',
            provisioningRequired: true,
        }).provisioningRequired).toBe(true)
        expect(() => parseRelayClientAuthAcceptedPayload({
            relayId: 'relay-1',
            credentialId: 'credential-1',
            acceptedAt: '2026-07-17T10:00:00+08:00',
            provisioningRequired: true,
            accessToken: 'plaintext-token',
        })).toThrow()
    })

    it('parses all encrypted client credential registration control frames', () => {
        expect(parseRelayClientCredentialRegistrationFrame(frame('client.credential.registration.start', {
            credentialId: 'credential-1',
            registrationRequest: 'opaque-registration-request',
        })).type).toBe('client.credential.registration.start')
        expect(parseRelayClientCredentialRegistrationFrame(frame('relay.client-credential.registration.response', {
            credentialId: 'credential-1',
            registrationResponse: 'opaque-registration-response',
            serverStaticPublicKey: 'A'.repeat(16),
        })).type).toBe('relay.client-credential.registration.response')
        expect(parseRelayClientCredentialRegistrationFrame(frame('client.credential.registration.commit', {
            credentialId: 'credential-1',
            registrationRecord: 'opaque-registration-record',
        })).type).toBe('client.credential.registration.commit')
        expect(parseRelayClientCredentialRegistrationFrame(frame('relay.client-credential.registration.accepted', {
            credentialId: 'credential-1',
            registeredAt: '2026-07-17T10:00:00+08:00',
        })).type).toBe('relay.client-credential.registration.accepted')
    })

    it('parses correlated gateway discovery frames with strict Gateway entries', () => {
        expect(parseClientRelayGatewaysRequestFrame({
            version: 1,
            type: 'client.relay.gateways.request',
            requestId: 'request-1',
        }).requestId).toBe('request-1')
        const response = parseRelayClientGatewaysResponseFrame({
            version: 1,
            type: 'relay.client.gateways.response',
            requestId: 'request-1',
            gateways: [{
                id: 'gateway-1',
                workspaceId: 'workspace-1',
                name: 'Local gateway',
                platform: 'linux',
                version: '1.0.0',
                capabilities: { protocolVersions: [1], providers: ['cursor'], features: ['tunnel'] },
                status: 'online',
                lastSeenAt: '2026-07-17T10:00:00+08:00',
            }],
        })
        expect(response.gateways[0]?.id).toBe('gateway-1')
    })

    it('directly reuses tunnel requests as decrypted secure.data payloads', () => {
        expect(parseClientRelaySecureDataPayload(frame('device.tunnel.open', {
            gatewayId: 'gateway-1',
        })).type).toBe('device.tunnel.open')
        expect(parseClientRelaySecureDataPayload({
            version: 1,
            type: 'client.relay.gateways.request',
            requestId: 'request-1',
        }).type).toBe('client.relay.gateways.request')
    })

    it('rejects unknown, malformed, oversized, and non-strict frames', () => {
        expect(() => parseRelayClientSecureHandshakeFrame(frame('client.relay-auth.start', {
            mode: 'password',
            credentialId: 'credential-1',
            subjectId: 'subject-1',
            startLoginRequest: 'opaque-start',
        }))).toThrow()
        expect(() => parseRelayClientSecureHandshakeFrame(frame('relay.client-auth.response', {
            relayId: 'relay-1',
            handshakeId: 'handshake-1',
            loginResponse: '',
            expiresAt: 'not-a-date',
            attemptsRemaining: -1,
        }))).toThrow()
        expect(() => parseRelayClientSecureHandshakeFrame({
            ...frame('client.relay-auth.finish', {
                handshakeId: 'handshake-1',
                finishLoginRequest: 'opaque-finish',
            }),
            extra: true,
        })).toThrow()
        expect(() => parseRelayClientSecureHandshakeFrame(frame('relay.client-auth.unknown', {}))).toThrow()
        expect(() => parseRelayClientCredentialRegistrationFrame(frame('client.credential.registration.commit', {
            credentialId: 'credential-1',
            registrationRecord: 'A'.repeat(16_385),
        }))).toThrow()
        expect(() => parseRelayClientSecureControlFrame({
            version: 1,
            type: 'client.relay.gateways.request',
            requestId: 'request-1',
            gateways: [],
        })).toThrow()
        expect(() => parseRelayClientGatewaysResponseFrame({
            version: 1,
            type: 'relay.client.gateways.response',
            requestId: 'request-1',
            gateways: [{ id: 'gateway-1', name: 'Broken', status: 'invalid' }],
        })).toThrow()
    })
})
