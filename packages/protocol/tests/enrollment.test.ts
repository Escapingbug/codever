import { describe, expect, it } from 'vitest'
import {
    parseApproveGatewayEnrollmentDto,
    parseGatewayEnrollmentChallengeRequest,
    parseGatewayEnrollmentDto,
} from '../src'

describe('Gateway enrollment DTOs', () => {
    it('publishes strict public-key-only enrollment input', () => {
        const value = parseGatewayEnrollmentChallengeRequest({
            gatewayId: 'gateway-1', workspaceId: 'home', name: 'Desktop', platform: 'windows',
            algorithm: 'ECDSA-P256-SHA256', fingerprint: `sha256:${'a'.repeat(43)}`,
            publicKeySpkiPem: '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n',
        })
        expect(value.name).toBe('Desktop')
        expect(() => parseGatewayEnrollmentChallengeRequest({ ...value, privateKey: 'forbidden' })).toThrow()
        expect(() => parseGatewayEnrollmentChallengeRequest({ ...value, publicKeySpkiPem: 'PRIVATE KEY' })).toThrow()
    })

    it('requires unambiguous eight-character codes and explicit approval metadata', () => {
        const pending = parseGatewayEnrollmentDto({
            enrollmentId: 'e1', code: 'ABC23456', gatewayId: 'g1', workspaceId: 'home', name: 'Linux',
            platform: 'linux', fingerprint: `sha256:${'b'.repeat(43)}`, status: 'pending',
            createdAt: '2026-07-16T00:00:00.000Z', expiresAt: '2026-07-16T00:10:00.000Z',
        })
        expect(pending.code).toBe('ABC23456')
        expect(() => parseGatewayEnrollmentDto({ ...pending, code: 'ABC10OIL' })).toThrow()
        expect(parseApproveGatewayEnrollmentDto({ fingerprint: pending.fingerprint, name: 'Linux', platform: 'linux' })).toBeTruthy()
    })
})
