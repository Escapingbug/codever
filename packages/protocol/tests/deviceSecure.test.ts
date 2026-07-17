import { describe, expect, it } from 'vitest'
import {
    parseDeviceBindingFrame,
    parseDeviceHpkeDataFrame,
    parseDeviceKeyProvisioningFrame,
    parseDeviceSecureHandshakeFrame,
} from '../src/index'

const frame = (type: string, payload: unknown) => ({ version: 1, type, messageId: 'message-1', payload })
const key = 'A'.repeat(43)

describe('device security protocol', () => {
    it('parses the one-time OPAQUE pairing handshake', () => {
        expect(parseDeviceSecureHandshakeFrame(frame('client.secure-auth.start', {
            credentialId: 'device-1', pairingId: 'pairing-1', startLoginRequest: 'opaque-start',
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
            envelope: {
                version: 2, channelId: 'channel-1', messageId: 'record-1', nonce: 'A'.repeat(16), ciphertext: 'A'.repeat(16),
            },
        })).type).toBe('gateway.secure-auth.accepted')
    })

    it('parses key provisioning without a long-term password credential', () => {
        expect(parseDeviceKeyProvisioningFrame(frame('device.key.register', {
            deviceId: 'device-1', deviceHpkeKeyId: 'key-device', deviceHpkePublicKey: key,
        })).type).toBe('device.key.register')
        expect(parseDeviceKeyProvisioningFrame(frame('gateway.key.registered', {
            deviceId: 'device-1', gatewayHpkeKeyId: 'key-gateway', gatewayHpkePublicKey: key,
            registeredAt: '2026-07-17T10:00:00+08:00',
        })).type).toBe('gateway.key.registered')
    })

    it('parses HPKE bind and encrypted data frames', () => {
        expect(parseDeviceBindingFrame(frame('device.bind', {
            gatewayId: 'gateway-1', credentialId: 'device-1', boundAt: '2026-07-17T10:00:00+08:00',
        })).type).toBe('device.bind')
        expect(parseDeviceHpkeDataFrame({
            version: 1,
            type: 'device.hpke-data',
            messageId: 'message-1',
            envelope: {
                version: 1,
                suite: 'DHKEM_X25519_HKDF_SHA256_HKDF_SHA256_AES_128_GCM',
                messageId: 'message-1', senderId: 'device-1', recipientId: 'gateway-1',
                senderKeyId: 'key-device', recipientKeyId: 'key-gateway',
                createdAt: '2026-07-17T10:00:00+08:00', expiresAt: '2026-07-18T10:00:00+08:00',
                enc: key, ciphertext: 'A'.repeat(16),
            },
        }).type).toBe('device.hpke-data')
    })

    it('rejects credential login and malformed key registration', () => {
        expect(() => parseDeviceSecureHandshakeFrame(frame('client.secure-auth.start', {
            mode: 'credential', credentialId: 'device-1', subjectId: 'device-1', startLoginRequest: 'request',
        }))).toThrow()
        expect(() => parseDeviceKeyProvisioningFrame(frame('device.key.register', {
            deviceId: 'device-1', deviceHpkeKeyId: 'key-device', deviceHpkePublicKey: 'short',
        }))).toThrow()
    })
})
