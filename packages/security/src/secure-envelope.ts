import {
  canonicalJson,
  canonicalJsonBytes,
  secureEnvelopeHeaderSchema,
  secureEnvelopePlaintextSchema,
  signedSecureEnvelopeSchema,
  type JsonValue,
  type SecureEnvelope,
  type SecureEnvelopeDirection,
  type SecureEnvelopeHeader,
  type SignedSecureEnvelope,
} from '@codever/protocol'
import {
  base64UrlDecode,
  base64UrlEncode,
  isCryptoKey,
  publicKeyId,
  toArrayBuffer,
  webCrypto,
} from './encoding.js'
import { SecurityError } from './errors.js'
import type { ReplayStore } from './replay.js'

const signingAlgorithm: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' }
const DEFAULT_LIFETIME_MS = 2 * 60_000
const MAX_LIFETIME_MS = 366 * 24 * 60 * 60_000
const DEFAULT_FUTURE_SKEW_MS = 30_000
const signatureDomain = 'codever.secure-envelope.signature.v1'
const kdfDomain = 'codever.secure-envelope.kdf.v1'

export interface SecureEnvelopeBindings {
  gatewayId: string
  conversationId: string
  direction: SecureEnvelopeDirection
  senderDeviceId: string
  recipientDeviceId: string
  senderKeyId: string
  recipientKeyId: string
}

export interface SealSecureEnvelopeOptions extends SecureEnvelopeBindings {
  plaintext: JsonValue
  senderPrivateKey: CryptoKey | JsonWebKey
  recipientPublicKey: CryptoKey | JsonWebKey
  envelopeId?: string
  now?: number
  lifetimeMs?: number
}

export interface OpenSecureEnvelopeOptions {
  recipientPrivateKey: CryptoKey | JsonWebKey
  senderPublicKey: CryptoKey | JsonWebKey
  expected: SecureEnvelopeBindings
  replayStore: ReplayStore
  now?: number
  maxFutureSkewMs?: number
}

export interface OpenedSecureEnvelope {
  plaintext: JsonValue
  envelope: SecureEnvelope
}

export async function sealSecureEnvelope(
  options: SealSecureEnvelopeOptions,
): Promise<SignedSecureEnvelope> {
  const now = options.now ?? Date.now()
  const lifetimeMs = options.lifetimeMs ?? DEFAULT_LIFETIME_MS
  if (
    !Number.isSafeInteger(lifetimeMs) ||
    lifetimeMs < 1_000 ||
    lifetimeMs > MAX_LIFETIME_MS
  ) {
    throw new RangeError('Secure envelope lifetime must be between 1 second and 366 days')
  }
  await assertKeyBindings(options)
  const nonce = webCrypto().getRandomValues(new Uint8Array(12))
  const header = secureEnvelopeHeaderSchema.parse({
    kind: 'codever.secure-envelope',
    version: 1,
    envelopeId: options.envelopeId ?? randomId(),
    contentType: 'io.codever.matrix-content.v1',
    gatewayId: options.gatewayId,
    conversationId: options.conversationId,
    direction: options.direction,
    senderDeviceId: options.senderDeviceId,
    recipientDeviceId: options.recipientDeviceId,
    senderKeyId: options.senderKeyId,
    recipientKeyId: options.recipientKeyId,
    issuedAt: now,
    expiresAt: now + lifetimeMs,
    nonce: base64UrlEncode(nonce),
  })
  const plaintext = secureEnvelopePlaintextSchema.parse(options.plaintext)
  const encryptionKey = await deriveEncryptionKey(
    options.senderPrivateKey,
    options.recipientPublicKey,
    header,
  )
  const ciphertext = await webCrypto().subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(canonicalJsonBytes(header)),
      tagLength: 128,
    },
    encryptionKey,
    toArrayBuffer(canonicalJsonBytes(plaintext)),
  )
  const envelope = {
    ...header,
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
  } satisfies SecureEnvelope
  const privateSigningKey = await importEcdsaPrivateKey(options.senderPrivateKey)
  const signature = await webCrypto().subtle.sign(
    signingAlgorithm,
    privateSigningKey,
    toArrayBuffer(canonicalJsonBytes({ domain: signatureDomain, envelope })),
  )
  return signedSecureEnvelopeSchema.parse({
    envelope,
    signature: {
      algorithm: 'ES256',
      keyId: options.senderKeyId,
      value: base64UrlEncode(new Uint8Array(signature)),
    },
  })
}

export async function openSecureEnvelope(
  input: unknown,
  options: OpenSecureEnvelopeOptions,
): Promise<OpenedSecureEnvelope> {
  const signed = signedSecureEnvelopeSchema.parse(input)
  assertExpectedBindings(signed.envelope, options.expected)
  assertTimeWindow(signed.envelope, options)
  await assertOpenKeyBindings(options)

  const senderSigningKey = await importEcdsaPublicKey(options.senderPublicKey)
  const signatureValid = await webCrypto().subtle.verify(
    signingAlgorithm,
    senderSigningKey,
    toArrayBuffer(base64UrlDecode(signed.signature.value)),
    toArrayBuffer(
      canonicalJsonBytes({ domain: signatureDomain, envelope: signed.envelope }),
    ),
  )
  if (
    signed.signature.keyId !== signed.envelope.senderKeyId ||
    !signatureValid
  ) {
    throw new SecurityError('invalid_signature', 'Secure envelope signature is invalid')
  }

  const { ciphertext, ...headerInput } = signed.envelope
  const header = secureEnvelopeHeaderSchema.parse(headerInput)
  const nonce = base64UrlDecode(header.nonce)
  if (nonce.byteLength !== 12) throw new SecurityError('binding_mismatch', 'Invalid AES-GCM nonce')
  const encryptionKey = await deriveEncryptionKey(
    options.recipientPrivateKey,
    options.senderPublicKey,
    header,
  )

  let decoded: unknown
  try {
    const plaintext = await webCrypto().subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(canonicalJsonBytes(header)),
        tagLength: 128,
      },
      encryptionKey,
      toArrayBuffer(base64UrlDecode(ciphertext)),
    )
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
  } catch {
    throw new SecurityError('invalid_signature', 'Secure envelope authentication failed')
  }
  const plaintext = secureEnvelopePlaintextSchema.parse(decoded)
  const replayScope = canonicalJson([
    header.gatewayId,
    header.conversationId,
    header.direction,
    header.senderDeviceId,
    header.recipientDeviceId,
  ])
  const accepted = await options.replayStore.claimAll(
    [
      {
        key: `${replayScope}:envelope:${header.envelopeId}`,
        expiresAt: header.expiresAt,
      },
      {
        key: `${replayScope}:nonce:${header.nonce}`,
        expiresAt: header.expiresAt,
      },
    ],
    options.now ?? Date.now(),
  )
  if (!accepted) throw new SecurityError('replay', 'Secure envelope was already opened')
  return { plaintext, envelope: signed.envelope }
}

async function deriveEncryptionKey(
  ownPrivateKey: CryptoKey | JsonWebKey,
  peerPublicKey: CryptoKey | JsonWebKey,
  header: SecureEnvelopeHeader,
): Promise<CryptoKey> {
  const privateKey = await importEcdhPrivateKey(ownPrivateKey)
  const publicKey = await importEcdhPublicKey(peerPublicKey)
  const sharedSecret = await webCrypto().subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256,
  )
  const material = await webCrypto().subtle.importKey(
    'raw',
    sharedSecret,
    'HKDF',
    false,
    ['deriveKey'],
  )
  const salt = await webCrypto().subtle.digest(
    'SHA-256',
    toArrayBuffer(
      canonicalJsonBytes({
        domain: kdfDomain,
        gatewayId: header.gatewayId,
        recipientKeyId: header.recipientKeyId,
        senderKeyId: header.senderKeyId,
      }),
    ),
  )
  const info = canonicalJsonBytes({
    contentType: header.contentType,
    conversationId: header.conversationId,
    direction: header.direction,
    recipientDeviceId: header.recipientDeviceId,
    senderDeviceId: header.senderDeviceId,
  })
  return webCrypto().subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: toArrayBuffer(info),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function assertKeyBindings(options: SealSecureEnvelopeOptions): Promise<void> {
  if ((await keyIdForPrivate(options.senderPrivateKey)) !== options.senderKeyId) {
    throw new SecurityError('key_mismatch', 'Secure envelope sender key ID is incorrect')
  }
  if ((await publicKeyId(options.recipientPublicKey)) !== options.recipientKeyId) {
    throw new SecurityError('key_mismatch', 'Secure envelope recipient key ID is incorrect')
  }
}

async function assertOpenKeyBindings(options: OpenSecureEnvelopeOptions): Promise<void> {
  if ((await keyIdForPrivate(options.recipientPrivateKey)) !== options.expected.recipientKeyId) {
    throw new SecurityError('key_mismatch', 'Secure envelope recipient key ID is incorrect')
  }
  if ((await publicKeyId(options.senderPublicKey)) !== options.expected.senderKeyId) {
    throw new SecurityError('key_mismatch', 'Secure envelope sender key ID is incorrect')
  }
}

function assertExpectedBindings(
  envelope: SecureEnvelope,
  expected: SecureEnvelopeBindings,
): void {
  for (const key of Object.keys(expected) as Array<keyof SecureEnvelopeBindings>) {
    if (envelope[key] !== expected[key]) {
      throw new SecurityError('binding_mismatch', `Secure envelope ${key} binding is incorrect`)
    }
  }
}

function assertTimeWindow(
  envelope: SecureEnvelope,
  options: Pick<OpenSecureEnvelopeOptions, 'now' | 'maxFutureSkewMs'>,
): void {
  const now = options.now ?? Date.now()
  if (envelope.expiresAt <= now) throw new SecurityError('expired', 'Secure envelope has expired')
  if (envelope.issuedAt > now + (options.maxFutureSkewMs ?? DEFAULT_FUTURE_SKEW_MS)) {
    throw new SecurityError('issued_in_future', 'Secure envelope issue time is too far in the future')
  }
  if (envelope.expiresAt - envelope.issuedAt > MAX_LIFETIME_MS) {
    throw new SecurityError('lifetime_exceeded', 'Secure envelope validity window exceeds policy')
  }
}

async function keyIdForPrivate(key: CryptoKey | JsonWebKey): Promise<string> {
  const jwk = await exportJwk(key)
  return publicKeyId(publicPart(jwk))
}

async function exportJwk(key: CryptoKey | JsonWebKey): Promise<JsonWebKey> {
  return isCryptoKey(key)
    ? webCrypto().subtle.exportKey('jwk', key)
    : structuredClone(key)
}

function publicPart(jwk: JsonWebKey): JsonWebKey {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
    throw new TypeError('Expected a P-256 key')
  }
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }
}

async function importEcdhPrivateKey(key: CryptoKey | JsonWebKey): Promise<CryptoKey> {
  const jwk = await exportJwk(key)
  if (!jwk.d) throw new TypeError('Expected a P-256 private key')
  return webCrypto().subtle.importKey(
    'jwk',
    { ...publicPart(jwk), d: jwk.d },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  )
}

async function importEcdhPublicKey(key: CryptoKey | JsonWebKey): Promise<CryptoKey> {
  return webCrypto().subtle.importKey(
    'jwk',
    publicPart(await exportJwk(key)),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
}

async function importEcdsaPrivateKey(key: CryptoKey | JsonWebKey): Promise<CryptoKey> {
  if (isCryptoKey(key) && key.algorithm.name === 'ECDSA' && key.usages.includes('sign')) return key
  const jwk = await exportJwk(key)
  if (!jwk.d) throw new TypeError('Expected a P-256 private key')
  return webCrypto().subtle.importKey(
    'jwk',
    { ...publicPart(jwk), d: jwk.d },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
}

async function importEcdsaPublicKey(key: CryptoKey | JsonWebKey): Promise<CryptoKey> {
  if (isCryptoKey(key) && key.algorithm.name === 'ECDSA' && key.usages.includes('verify')) return key
  return webCrypto().subtle.importKey(
    'jwk',
    publicPart(await exportJwk(key)),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
}

function randomId(): string {
  return base64UrlEncode(webCrypto().getRandomValues(new Uint8Array(24)))
}
