import { generateKeyPairSync } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import { GatewayIdentity } from '../../../src/gateway/identity'
import { EcdsaP256GatewayAuthenticator } from '../src/auth'

describe('ECDSA gateway authentication', () => {
    it('verifies an enrolled P-256 key signature and rejects tampering', async () => {
        const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        const identity = GatewayIdentity.fromPrivateKeyPem(privateKey.export({ type: 'pkcs8', format: 'pem' }))
        const enrollment = identity.enrollmentBundle()
        const challenge = {
            relayId: 'relay-1',
            challengeId: 'challenge-1',
            nonce: 'abcdefghijklmnopqrstuvwxyz1234567890',
            issuedAt: '2026-07-16T10:00:00.000Z',
            expiresAt: '2026-07-16T10:00:30.000Z',
        }
        const signed = identity.signRelayChallenge({ version: 1, ...challenge }, 'gateway-1')
        const authenticator = new EcdsaP256GatewayAuthenticator({
            async get(gatewayId, requestedFingerprint) {
                return gatewayId === 'gateway-1' && requestedFingerprint === enrollment.fingerprint
                    ? {
                        gatewayId,
                        fingerprint: enrollment.fingerprint,
                        publicKey: enrollment.publicKeySpkiPem,
                        enabled: true,
                    }
                    : undefined
            },
        })
        const request = {} as FastifyRequest

        await expect(authenticator.verify({
            request,
            challenge,
            response: {
                gatewayId: 'gateway-1',
                algorithm: signed.algorithm,
                fingerprint: signed.fingerprint,
                signature: signed.signature,
            },
        })).resolves.toEqual({ authenticated: true })

        await expect(authenticator.verify({
            request,
            challenge: { ...challenge, nonce: `${challenge.nonce}tampered` },
            response: {
                gatewayId: 'gateway-1',
                algorithm: signed.algorithm,
                fingerprint: signed.fingerprint,
                signature: signed.signature,
            },
        })).resolves.toMatchObject({ authenticated: false, code: 'invalid_signature' })
    })
})
