import {
  canonicalJsonBytes,
  matrixTimelineEnvelopeHeaderSchema,
  secureEnvelopePlaintextSchema,
  signedMatrixTimelineEnvelopeSchema,
  type JsonValue,
  type SignedMatrixTimelineEnvelope,
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
const signatureDomain = 'codever.matrix-timeline-envelope.signature.v2'

export interface MatrixTimelineEnvelopeBindings {
  gatewayId: string
  conversationId: string
  roomId: string
  epochId: string
  sessionId?: string
  threadRootEventId?: string
}

export interface SealMatrixTimelineEnvelopeOptions
  extends MatrixTimelineEnvelopeBindings {
  plaintext: JsonValue
  timelineKey: Uint8Array | CryptoKey
  gatewayPrivateKey: CryptoKey | JsonWebKey
  gatewayKeyId: string
  envelopeId?: string
  logicalEventId?: string
  now?: number
}

export interface OpenMatrixTimelineEnvelopeOptions {
  timelineKey: Uint8Array | CryptoKey
  gatewayPublicKey: CryptoKey | JsonWebKey
  expected: MatrixTimelineEnvelopeBindings
}

export interface OpenedMatrixTimelineEnvelope {
  plaintext: JsonValue
  envelope: SignedMatrixTimelineEnvelope['envelope']
}

export function generateMatrixTimelineKey(): Uint8Array {
  return webCrypto().getRandomValues(new Uint8Array(32))
}

export async function sealMatrixTimelineEnvelope(
  options: SealMatrixTimelineEnvelopeOptions,
): Promise<SignedMatrixTimelineEnvelope> {
  const timelineKey = await importTimelineKey(options.timelineKey, ['encrypt'])
  const nonce = webCrypto().getRandomValues(new Uint8Array(12))
  const header = matrixTimelineEnvelopeHeaderSchema.parse({
    kind: 'codever.matrix-timeline-envelope',
    version: 2,
    envelopeId: options.envelopeId ?? randomId(),
    contentType: 'io.codever.matrix-timeline-content.v2',
    gatewayId: options.gatewayId,
    conversationId: options.conversationId,
    roomId: options.roomId,
    epochId: options.epochId,
    logicalEventId: options.logicalEventId ?? randomId(),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.threadRootEventId
      ? { threadRootEventId: options.threadRootEventId }
      : {}),
    issuedAt: options.now ?? Date.now(),
    nonce: base64UrlEncode(nonce),
  })
  const plaintext = secureEnvelopePlaintextSchema.parse(options.plaintext)
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
  return signedMatrixTimelineEnvelopeSchema.parse({
    envelope,
    signature: {
      algorithm: 'ES256',
      keyId: options.gatewayKeyId,
      value: base64UrlEncode(new Uint8Array(signature)),
    },
  })
}

export async function openMatrixTimelineEnvelope(
  input: unknown,
  options: OpenMatrixTimelineEnvelopeOptions,
): Promise<OpenedMatrixTimelineEnvelope> {
  const signed = signedMatrixTimelineEnvelopeSchema.parse(input)
  assertBindings(signed.envelope, options.expected)
  const expectedKeyId = await publicKeyId(options.gatewayPublicKey)
  if (signed.signature.keyId !== expectedKeyId) {
    throw new SecurityError('key_mismatch', 'Timeline envelope Gateway key ID is incorrect')
  }
  const publicKey = await importEcdsaPublicKey(options.gatewayPublicKey)
  const valid = await webCrypto().subtle.verify(
    signingAlgorithm,
    publicKey,
    toArrayBuffer(base64UrlDecode(signed.signature.value)),
    toArrayBuffer(
      canonicalJsonBytes({ domain: signatureDomain, envelope: signed.envelope }),
    ),
  )
  if (!valid) {
    throw new SecurityError('invalid_signature', 'Timeline envelope signature is invalid')
  }

  const { ciphertext, ...headerInput } = signed.envelope
  const header = matrixTimelineEnvelopeHeaderSchema.parse(headerInput)
  const nonce = base64UrlDecode(header.nonce)
  const timelineKey = await importTimelineKey(options.timelineKey, ['decrypt'])
  let parsed: unknown
  try {
    const plaintext = await webCrypto().subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(canonicalJsonBytes(header)),
        tagLength: 128,
      },
      timelineKey,
      toArrayBuffer(base64UrlDecode(ciphertext)),
    )
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
  } catch {
    throw new SecurityError('invalid_signature', 'Timeline envelope authentication failed')
  }
  return {
    plaintext: secureEnvelopePlaintextSchema.parse(parsed),
    envelope: signed.envelope,
  }
}

function assertBindings(
  envelope: SignedMatrixTimelineEnvelope['envelope'],
  expected: MatrixTimelineEnvelopeBindings,
): void {
  const fields: Array<keyof MatrixTimelineEnvelopeBindings> = [
    'gatewayId',
    'conversationId',
    'roomId',
    'epochId',
    'sessionId',
    'threadRootEventId',
  ]
  for (const field of fields) {
    if (envelope[field] !== expected[field]) {
      throw new SecurityError(
        'binding_mismatch',
        `Timeline envelope ${field} binding does not match`,
      )
    }
  }
}

async function importTimelineKey(
  value: Uint8Array | CryptoKey,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  if (!(value instanceof Uint8Array)) {
    if (value.algorithm.name !== 'AES-GCM') {
      throw new SecurityError('key_mismatch', 'Timeline key must use AES-GCM')
    }
    if (!usages.every(usage => value.usages.includes(usage))) {
      throw new SecurityError('key_mismatch', 'Timeline key does not allow the required use')
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
    'jwk',
    value,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
}

async function importEcdsaPublicKey(value: CryptoKey | JsonWebKey): Promise<CryptoKey> {
  if (isCryptoKey(value)) return value
  return webCrypto().subtle.importKey(
    'jwk',
    value,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
}

function randomId(): string {
  return base64UrlEncode(webCrypto().getRandomValues(new Uint8Array(32)))
}
