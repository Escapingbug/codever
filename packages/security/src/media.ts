import type { EncryptedMedia } from '@codever/protocol'
import {
  base64UrlDecode,
  base64UrlEncode,
  sha256,
  toArrayBuffer,
  webCrypto,
} from './encoding.js'

const AES_GCM_KEY_BYTES = 32
const AES_GCM_IV_BYTES = 12

export interface EncryptedMediaPayload {
  ciphertext: Uint8Array
  descriptor: Omit<EncryptedMedia, 'url'>
}

export async function encryptMedia(
  plaintext: Uint8Array,
): Promise<EncryptedMediaPayload> {
  const keyBytes = webCrypto().getRandomValues(new Uint8Array(AES_GCM_KEY_BYTES))
  const iv = webCrypto().getRandomValues(new Uint8Array(AES_GCM_IV_BYTES))
  const key = await webCrypto().subtle.importKey(
    'raw',
    toArrayBuffer(keyBytes),
    'AES-GCM',
    false,
    ['encrypt'],
  )
  const ciphertext = new Uint8Array(
    await webCrypto().subtle.encrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(plaintext),
    ),
  )
  return {
    ciphertext,
    descriptor: {
      key: base64UrlEncode(keyBytes),
      iv: base64UrlEncode(iv),
      sha256: await sha256(ciphertext),
      size: ciphertext.byteLength,
    },
  }
}

export async function decryptMedia(
  ciphertext: Uint8Array,
  descriptor: Pick<EncryptedMedia, 'key' | 'iv' | 'sha256' | 'size'>,
): Promise<Uint8Array> {
  if (ciphertext.byteLength !== descriptor.size) {
    throw new Error(
      `Encrypted media size mismatch: expected ${descriptor.size}, received ${ciphertext.byteLength}`,
    )
  }
  if (await sha256(ciphertext) !== descriptor.sha256) {
    throw new Error('Encrypted media integrity check failed')
  }
  const keyBytes = base64UrlDecode(descriptor.key)
  const iv = base64UrlDecode(descriptor.iv)
  if (keyBytes.byteLength !== AES_GCM_KEY_BYTES || iv.byteLength !== AES_GCM_IV_BYTES) {
    throw new Error('Encrypted media key material is malformed')
  }
  const key = await webCrypto().subtle.importKey(
    'raw',
    toArrayBuffer(keyBytes),
    'AES-GCM',
    false,
    ['decrypt'],
  )
  try {
    return new Uint8Array(
      await webCrypto().subtle.decrypt(
        { name: 'AES-GCM', iv: toArrayBuffer(iv) },
        key,
        toArrayBuffer(ciphertext),
      ),
    )
  } catch {
    throw new Error('Encrypted media could not be authenticated or decrypted')
  }
}
