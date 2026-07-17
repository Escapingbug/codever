import { describe, expect, it } from 'vitest'
import { parseDeviceCredentialFrame, parseDeviceSecureHandshakeFrame } from '../src/index'

const frame = (type: string, payload: unknown) => ({
    version: 1,
    type,
    messageId: 'message-1',
    payload,
})

describe('device secure authentication protocol', () => {
    it('parses the complete client and Gateway OPAQUE handshake', () => {
        expect(parseDeviceSecureHandshakeFrame(frame('client.secure-auth.start', {
            mode: 'pairing', credentialId: 'device-1', subjectId: 'pairing-1', startLoginRequest: 'opaque-start',
        })).type).toBe('client.secure-auth.start')
        expect(parseDeviceSecureHandshakeFrame(frame('gateway.secure-auth.response', {
            gatewayId: 'gateway-1', handshakeId: 'handshake-1', loginResponse: 'opaque-response',
            expiresAt: '2026-07-17T10:00:00+08:00', attemptsRemaining: 2,
        })).type).toBe('gateway.secure-auth.response')
        expect(parseDeviceSecureHandshakeFrame(frame('client.secure-auth.finish', {
            handshakeId: 'handshake-1', finishLoginRequest: 'opaque-finish',
        })).type).toBe('client.secure-auth.finish')
        expect(parseDeviceSecureHandshakeFrame(frame('gateway.secure-auth.accepted', {
            handshakeId: 'handshake-1',
            envelope: { version: 1, channelId: 'channel-1', sequence: '0', ciphertext: 'A'.repeat(16) },
        })).type).toBe('gateway.secure-auth.accepted')
        expect(parseDeviceSecureHandshakeFrame(frame('gateway.secure-auth.rejected', {
            code: 'authentication_failed', message: 'bad credential',
        })).type).toBe('gateway.secure-auth.rejected')
    })

    it('parses encrypted device credential registration messages', () => {
        expect(parseDeviceCredentialFrame(frame('device.credential.registration.start', {
            deviceId: 'device-1', registrationRequest: 'registration-request',
        })).type).toBe('device.credential.registration.start')
        expect(parseDeviceCredentialFrame(frame('device.credential.registration.response', {
            deviceId: 'device-1', registrationResponse: 'registration-response',
            serverStaticPublicKey: 'A'.repeat(16),
        })).type).toBe('device.credential.registration.response')
        expect(parseDeviceCredentialFrame(frame('device.credential.registration.commit', {
            deviceId: 'device-1', registrationRecord: 'registration-record',
        })).type).toBe('device.credential.registration.commit')
        expect(parseDeviceCredentialFrame(frame('device.credential.registration.accepted', {
            deviceId: 'device-1', registeredAt: '2026-07-17T10:00:00+08:00',
        })).type).toBe('device.credential.registration.accepted')
    })

    it('rejects malformed, unknown, and non-strict handshake frames', () => {
        expect(() => parseDeviceSecureHandshakeFrame(frame('client.secure-auth.start', {
            mode: 'password', credentialId: 'device-1', subjectId: 'device-1', startLoginRequest: 'request',
        }))).toThrow()
        expect(() => parseDeviceSecureHandshakeFrame(frame('gateway.secure-auth.response', {
            gatewayId: 'gateway-1', handshakeId: 'handshake-1', loginResponse: '',
            expiresAt: 'not-a-date', attemptsRemaining: -1,
        }))).toThrow()
        expect(() => parseDeviceSecureHandshakeFrame({
            ...frame('client.secure-auth.finish', {
                handshakeId: 'handshake-1', finishLoginRequest: 'request',
            }),
            extra: true,
        })).toThrow()
        expect(() => parseDeviceSecureHandshakeFrame(frame('client.secure-auth.unknown', {}))).toThrow()
    })

    it('rejects plaintext, incomplete, and oversized credential messages', () => {
        expect(() => parseDeviceCredentialFrame(frame('device.credential.registration.start', {
            deviceId: 'device-1', registrationRequest: 'request', plaintextSecret: 'secret',
        }))).toThrow()
        expect(() => parseDeviceCredentialFrame(frame('device.credential.registration.response', {
            deviceId: 'device-1', registrationResponse: 'response', serverStaticPublicKey: 'short',
        }))).toThrow()
        expect(() => parseDeviceCredentialFrame(frame('device.credential.registration.commit', {
            deviceId: 'device-1', registrationRecord: 'A'.repeat(16_385),
        }))).toThrow()
        expect(() => parseDeviceCredentialFrame(frame('device.credential.registration.accepted', {
            deviceId: 'device-1',
        }))).toThrow()
    })
})
