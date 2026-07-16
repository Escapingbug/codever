import { generateKeyPairSync, verify } from 'node:crypto'
import { createServer } from 'node:http'
import { serializeGatewayAuthPayload, type RelayAuthChallenge } from '@codever/protocol'
import { describe, expect, it } from 'vitest'
import { GatewayIdentity } from '../../identity'
import { ensureGatewayEnrollment } from '../gatewayEnrollmentClient'

describe('Gateway enrollment client', () => {
    it('sends only its public identity, signs the Relay challenge, and returns the code', async () => {
        const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        const identity = GatewayIdentity.fromPrivateKeyPem(privateKey.export({ type: 'pkcs8', format: 'pem' }))
        const challenge: RelayAuthChallenge = {
            relayId: 'relay-test', challengeId: 'challenge-1', nonce: 'n'.repeat(43),
            issuedAt: '2026-07-16T00:00:00.000Z', expiresAt: '2027-07-16T00:00:00.000Z',
        }
        let publicKey = ''
        const server = createServer((request, response) => {
            void readJson(request).then(body => {
                response.setHeader('content-type', 'application/json')
                if (request.url === '/v1/gateway-enrollments/challenge') {
                    expect(JSON.stringify(body)).not.toContain('PRIVATE KEY')
                    publicKey = String(body.publicKeySpkiPem)
                    response.end(JSON.stringify({ enrollmentId: 'enrollment-1', challenge }))
                    return
                }
                expect(request.url).toBe('/v1/gateway-enrollments/proof')
                expect(verify('sha256', serializeGatewayAuthPayload(challenge, 'gateway-1', identity.fingerprint), publicKey, Buffer.from(String(body.signature), 'base64url'))).toBe(true)
                response.statusCode = 201
                response.end(JSON.stringify({
                    enrollmentId: 'enrollment-1', code: 'ABC23456', gatewayId: 'gateway-1', workspaceId: 'home',
                    name: 'Desktop', platform: 'linux', fingerprint: identity.fingerprint, status: 'pending',
                    createdAt: '2026-07-16T00:00:00.000Z', expiresAt: '2026-07-16T00:10:00.000Z',
                }))
            })
        })
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Test server did not bind TCP')
        try {
            await expect(ensureGatewayEnrollment({
                relayWebSocketUrl: `ws://127.0.0.1:${address.port}/v1/gateway/connect`,
                gatewayId: 'gateway-1', workspaceId: 'home', name: 'Desktop', platform: 'linux', identity,
            })).resolves.toMatchObject({ status: 'pending', code: 'ABC23456' })
        } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
    })
})

function readJson(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        let body = ''
        request.setEncoding('utf8')
        request.on('data', chunk => { body += chunk })
        request.on('end', () => { try { resolve(JSON.parse(body)) } catch (error) { reject(error) } })
        request.on('error', reject)
    })
}
