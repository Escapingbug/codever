import {
  canonicalJsonBytes,
  matrixStateContentSchema,
  matrixStateEnvelopeHeaderSchema,
  signedMatrixStateEnvelopeSchema,
  type MatrixStateContent,
  type SignedMatrixStateEnvelope,
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

const signingAlgorithm: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' }
const signatureDomain = 'codever.matrix-state-envelope.signature.v2'

export interface MatrixStateEnvelopeBindings {
  gatewayId: string
  conversationId: string
  roomId: string
  eventType: string
  stateKey: string
  epochId: string
  stateVersion: number
}

export interface SealMatrixStateEnvelopeOptions extends MatrixStateEnvelopeBindings {
  plaintext: MatrixStateContent
  timelineKey: Uint8Array | CryptoKey
  gatewayPrivateKey: CryptoKey | JsonWebKey
  gatewayKeyId: string
  now?: number
}

export async function sealMatrixStateEnvelope(
  options: SealMatrixStateEnvelopeOptions,
): Promise<SignedMatrixStateEnvelope> {
  const timelineKey = await importTimelineKey(options.timelineKey, ['encrypt'])
  const nonce = webCrypto().getRandomValues(new Uint8Array(12))
  const header = matrixStateEnvelopeHeaderSchema.parse({
    kind: 'codever.matrix-state-envelope',
    version: 2,
    contentType: 'io.codever.matrix-state-content.v2',
    gatewayId: options.gatewayId,
    conversationId: options.conversationId,
    roomId: options.roomId,
    eventType: options.eventType,
    stateKey: options.stateKey,
    epochId: options.epochId,
    stateVersion: options.stateVersion,
    issuedAt: options.now ?? Date.now(),
    nonce: base64UrlEncode(nonce),
  })
  const plaintext = matrixStateContentSchema.parse(options.plaintext)
  if (plaintext.state_version !== header.stateVersion) {
    throw new SecurityError('binding_mismatch', 'Matrix state payload version does not match its envelope')
  }
  const ciphertext = await webCrypto().subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(canonicalJsonBytes(header)),
      tagLength: 128,
    },
    timelineKey,
    toArrayBuffer(canonicalJsonBytes(plaintext)),
  )
  const envelope = {
    ...header,
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
  }
  const privateKey = await importEcdsaPrivateKey(options.gatewayPrivateKey)
  const signature = await webCrypto().subtle.sign(
    signingAlgorithm,
    privateKey,
    toArrayBuffer(canonicalJsonBytes({ domain: signatureDomain, envelope })),
  )
  return signedMatrixStateEnvelopeSchema.parse({
    envelope,
    signature: {
      algorithm: 'ES256',
      keyId: options.gatewayKeyId,
      value: base64UrlEncode(new Uint8Array(signature)),
    },
  })
}

export async function openMatrixStateEnvelope(
  input: unknown,
  options: {
    timelineKey: Uint8Array | CryptoKey
    gatewayPublicKey: CryptoKey | JsonWebKey
    expected: MatrixStateEnvelopeBindings
  },
): Promise<MatrixStateContent> {
  const signed = signedMatrixStateEnvelopeSchema.parse(input)
  assertBindings(signed.envelope, options.expected)
  const expectedKeyId = await publicKeyId(options.gatewayPublicKey)
  if (signed.signature.keyId !== expectedKeyId) {
    throw new SecurityError('key_mismatch', 'Matrix state envelope Gateway key ID is incorrect')
  }
  const publicKey = await importEcdsaPublicKey(options.gatewayPublicKey)
  const valid = await webCrypto().subtle.verify(
    signingAlgorithm,
    publicKey,
    toArrayBuffer(base64UrlDecode(signed.signature.value)),
    toArrayBuffer(canonicalJsonBytes({ domain: signatureDomain, envelope: signed.envelope })),
  )
  if (!valid) {
    throw new SecurityError('invalid_signature', 'Matrix state envelope signature is invalid')
  }

  const { ciphertext, ...headerInput } = signed.envelope
  const header = matrixStateEnvelopeHeaderSchema.parse(headerInput)
  const timelineKey = await importTimelineKey(options.timelineKey, ['decrypt'])
  let parsed: unknown
  try {
    const plaintext = await webCrypto().subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(base64UrlDecode(header.nonce)),
        additionalData: toArrayBuffer(canonicalJsonBytes(header)),
        tagLength: 128,
      },
      timelineKey,
      toArrayBuffer(base64UrlDecode(ciphertext)),
    )
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
  } catch {
    throw new SecurityError('invalid_signature', 'Matrix state envelope authentication failed')
  }
  const content = matrixStateContentSchema.parse(parsed)
  if (content.state_version !== header.stateVersion) {
    throw new SecurityError('binding_mismatch', 'Matrix state payload version does not match its envelope')
  }
  return content
}

function assertBindings(
  envelope: SignedMatrixStateEnvelope['envelope'],
  expected: MatrixStateEnvelopeBindings,
): void {
  for (const field of [
    'gatewayId',
    'conversationId',
    'roomId',
    'eventType',
    'stateKey',
    'epochId',
    'stateVersion',
  ] as const) {
    if (envelope[field] !== expected[field]) {
      throw new SecurityError('binding_mismatch', `Matrix state envelope ${field} binding does not match`)
    }
  }
}

async function importTimelineKey(value: Uint8Array | CryptoKey, usages: KeyUsage[]): Promise<CryptoKey> {
  if (!(value instanceof Uint8Array)) {
    if (value.algorithm.name !== 'AES-GCM' || !usages.every(usage => value.usages.includes(usage))) {
      throw new SecurityError('key_mismatch', 'Timeline key does not allow Matrix state encryption')
    }
    return value
  }
  if (value.byteLength !== 32) {
    throw new SecurityError('key_mismatch', 'Timeline key must contain exactly 32 bytes')
  }
  return webCrypto().subtle.importKey(
    'raw',
    toArrayBuffer(value),
    { name: 'AES-GCM' },
    false,
    usages,
  )
}

async function importEcdsaPrivateKey(value: CryptoKey | JsonWebKey): Promise<CryptoKey> {
  if (isCryptoKey(value)) return value
  return webCrypto().subtle.importKey(
    'jwk', value, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  )
}

async function importEcdsaPublicKey(value: CryptoKey | JsonWebKey): Promise<CryptoKey> {
  if (isCryptoKey(value)) return value
  return webCrypto().subtle.importKey(
    'jwk', value, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
  )
}
