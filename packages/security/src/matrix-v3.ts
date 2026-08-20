import {
  canonicalJsonBytes,
  codeverV3ContentEnvelopeSchema,
  codeverV3PlaintextSchema,
  type CodeverV3ContentEnvelope,
  type CodeverV3Plaintext,
} from '@codever/protocol'
import {
  base64UrlDecode,
  base64UrlEncode,
  toArrayBuffer,
  webCrypto,
} from './encoding.js'
import { SecurityError } from './errors.js'

export interface CodeverV3EnvelopeBindings {
  roomId: string
  projectId: string
  keyId: string
}

export interface SealCodeverV3EnvelopeOptions extends CodeverV3EnvelopeBindings {
  plaintext: CodeverV3Plaintext
  projectKey: Uint8Array | CryptoKey
  logicalEventId: string
}

export interface OpenCodeverV3EnvelopeOptions extends CodeverV3EnvelopeBindings {
  projectKey: Uint8Array | CryptoKey
}

export function generateCodeverV3ProjectKey(): Uint8Array {
  return webCrypto().getRandomValues(new Uint8Array(32))
}

export async function sealCodeverV3Envelope(
  options: SealCodeverV3EnvelopeOptions,
): Promise<CodeverV3ContentEnvelope> {
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
  const plaintext = codeverV3PlaintextSchema.parse(options.plaintext)
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
  return codeverV3ContentEnvelopeSchema.parse({
    ...header,
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
  })
}

export async function openCodeverV3Envelope(
  input: unknown,
  options: OpenCodeverV3EnvelopeOptions,
): Promise<{ plaintext: CodeverV3Plaintext; envelope: CodeverV3ContentEnvelope }> {
  const envelope = codeverV3ContentEnvelopeSchema.parse(input)
  for (const field of ['roomId', 'projectId', 'keyId'] as const) {
    if (envelope[field] !== options[field]) {
      throw new SecurityError(
        'binding_mismatch',
        `Codever v3 envelope ${field} binding does not match`,
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
      'Codever v3 project envelope authentication failed',
    )
  }
  return {
    plaintext: codeverV3PlaintextSchema.parse(parsed),
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

