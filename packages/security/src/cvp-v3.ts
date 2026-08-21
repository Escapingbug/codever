import {
  canonicalJsonBytes,
  cvp3ContentEnvelopeSchema,
  cvp3PlaintextSchema,
  type Cvp3ContentEnvelope,
  type Cvp3Plaintext,
} from '@codever/protocol'
import {
  base64UrlDecode,
  base64UrlEncode,
  toArrayBuffer,
  webCrypto,
} from './encoding.js'
import { SecurityError } from './errors.js'

export interface Cvp3EnvelopeBindings {
  roomId: string
  projectId: string
  keyId: string
}

export interface SealCvp3EnvelopeOptions extends Cvp3EnvelopeBindings {
  plaintext: Cvp3Plaintext
  projectKey: Uint8Array | CryptoKey
  logicalEventId: string
}

export interface OpenCvp3EnvelopeOptions extends Cvp3EnvelopeBindings {
  projectKey: Uint8Array | CryptoKey
}

export function generateCvp3ProjectKey(): Uint8Array {
  return webCrypto().getRandomValues(new Uint8Array(32))
}

export async function sealCvp3Envelope(
  options: SealCvp3EnvelopeOptions,
): Promise<Cvp3ContentEnvelope> {
  const nonce = webCrypto().getRandomValues(new Uint8Array(12))
  const header = {
    kind: 'codever.project-envelope' as const,
    version: 3 as const,
    roomId: options.roomId,
    projectId: options.projectId,
    keyId: options.keyId,
    logicalEventId: options.logicalEventId,
    nonce: base64UrlEncode(nonce),
  }
  const plaintext = cvp3PlaintextSchema.parse(options.plaintext)
  const ciphertext = await webCrypto().subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(canonicalJsonBytes(header)),
      tagLength: 128,
    },
    await importProjectKey(options.projectKey, ['encrypt']),
    toArrayBuffer(canonicalJsonBytes(plaintext)),
  )
  return cvp3ContentEnvelopeSchema.parse({
    ...header,
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
  })
}

export async function openCvp3Envelope(
  input: unknown,
  options: OpenCvp3EnvelopeOptions,
): Promise<{ plaintext: Cvp3Plaintext; envelope: Cvp3ContentEnvelope }> {
  const envelope = cvp3ContentEnvelopeSchema.parse(input)
  for (const field of ['roomId', 'projectId', 'keyId'] as const) {
    if (envelope[field] !== options[field]) {
      throw new SecurityError(
        'binding_mismatch',
        `CVP/3 envelope ${field} binding does not match`,
      )
    }
  }
  const { ciphertext, ...header } = envelope
  let parsed: unknown
  try {
    const bytes = await webCrypto().subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(base64UrlDecode(envelope.nonce)),
        additionalData: toArrayBuffer(canonicalJsonBytes(header)),
        tagLength: 128,
      },
      await importProjectKey(options.projectKey, ['decrypt']),
      toArrayBuffer(base64UrlDecode(ciphertext)),
    )
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new SecurityError(
      'invalid_signature',
      'CVP/3 project envelope authentication failed',
    )
  }
  return {
    plaintext: cvp3PlaintextSchema.parse(parsed),
    envelope,
  }
}

async function importProjectKey(
  value: Uint8Array | CryptoKey,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  if (!(value instanceof Uint8Array)) {
    if (
      value.algorithm.name !== 'AES-GCM'
      || !usages.every(usage => value.usages.includes(usage))
    ) {
      throw new SecurityError(
        'key_mismatch',
        'Codever project key does not allow the required AES-GCM operation',
      )
    }
    return value
  }
  if (value.byteLength !== 32) {
    throw new SecurityError(
      'key_mismatch',
      'Codever project key must contain exactly 32 bytes',
    )
  }
  return webCrypto().subtle.importKey(
    'raw',
    toArrayBuffer(value),
    { name: 'AES-GCM' },
    false,
    usages,
  )
}

