import { z } from 'zod'
import { canonicalJson } from './canonical-json.js'
import { PROTOCOL_VERSION } from './schema.js'

const opaqueId = z.string().min(1).max(256)
const timestamp = z.number().int().nonnegative()
const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/)
const sha256Base64Url = base64Url.length(43)

export const pairingOperationSchema = z.enum([
  'prompt',
  'cancel',
  'decision',
  'session.settings',
])

export type PairingOperation = z.infer<typeof pairingOperationSchema>

const operationSetSchema = z
  .array(pairingOperationSchema)
  .min(1)
  .max(pairingOperationSchema.options.length)
  .refine((operations) => new Set(operations).size === operations.length, {
    message: 'Pairing operations must be unique',
  })

/**
 * The only public-key form accepted by the pairing protocol. Matrix device
 * keys are intentionally absent: Codever keys are the trust root.
 */
export const pairingPublicKeySchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal('ES256'),
    keyId: sha256Base64Url,
    publicKey: z
      .object({
        kty: z.literal('EC'),
        crv: z.literal('P-256'),
        x: sha256Base64Url,
        y: sha256Base64Url,
        ext: z.literal(true).optional(),
        key_ops: z.tuple([z.literal('verify')]).optional(),
        alg: z.literal('ES256').optional(),
      })
      .strict(),
  })
  .strict()

export type PairingPublicKey = z.infer<typeof pairingPublicKeySchema>

/**
 * Signed routing metadata for the current Matrix device. Possession of this
 * identity alone grants no Codever authority.
 */
export const matrixTransportBindingSchema = z
  .object({
    homeserver: z.url(),
    roomId: opaqueId,
    userId: opaqueId,
    deviceId: opaqueId,
    ed25519: z.string().min(16).max(256),
  })
  .strict()

export type MatrixTransportBinding = z.infer<typeof matrixTransportBindingSchema>

export const pairingSignatureSchema = z
  .object({
    algorithm: z.literal('ES256'),
    keyId: sha256Base64Url,
    value: base64Url,
  })
  .strict()

export type PairingSignature = z.infer<typeof pairingSignatureSchema>

/**
 * A short-lived, one-time challenge displayed by a Gateway as a QR code or
 * handed to a co-located client over an authenticated local channel.
 */
export const pairingOfferSchema = z
  .object({
    kind: z.literal('codever.pairing.offer'),
    version: z.literal(PROTOCOL_VERSION),
    offerId: opaqueId,
    gatewayId: opaqueId,
    gatewayName: z.string().min(1).max(128),
    gatewayKey: pairingPublicKeySchema,
    gatewayTransport: matrixTransportBindingSchema,
    challenge: base64Url.min(43).max(128),
    allowedOperations: operationSetSchema,
    issuedAt: timestamp,
    expiresAt: timestamp,
  })
  .strict()
  .superRefine((offer, context) => {
    if (offer.expiresAt <= offer.issuedAt) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'expiresAt must be later than issuedAt',
      })
    }
  })

export type PairingOffer = z.infer<typeof pairingOfferSchema>

export const signedPairingOfferSchema = z
  .object({
    offer: pairingOfferSchema,
    signature: pairingSignatureSchema,
  })
  .strict()

export type SignedPairingOffer = z.infer<typeof signedPairingOfferSchema>

/**
 * A client proves possession of its Codever device key and binds the request
 * to every security-relevant byte in the scanned offer.
 */
export const pairingRequestSchema = z
  .object({
    kind: z.literal('codever.pairing.request'),
    version: z.literal(PROTOCOL_VERSION),
    requestId: opaqueId,
    offerId: opaqueId,
    offerDigest: sha256Base64Url,
    gatewayId: opaqueId,
    deviceId: opaqueId,
    deviceName: z.string().min(1).max(128),
    deviceKey: pairingPublicKeySchema,
    deviceTransport: matrixTransportBindingSchema,
    requestedOperations: operationSetSchema,
    issuedAt: timestamp,
    expiresAt: timestamp,
  })
  .strict()
  .superRefine((request, context) => {
    if (request.expiresAt <= request.issuedAt) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'expiresAt must be later than issuedAt',
      })
    }
  })

export type PairingRequest = z.infer<typeof pairingRequestSchema>

export const signedPairingRequestSchema = z
  .object({
    request: pairingRequestSchema,
    signature: pairingSignatureSchema,
  })
  .strict()

export type SignedPairingRequest = z.infer<typeof signedPairingRequestSchema>

/**
 * A portable authorization issued by the Gateway. It contains no Matrix
 * identity because transport identities are not authorization roots.
 */
export const pairingCertificateSchema = z
  .object({
    kind: z.literal('codever.pairing.certificate'),
    version: z.literal(PROTOCOL_VERSION),
    certificateId: opaqueId,
    offerId: opaqueId,
    offerDigest: sha256Base64Url,
    requestId: opaqueId,
    requestDigest: sha256Base64Url,
    gatewayId: opaqueId,
    gatewayKeyId: sha256Base64Url,
    gatewayTransport: matrixTransportBindingSchema,
    deviceId: opaqueId,
    deviceName: z.string().min(1).max(128),
    deviceKey: pairingPublicKeySchema,
    deviceTransport: matrixTransportBindingSchema,
    allowedOperations: operationSetSchema,
    issuedAt: timestamp,
    expiresAt: timestamp,
  })
  .strict()
  .superRefine((certificate, context) => {
    if (certificate.expiresAt <= certificate.issuedAt) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'expiresAt must be later than issuedAt',
      })
    }
  })

export type PairingCertificate = z.infer<typeof pairingCertificateSchema>

export const signedPairingCertificateSchema = z
  .object({
    certificate: pairingCertificateSchema,
    signature: pairingSignatureSchema,
  })
  .strict()

export type SignedPairingCertificate = z.infer<typeof signedPairingCertificateSchema>

/**
 * The final acknowledgement binds the certificate back to the exact request
 * and one-time challenge. The certificate remains independently verifiable.
 */
export const pairingResponseSchema = z
  .object({
    kind: z.literal('codever.pairing.response'),
    version: z.literal(PROTOCOL_VERSION),
    offerId: opaqueId,
    requestId: opaqueId,
    requestDigest: sha256Base64Url,
    gatewayId: opaqueId,
    certificate: signedPairingCertificateSchema,
    issuedAt: timestamp,
    expiresAt: timestamp,
  })
  .strict()
  .superRefine((response, context) => {
    if (response.expiresAt <= response.issuedAt) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'expiresAt must be later than issuedAt',
      })
    }
  })

export type PairingResponse = z.infer<typeof pairingResponseSchema>

export const signedPairingResponseSchema = z
  .object({
    response: pairingResponseSchema,
    signature: pairingSignatureSchema,
  })
  .strict()

export type SignedPairingResponse = z.infer<typeof signedPairingResponseSchema>

/**
 * A Gateway may rotate its Matrix transport device without asking the user to
 * pair again. The stable Gateway application key authorizes the replacement.
 */
export const gatewayDeviceRotationSchema = z
  .object({
    kind: z.literal('codever.gateway.device-rotation'),
    version: z.literal(PROTOCOL_VERSION),
    rotationId: opaqueId,
    gatewayId: opaqueId,
    gatewayKeyId: sha256Base64Url,
    previousTransport: matrixTransportBindingSchema,
    nextTransport: matrixTransportBindingSchema,
    issuedAt: timestamp,
    expiresAt: timestamp,
  })
  .strict()
  .superRefine((rotation, context) => {
    if (rotation.expiresAt <= rotation.issuedAt) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'expiresAt must be later than issuedAt',
      })
    }
    if (
      rotation.previousTransport.homeserver !== rotation.nextTransport.homeserver ||
      rotation.previousTransport.roomId !== rotation.nextTransport.roomId ||
      rotation.previousTransport.userId !== rotation.nextTransport.userId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['nextTransport'],
        message: 'Matrix device rotation cannot change homeserver, room, or user identity',
      })
    }
    if (
      rotation.previousTransport.deviceId === rotation.nextTransport.deviceId &&
      rotation.previousTransport.ed25519 === rotation.nextTransport.ed25519
    ) {
      context.addIssue({
        code: 'custom',
        path: ['nextTransport'],
        message: 'Matrix device rotation must replace the device identity',
      })
    }
  })

export type GatewayDeviceRotation = z.infer<typeof gatewayDeviceRotationSchema>

export const signedGatewayDeviceRotationSchema = z
  .object({
    rotation: gatewayDeviceRotationSchema,
    signature: pairingSignatureSchema,
  })
  .strict()

export type SignedGatewayDeviceRotation = z.infer<typeof signedGatewayDeviceRotationSchema>

export const PAIRING_LINK_PREFIX = 'codever://pair?data=' as const

function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new TypeError('Invalid pairing link payload')
  const padded =
    value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export function encodePairingLink(input: SignedPairingOffer): string {
  const offer = signedPairingOfferSchema.parse(input)
  const encoded = encodeBase64Url(new TextEncoder().encode(canonicalJson(offer)))
  return `${PAIRING_LINK_PREFIX}${encoded}`
}

export function decodePairingLink(input: string): SignedPairingOffer {
  if (!input.startsWith(PAIRING_LINK_PREFIX)) throw new TypeError('Invalid Codever pairing link')
  const encoded = input.slice(PAIRING_LINK_PREFIX.length)
  let decoded: unknown
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64Url(encoded)))
  } catch (error) {
    throw new TypeError('Invalid pairing link payload', { cause: error })
  }
  return signedPairingOfferSchema.parse(decoded)
}
