import { z } from 'zod'
import { jsonValueSchema, PROTOCOL_VERSION, signatureSchema } from './schema.js'

const opaqueId = z.string().min(1).max(256)
const timestamp = z.number().int().nonnegative()
const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/)
const keyId = base64Url.length(43)

export const secureEnvelopeDirectionSchema = z.enum([
  'device_to_gateway',
  'gateway_to_device',
])

export type SecureEnvelopeDirection = z.infer<typeof secureEnvelopeDirectionSchema>

/**
 * Everything except ciphertext is authenticated twice: first as AES-GCM AAD,
 * then together with the ciphertext by the sender's application signature.
 */
export const secureEnvelopeHeaderSchema = z
  .object({
    kind: z.literal('codever.secure-envelope'),
    version: z.literal(PROTOCOL_VERSION),
    envelopeId: opaqueId,
    contentType: z.literal('io.codever.matrix-content.v1'),
    gatewayId: opaqueId,
    conversationId: opaqueId,
    direction: secureEnvelopeDirectionSchema,
    senderDeviceId: opaqueId,
    recipientDeviceId: opaqueId,
    senderKeyId: keyId,
    recipientKeyId: keyId,
    issuedAt: timestamp,
    expiresAt: timestamp,
    /** 96-bit AES-GCM IV encoded without padding. */
    nonce: base64Url.length(16),
  })
  .strict()
  .superRefine((header, context) => {
    if (header.expiresAt <= header.issuedAt) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'expiresAt must be later than issuedAt',
      })
    }
    if (header.senderDeviceId === header.recipientDeviceId) {
      context.addIssue({
        code: 'custom',
        path: ['recipientDeviceId'],
        message: 'Secure envelope sender and recipient must be different',
      })
    }
    if (header.senderKeyId === header.recipientKeyId) {
      context.addIssue({
        code: 'custom',
        path: ['recipientKeyId'],
        message: 'Secure envelope sender and recipient keys must be different',
      })
    }
  })

export type SecureEnvelopeHeader = z.infer<typeof secureEnvelopeHeaderSchema>

export const secureEnvelopeSchema = secureEnvelopeHeaderSchema
  .safeExtend({
    /** AES-256-GCM ciphertext with the authentication tag appended. */
    ciphertext: base64Url.min(22).max(24 * 1024 * 1024),
  })
  .strict()

export type SecureEnvelope = z.infer<typeof secureEnvelopeSchema>

export const signedSecureEnvelopeSchema = z
  .object({
    envelope: secureEnvelopeSchema,
    signature: signatureSchema,
  })
  .strict()

export type SignedSecureEnvelope = z.infer<typeof signedSecureEnvelopeSchema>

/**
 * Common authenticated metadata for a multi-recipient envelope. The payload
 * ciphertext is shared; only its random content key is wrapped independently
 * for each paired application device.
 */
export const secureEnvelopeBundleHeaderSchema = z
  .object({
    kind: z.literal('codever.secure-envelope-bundle'),
    version: z.literal(PROTOCOL_VERSION),
    envelopeId: opaqueId,
    contentType: z.literal('io.codever.matrix-content.v1'),
    gatewayId: opaqueId,
    conversationId: opaqueId,
    direction: secureEnvelopeDirectionSchema,
    senderDeviceId: opaqueId,
    senderKeyId: keyId,
    issuedAt: timestamp,
    expiresAt: timestamp,
    /** 96-bit AES-GCM IV for the shared payload, encoded without padding. */
    nonce: base64Url.length(16),
  })
  .strict()
  .superRefine((header, context) => {
    if (header.expiresAt <= header.issuedAt) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'expiresAt must be later than issuedAt',
      })
    }
  })

export type SecureEnvelopeBundleHeader = z.infer<typeof secureEnvelopeBundleHeaderSchema>

export const secureEnvelopeBundleRecipientSchema = z
  .object({
    recipientDeviceId: opaqueId,
    recipientKeyId: keyId,
    /** 96-bit AES-GCM IV for this recipient's wrapped content key. */
    nonce: base64Url.length(16),
    /** A 32-byte content key plus the 16-byte AES-GCM authentication tag. */
    wrappedKey: base64Url.length(64),
  })
  .strict()

export type SecureEnvelopeBundleRecipient = z.infer<
  typeof secureEnvelopeBundleRecipientSchema
>

export const secureEnvelopeBundleSchema = secureEnvelopeBundleHeaderSchema
  .safeExtend({
    /** AES-256-GCM ciphertext shared by every addressed recipient. */
    ciphertext: base64Url.min(22).max(24 * 1024 * 1024),
    recipients: z.array(secureEnvelopeBundleRecipientSchema).min(1).max(256),
  })
  .strict()
  .superRefine((bundle, context) => {
    const deviceIds = new Set<string>()
    const keyIds = new Set<string>()
    bundle.recipients.forEach((recipient, index) => {
      if (recipient.recipientDeviceId === bundle.senderDeviceId) {
        context.addIssue({
          code: 'custom',
          path: ['recipients', index, 'recipientDeviceId'],
          message: 'Secure envelope sender and recipient must be different',
        })
      }
      if (recipient.recipientKeyId === bundle.senderKeyId) {
        context.addIssue({
          code: 'custom',
          path: ['recipients', index, 'recipientKeyId'],
          message: 'Secure envelope sender and recipient keys must be different',
        })
      }
      if (deviceIds.has(recipient.recipientDeviceId)) {
        context.addIssue({
          code: 'custom',
          path: ['recipients', index, 'recipientDeviceId'],
          message: 'Recipient device IDs must be unique',
        })
      }
      if (keyIds.has(recipient.recipientKeyId)) {
        context.addIssue({
          code: 'custom',
          path: ['recipients', index, 'recipientKeyId'],
          message: 'Recipient key IDs must be unique',
        })
      }
      deviceIds.add(recipient.recipientDeviceId)
      keyIds.add(recipient.recipientKeyId)
    })
  })

export type SecureEnvelopeBundle = z.infer<typeof secureEnvelopeBundleSchema>

export const signedSecureEnvelopeBundleSchema = z
  .object({
    bundle: secureEnvelopeBundleSchema,
    signature: signatureSchema,
  })
  .strict()

export type SignedSecureEnvelopeBundle = z.infer<
  typeof signedSecureEnvelopeBundleSchema
>

/** The decrypted payload is JSON, normally a complete Matrix message content. */
export const secureEnvelopePlaintextSchema = jsonValueSchema
export type SecureEnvelopePlaintext = z.infer<typeof secureEnvelopePlaintextSchema>
