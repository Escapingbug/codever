import { randomBytes, randomUUID, webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SecureChannelError, SessionCipher } from '../src/sessionCipher'

const crypto = webcrypto as unknown as Crypto

describe('SessionCipher', () => {
    it('encrypts in both directions without exposing plaintext', async () => {
        const sessionKey = randomBytes(32)
        const channelId = randomUUID()
        const initiator = await SessionCipher.create({ sessionKey, role: 'initiator', channelId, crypto })
        const responder = await SessionCipher.create({ sessionKey, role: 'responder', channelId, crypto })

        const request = await initiator.encrypt({ command: 'session.prompt', prompt: 'secret text' })
        expect(JSON.stringify(request)).not.toContain('secret text')
        await expect(responder.decrypt(request)).resolves.toEqual({ command: 'session.prompt', prompt: 'secret text' })

        const response = await responder.encrypt({ event: 'agent.message', text: 'private answer' })
        await expect(initiator.decrypt(response)).resolves.toEqual({ event: 'agent.message', text: 'private answer' })
    })

    it('rejects replayed, reordered, cross-channel, and tampered envelopes', async () => {
        const sessionKey = randomBytes(32)
        const channelId = randomUUID()
        const sender = await SessionCipher.create({ sessionKey, role: 'initiator', channelId, crypto })
        const receiver = await SessionCipher.create({ sessionKey, role: 'responder', channelId, crypto })
        const first = await sender.encrypt({ index: 0 })
        const second = await sender.encrypt({ index: 1 })

        await expect(receiver.decrypt(second)).rejects.toThrow('Unexpected receive sequence')
        await expect(receiver.decrypt(first)).resolves.toEqual({ index: 0 })
        await expect(receiver.decrypt(first)).rejects.toThrow('Unexpected receive sequence')

        await expect(receiver.decrypt({ ...second, channelId: randomUUID() })).rejects.toThrow('another channel')
        const tamperedBytes = Buffer.from(second.ciphertext, 'base64')
        tamperedBytes[0] = tamperedBytes[0]! ^ 1
        const tampered = { ...second, ciphertext: tamperedBytes.toString('base64') }
        await expect(receiver.decrypt(tampered)).rejects.toBeInstanceOf(SecureChannelError)
        await expect(receiver.decrypt(second)).resolves.toEqual({ index: 1 })
    })

    it('cannot decrypt with a different PAKE session key', async () => {
        const channelId = randomUUID()
        const sender = await SessionCipher.create({ sessionKey: randomBytes(32), role: 'initiator', channelId, crypto })
        const receiver = await SessionCipher.create({ sessionKey: randomBytes(32), role: 'responder', channelId, crypto })
        await expect(receiver.decrypt(await sender.encrypt({ protected: true }))).rejects.toThrow('authentication failed')
    })
})
