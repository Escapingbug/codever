import { base64UrlEncode, publicKeyId, toArrayBuffer, webCrypto } from './encoding.js'
import type { DeviceKeyPair } from './signatures.js'

export interface SerializedPublicDeviceKey {
  version: 1
  algorithm: 'ES256'
  keyId: string
  publicKey: JsonWebKey
}

export interface SerializedDeviceKeyPair extends SerializedPublicDeviceKey {
  privateKey: JsonWebKey
}

function validatePublicJwk(input: JsonWebKey): void {
  if (
    input.kty !== 'EC' ||
    input.crv !== 'P-256' ||
    typeof input.x !== 'string' ||
    typeof input.y !== 'string'
  ) {
    throw new TypeError('Expected a P-256 public JWK')
  }
}

function validatePrivateJwk(input: JsonWebKey): void {
  validatePublicJwk(input)
  if (typeof input.d !== 'string') throw new TypeError('Expected a P-256 private JWK')
}

export async function exportPublicDeviceKey(
  publicKey: CryptoKey,
): Promise<SerializedPublicDeviceKey> {
  const publicJwk = await webCrypto().subtle.exportKey('jwk', publicKey)
  validatePublicJwk(publicJwk)
  return {
    version: 1,
    algorithm: 'ES256',
    keyId: await publicKeyId(publicJwk),
    publicKey: publicJwk,
  }
}

export async function exportDeviceKeyPair(
  keys: DeviceKeyPair,
): Promise<SerializedDeviceKeyPair> {
  const publicIdentity = await exportPublicDeviceKey(keys.publicKey)
  if (publicIdentity.keyId !== keys.keyId) {
    throw new TypeError('Device key id does not match its public key')
  }
  const privateKey = await webCrypto().subtle.exportKey('jwk', keys.privateKey)
  validatePrivateJwk(privateKey)
  return { ...publicIdentity, privateKey }
}

export async function importPublicDeviceKey(
  serialized: SerializedPublicDeviceKey,
): Promise<CryptoKey> {
  if (serialized.version !== 1 || serialized.algorithm !== 'ES256') {
    throw new TypeError('Unsupported device key format')
  }
  validatePublicJwk(serialized.publicKey)
  if ((await publicKeyId(serialized.publicKey)) !== serialized.keyId) {
    throw new TypeError('Device key id does not match its public key')
  }
  return webCrypto().subtle.importKey(
    'jwk',
    serialized.publicKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  )
}

export async function importDeviceKeyPair(
  serialized: SerializedDeviceKeyPair,
): Promise<DeviceKeyPair> {
  validatePrivateJwk(serialized.privateKey)
  const publicKey = await importPublicDeviceKey(serialized)
  const privateKey = await webCrypto().subtle.importKey(
    'jwk',
    serialized.privateKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign'],
  )

  // A matching x/y is necessary, but proving possession also catches malformed
  // or provider-specific JWK inconsistencies before persisting the identity.
  const challenge = webCrypto().getRandomValues(new Uint8Array(32))
  const signature = await webCrypto().subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    toArrayBuffer(challenge),
  )
  const matches = await webCrypto().subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    signature,
    toArrayBuffer(challenge),
  )
  if (!matches) throw new TypeError('Private key does not match the public device key')

  return {
    keyId: serialized.keyId,
    privateKey,
    publicKey,
    publicJwk: structuredClone(serialized.publicKey),
  }
}

/** Generates a random, URL-safe nonce suitable for signed commands. */
export function generateCommandNonce(byteLength = 24): string {
  if (!Number.isInteger(byteLength) || byteLength < 16) {
    throw new RangeError('Command nonce must contain at least 16 random bytes')
  }
  return base64UrlEncode(webCrypto().getRandomValues(new Uint8Array(byteLength)))
}
