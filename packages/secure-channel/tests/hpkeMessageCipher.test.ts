import { describe, expect, it } from 'vitest'
import { generateHpkeKeyPair, HpkeMessageCipher, SecureChannelError } from '../src'

describe('HpkeMessageCipher', () => {
    it('authenticates both device identities and decrypts messages independently', async () => {
        const clientKeys = await generateHpkeKeyPair()
        const gatewayKeys = await generateHpkeKeyPair()
        const client = await HpkeMessageCipher.create({
            localId: 'client-1', remoteId: 'gateway-1', localKeyPair: clientKeys, remoteKey: gatewayKeys,
        })
        const gateway = await HpkeMessageCipher.create({
            localId: 'gateway-1', remoteId: 'client-1', localKeyPair: gatewayKeys, remoteKey: clientKeys,
        })

        const first = await client.encrypt({ requestId: 'request-1', prompt: 'private prompt' })
        const second = await client.encrypt({ requestId: 'request-2', prompt: 'later prompt' })
        expect(JSON.stringify(first)).not.toContain('private prompt')
        await expect(gateway.decrypt(second)).resolves.toMatchObject({ requestId: 'request-2' })
        await expect(gateway.decrypt(first)).resolves.toMatchObject({ requestId: 'request-1' })
        await expect(gateway.decrypt(first)).resolves.toMatchObject({ requestId: 'request-1' })

        const response = await gateway.encrypt({ requestId: 'request-2', answer: 'private answer' })
        await expect(client.decrypt(response)).resolves.toEqual({ requestId: 'request-2', answer: 'private answer' })
    })

    it('rejects sender substitution, recipient substitution, tampering, and expiration', async () => {
        let now = Date.parse('2026-07-17T00:00:00.000Z')
        const clientKeys = await generateHpkeKeyPair()
        const gatewayKeys = await generateHpkeKeyPair()
        const attackerKeys = await generateHpkeKeyPair()
        const client = await HpkeMessageCipher.create({
            localId: 'client-1', remoteId: 'gateway-1', localKeyPair: clientKeys,
            remoteKey: gatewayKeys, now: () => now, ttlMs: 1_000,
        })
        const gateway = await HpkeMessageCipher.create({
            localId: 'gateway-1', remoteId: 'client-1', localKeyPair: gatewayKeys,
            remoteKey: clientKeys, now: () => now,
        })
        const attackerGateway = await HpkeMessageCipher.create({
            localId: 'gateway-1', remoteId: 'client-1', localKeyPair: gatewayKeys,
            remoteKey: attackerKeys, now: () => now,
        })
        const envelope = await client.encrypt({ protected: true })

        await expect(attackerGateway.decrypt(envelope)).rejects.toThrow('identity mismatch')
        await expect(gateway.decrypt({ ...envelope, recipientId: 'gateway-2' })).rejects.toThrow('identity mismatch')
        const ciphertext = Buffer.from(envelope.ciphertext, 'base64url')
        ciphertext[0] = ciphertext[0]! ^ 1
        await expect(gateway.decrypt({ ...envelope, ciphertext: ciphertext.toString('base64url') }))
            .rejects.toBeInstanceOf(SecureChannelError)
        now += 1_001
        await expect(gateway.decrypt(envelope)).rejects.toThrow('expired')
    })
})
