import { canonicalJson } from '@codever/protocol'

function getCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error('WebCrypto SubtleCrypto is required')
  }
  return globalThis.crypto
}

export function webCrypto(): Crypto {
  return getCrypto()
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError('Invalid base64url value')
  }
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  return base64UrlEncode(
    new Uint8Array(await getCrypto().subtle.digest('SHA-256', toArrayBuffer(bytes))),
  )
}

export async function publicKeyId(publicKey: CryptoKey | JsonWebKey): Promise<string> {
  const jwk =
    publicKey instanceof CryptoKey
      ? await getCrypto().subtle.exportKey('jwk', publicKey)
      : publicKey
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
    throw new TypeError('Expected a P-256 public key')
  }
  return sha256(canonicalJson({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
}
