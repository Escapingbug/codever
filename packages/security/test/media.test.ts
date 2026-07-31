import { describe, expect, it } from 'vitest'
import { decryptMedia, encryptMedia } from '../src/media.js'

describe('application encrypted media', () => {
  it('round-trips bytes and authenticates ciphertext', async () => {
    const plaintext = new TextEncoder().encode('hello, encrypted attachment')
    const encrypted = await encryptMedia(plaintext)

    await expect(
      decryptMedia(encrypted.ciphertext, encrypted.descriptor),
    ).resolves.toEqual(plaintext)

    const tampered = encrypted.ciphertext.slice()
    tampered[0] ^= 1
    await expect(
      decryptMedia(tampered, encrypted.descriptor),
    ).rejects.toThrow('integrity check failed')
  })
})
