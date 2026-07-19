import { describe, expect, it } from 'vitest'
import {
    ExecutionAuthorizationError,
    InMemoryExecutionReplayGuard,
    generateExecutionKeyPair,
    signExecutionToken,
    verifyExecutionToken,
} from '../src'

const NOW = Date.parse('2026-07-19T04:00:00.000Z')
const request = {
    version: 1,
    type: 'client.gateway.request',
    requestId: 'request-1',
    idempotencyKey: 'message-1',
    payload: { kind: 'session.message', sessionId: 'session-1', input: { text: 'continue' } },
}

describe('COSE/CWT execution authorization', () => {
    it('authorizes an exact request for the intended Gateway', async () => {
        const key = await generateExecutionKeyPair()
        const replayGuard = new InMemoryExecutionReplayGuard(() => NOW)
        const token = await tokenFor(key)

        const verified = await verifyExecutionToken({
            token,
            request,
            gatewayId: 'gateway-windows',
            operation: 'session.message',
            resolvePublicKey: async keyId => keyId === key.keyId ? key.publicKey : undefined,
            replayGuard,
            now: () => NOW,
        })

        expect(verified.keyId).toBe(key.keyId)
        expect(verified.claims.subject).toBe('phone-device')
        expect(verified.replay).toBe('first-seen')
    })

    it('allows transport redelivery only as an idempotent duplicate', async () => {
        const key = await generateExecutionKeyPair()
        const replayGuard = new InMemoryExecutionReplayGuard(() => NOW)
        const token = await tokenFor(key)
        const input = {
            token,
            request,
            gatewayId: 'gateway-windows',
            operation: 'session.message',
            resolvePublicKey: async () => key.publicKey,
            replayGuard,
            now: () => NOW,
        }

        expect((await verifyExecutionToken(input)).replay).toBe('first-seen')
        expect((await verifyExecutionToken(input)).replay).toBe('duplicate')
    })

    it('accepts bounded machine clock skew but not an unbounded token lifetime', async () => {
        const key = await generateExecutionKeyPair()
        const token = await tokenFor(key)
        const base = {
            token,
            request,
            gatewayId: 'gateway-windows',
            operation: 'session.message',
            resolvePublicKey: async () => key.publicKey,
        }
        await expect(verifyExecutionToken({
            ...base,
            replayGuard: new InMemoryExecutionReplayGuard(() => NOW + 135_000),
            now: () => NOW + 135_000,
        })).resolves.toMatchObject({ replay: 'first-seen' })
        await expectCode(verifyExecutionToken({
            ...base,
            replayGuard: new InMemoryExecutionReplayGuard(() => NOW + 300_000),
            now: () => NOW + 300_000,
        }), 'expired')
    })

    it.each([
        ['another Gateway', { gatewayId: 'gateway-attacker', operation: 'session.message', request }, 'wrong_audience'],
        ['another operation', { gatewayId: 'gateway-windows', operation: 'session.cancel', request }, 'operation_denied'],
        ['a modified request', { gatewayId: 'gateway-windows', operation: 'session.message', request: { ...request, idempotencyKey: 'message-2' } }, 'request_mismatch'],
    ])('rejects %s', async (_name, overrides, code) => {
        const key = await generateExecutionKeyPair()
        const token = await tokenFor(key)
        await expectCode(verifyExecutionToken({
            token,
            resolvePublicKey: async () => key.publicKey,
            replayGuard: new InMemoryExecutionReplayGuard(() => NOW),
            now: () => NOW,
            ...overrides,
        }), code)
    })

    it('rejects a token altered by a compromised transport', async () => {
        const key = await generateExecutionKeyPair()
        const token = await tokenFor(key)
        const bytes = Buffer.from(token, 'base64url')
        bytes[bytes.length - 1] ^= 1
        await expectCode(verifyExecutionToken({
            token: bytes.toString('base64url'),
            request,
            gatewayId: 'gateway-windows',
            operation: 'session.message',
            resolvePublicKey: async () => key.publicKey,
            replayGuard: new InMemoryExecutionReplayGuard(() => NOW),
            now: () => NOW,
        }), 'invalid_signature')
    })

    it('rejects expired and revoked credentials', async () => {
        const key = await generateExecutionKeyPair()
        const token = await tokenFor(key)
        await expectCode(verifyExecutionToken({
            token,
            request,
            gatewayId: 'gateway-windows',
            operation: 'session.message',
            resolvePublicKey: async () => key.publicKey,
            replayGuard: new InMemoryExecutionReplayGuard(() => NOW + 600_000),
            now: () => NOW + 600_000,
        }), 'expired')
        await expectCode(verifyExecutionToken({
            token,
            request,
            gatewayId: 'gateway-windows',
            operation: 'session.message',
            resolvePublicKey: async () => undefined,
            replayGuard: new InMemoryExecutionReplayGuard(() => NOW),
            now: () => NOW,
        }), 'unknown_key')
    })
})

async function tokenFor(key: Awaited<ReturnType<typeof generateExecutionKeyPair>>): Promise<string> {
    return signExecutionToken({
        request,
        gatewayId: 'gateway-windows',
        issuer: 'codever-control:owner',
        subject: 'phone-device',
        operation: 'session.message',
        keyId: key.keyId,
        privateKey: key.privateKey,
        now: () => NOW,
        tokenId: 'MDEyMzQ1Njc4OWFiY2RlZg',
    })
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
    try {
        await promise
        throw new Error('Expected execution authorization to fail')
    } catch (error) {
        expect(error).toBeInstanceOf(ExecutionAuthorizationError)
        expect((error as ExecutionAuthorizationError).code).toBe(code)
    }
}
