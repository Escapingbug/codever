import {
  canonicalJson,
  canonicalJsonBytes,
  gatewayDeviceRotationSchema,
  pairingCertificateSchema,
  pairingOfferSchema,
  pairingRequestSchema,
  pairingResponseSchema,
  signedGatewayDeviceRotationSchema,
  signedPairingCertificateSchema,
  signedPairingOfferSchema,
  signedPairingRequestSchema,
  signedPairingResponseSchema,
  type GatewayDeviceRotation,
  type MatrixTransportBinding,
  type PairingCertificate,
  type PairingOffer,
  type PairingPublicKey,
  type PairingRequest,
  type PairingResponse,
  type SignedGatewayDeviceRotation,
  type SignedPairingCertificate,
  type SignedPairingOffer,
  type SignedPairingRequest,
  type SignedPairingResponse,
} from '@codever/protocol'
import {
  base64UrlDecode,
  base64UrlEncode,
  isCryptoKey,
  publicKeyId,
  sha256,
  toArrayBuffer,
  webCrypto,
} from './encoding.js'
import { exportPublicDeviceKey, importPublicDeviceKey } from './device-keys.js'
import { SecurityError } from './errors.js'
import type { ReplayStore } from './replay.js'

const algorithm: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' }
const DEFAULT_FUTURE_SKEW_MS = 30_000
const DEFAULT_OFFER_LIFETIME_MS = 10 * 60_000
const DEFAULT_REQUEST_LIFETIME_MS = 2 * 60_000
const DEFAULT_RESPONSE_LIFETIME_MS = 10 * 60_000
const DEFAULT_CERTIFICATE_LIFETIME_MS = 366 * 24 * 60 * 60_000
// A rotation is part of the durable transport-key chain, not a short-lived
// command. Keep it verifiable for as long as the longest certificate it can
// serve; otherwise a PWA that was offline could permanently lose the chain.
const DEFAULT_ROTATION_LIFETIME_MS = DEFAULT_CERTIFICATE_LIFETIME_MS

export interface PairingVerificationClock {
  now?: number
  maxFutureSkewMs?: number
}

interface TimeWindow {
  issuedAt: number
  expiresAt: number
}

function assertWindow(
  document: TimeWindow,
  clock: PairingVerificationClock,
  maxLifetimeMs: number,
): void {
  const now = clock.now ?? Date.now()
  const skew = clock.maxFutureSkewMs ?? DEFAULT_FUTURE_SKEW_MS
  if (document.expiresAt <= now) {
    throw new SecurityError('expired', 'Pairing document has expired')
  }
  if (document.issuedAt > now + skew) {
    throw new SecurityError('issued_in_future', 'Pairing document issue time is too far in the future')
  }
  if (document.expiresAt - document.issuedAt > maxLifetimeMs) {
    throw new SecurityError('lifetime_exceeded', 'Pairing document validity window exceeds policy')
  }
}

function equalDocument(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function assertEqual(left: unknown, right: unknown, message: string): void {
  if (!equalDocument(left, right)) throw new SecurityError('binding_mismatch', message)
}

function assertOperationsSubset(requested: readonly string[], allowed: readonly string[]): void {
  if (requested.some((operation) => !allowed.includes(operation))) {
    throw new SecurityError('binding_mismatch', 'Pairing capabilities exceed the signed offer')
  }
}

async function signDocument(domain: string, document: unknown, privateKey: CryptoKey): Promise<string> {
  const signature = await webCrypto().subtle.sign(
    algorithm,
    privateKey,
    toArrayBuffer(canonicalJsonBytes({ domain, document })),
  )
  return base64UrlEncode(new Uint8Array(signature))
}

async function signSecretBoundDocument(
  domain: string,
  challenge: string,
  document: unknown,
  privateKey: CryptoKey,
): Promise<string> {
  const signature = await webCrypto().subtle.sign(
    algorithm,
    privateKey,
    toArrayBuffer(canonicalJsonBytes({ challenge, document, domain })),
  )
  return base64UrlEncode(new Uint8Array(signature))
}

async function verifyDocument(
  domain: string,
  document: unknown,
  signature: string,
  publicKey: CryptoKey,
): Promise<boolean> {
  return webCrypto().subtle.verify(
    algorithm,
    publicKey,
    toArrayBuffer(base64UrlDecode(signature)),
    toArrayBuffer(canonicalJsonBytes({ domain, document })),
  )
}

async function verifySecretBoundDocument(
  domain: string,
  challenge: string,
  document: unknown,
  signature: string,
  publicKey: CryptoKey,
): Promise<boolean> {
  return webCrypto().subtle.verify(
    algorithm,
    publicKey,
    toArrayBuffer(base64UrlDecode(signature)),
    toArrayBuffer(canonicalJsonBytes({ challenge, document, domain })),
  )
}

async function checkedPairingKey(identity: PairingPublicKey): Promise<CryptoKey> {
  return importPublicDeviceKey(identity)
}

async function assertPinnedKey(
  identity: PairingPublicKey,
  pinned: CryptoKey | JsonWebKey | undefined,
): Promise<void> {
  if (pinned !== undefined && (await publicKeyId(pinned)) !== identity.keyId) {
    throw new SecurityError('key_mismatch', 'Gateway application key does not match the pinned key')
  }
}

export async function exportPairingPublicKey(publicKey: CryptoKey): Promise<PairingPublicKey> {
  return {
    ...(await exportPublicDeviceKey(publicKey)),
    publicKey: await webCrypto().subtle.exportKey('jwk', publicKey),
  } as PairingPublicKey
}

/** A 256-bit secret suitable for a QR/deep-link pairing offer. */
export function generatePairingChallenge(): string {
  return base64UrlEncode(webCrypto().getRandomValues(new Uint8Array(32)))
}

export async function pairingOfferDigest(input: SignedPairingOffer): Promise<string> {
  return sha256(canonicalJson(signedPairingOfferSchema.parse(input)))
}

export async function pairingRequestDigest(input: SignedPairingRequest): Promise<string> {
  return sha256(canonicalJson(signedPairingRequestSchema.parse(input)))
}

export async function signPairingOffer(
  input: PairingOffer,
  gatewayPrivateKey: CryptoKey,
  gatewayKeyId: string,
): Promise<SignedPairingOffer> {
  const offer = pairingOfferSchema.parse(input)
  if (offer.gatewayKey.keyId !== gatewayKeyId) {
    throw new SecurityError('key_mismatch', 'Offer Gateway key does not match its signer')
  }
  return {
    offer,
    signature: {
      algorithm: 'ES256',
      keyId: gatewayKeyId,
      value: await signDocument('codever.pairing.offer.v1', offer, gatewayPrivateKey),
    },
  }
}

/**
 * Verifies the self-signed QR offer. If a Gateway key was already pinned, it
 * must be supplied; for first pairing, physical QR/deep-link possession is the
 * trust bootstrap and the embedded key becomes the pin.
 */
export async function verifyPairingOffer(
  input: unknown,
  pinnedGatewayKey?: CryptoKey | JsonWebKey,
  clock: PairingVerificationClock = {},
): Promise<PairingOffer> {
  const signed = signedPairingOfferSchema.parse(input)
  const gatewayKey = await checkedPairingKey(signed.offer.gatewayKey)
  await assertPinnedKey(signed.offer.gatewayKey, pinnedGatewayKey)
  if (
    signed.signature.keyId !== signed.offer.gatewayKey.keyId ||
    !(await verifyDocument(
      'codever.pairing.offer.v1',
      signed.offer,
      signed.signature.value,
      gatewayKey,
    ))
  ) {
    throw new SecurityError('invalid_signature', 'Pairing offer signature is invalid')
  }
  assertWindow(signed.offer, clock, DEFAULT_OFFER_LIFETIME_MS)
  return signed.offer
}

/**
 * The one-time challenge participates in the signature preimage but is not
 * included in PairingRequest, so it never has to traverse Matrix.
 */
export async function signPairingRequest(
  input: PairingRequest,
  offer: SignedPairingOffer,
  devicePrivateKey: CryptoKey,
  deviceKeyId: string,
): Promise<SignedPairingRequest> {
  const request = pairingRequestSchema.parse(input)
  const parsedOffer = signedPairingOfferSchema.parse(offer)
  await assertRequestBindings(request, parsedOffer)
  if (request.deviceKey.keyId !== deviceKeyId) {
    throw new SecurityError('key_mismatch', 'Pairing request device key does not match its signer')
  }
  return {
    request,
    signature: {
      algorithm: 'ES256',
      keyId: deviceKeyId,
      value: await signSecretBoundDocument(
        'codever.pairing.request.v1',
        parsedOffer.offer.challenge,
        request,
        devicePrivateKey,
      ),
    },
  }
}

async function assertRequestBindings(
  request: PairingRequest,
  offer: SignedPairingOffer,
): Promise<void> {
  if (
    request.offerId !== offer.offer.offerId ||
    request.gatewayId !== offer.offer.gatewayId ||
    request.offerDigest !== (await pairingOfferDigest(offer))
  ) {
    throw new SecurityError('binding_mismatch', 'Pairing request is not bound to this offer')
  }
  assertOperationsSubset(request.requestedOperations, offer.offer.allowedOperations)
  if (
    request.issuedAt < offer.offer.issuedAt ||
    request.expiresAt > offer.offer.expiresAt
  ) {
    throw new SecurityError('binding_mismatch', 'Pairing request is outside the offer window')
  }
}

export async function verifyPairingRequest(
  input: unknown,
  offerInput: SignedPairingOffer,
  clock: PairingVerificationClock = {},
): Promise<PairingRequest> {
  const offer = signedPairingOfferSchema.parse(offerInput)
  await verifyPairingOffer(offer, undefined, clock)
  const signed = signedPairingRequestSchema.parse(input)
  await assertRequestBindings(signed.request, offer)
  const deviceKey = await checkedPairingKey(signed.request.deviceKey)
  if (
    signed.signature.keyId !== signed.request.deviceKey.keyId ||
    !(await verifySecretBoundDocument(
      'codever.pairing.request.v1',
      offer.offer.challenge,
      signed.request,
      signed.signature.value,
      deviceKey,
    ))
  ) {
    throw new SecurityError('invalid_signature', 'Pairing request signature is invalid')
  }
  assertWindow(signed.request, clock, DEFAULT_REQUEST_LIFETIME_MS)
  return signed.request
}

async function assertCertificateBindings(
  certificate: PairingCertificate,
  offer: SignedPairingOffer,
  request: SignedPairingRequest,
): Promise<void> {
  if (
    certificate.offerId !== offer.offer.offerId ||
    certificate.offerDigest !== (await pairingOfferDigest(offer)) ||
    certificate.requestId !== request.request.requestId ||
    certificate.requestDigest !== (await pairingRequestDigest(request)) ||
    certificate.gatewayId !== offer.offer.gatewayId ||
    certificate.gatewayKeyId !== offer.offer.gatewayKey.keyId ||
    certificate.deviceId !== request.request.deviceId ||
    certificate.deviceName !== request.request.deviceName
  ) {
    throw new SecurityError('binding_mismatch', 'Pairing certificate is not bound to the handshake')
  }
  assertEqual(
    certificate.gatewayTransport,
    offer.offer.gatewayTransport,
    'Certificate Gateway transport does not match the signed offer',
  )
  assertEqual(
    certificate.deviceKey,
    request.request.deviceKey,
    'Certificate device key does not match the signed request',
  )
  assertEqual(
    certificate.deviceTransport,
    request.request.deviceTransport,
    'Certificate device transport does not match the signed request',
  )
  assertOperationsSubset(certificate.allowedOperations, request.request.requestedOperations)
  if (certificate.issuedAt < request.request.issuedAt) {
    throw new SecurityError('binding_mismatch', 'Certificate predates the signed pairing request')
  }
}

export async function signPairingCertificate(
  input: PairingCertificate,
  offer: SignedPairingOffer,
  request: SignedPairingRequest,
  gatewayPrivateKey: CryptoKey,
  gatewayKeyId: string,
): Promise<SignedPairingCertificate> {
  const certificate = pairingCertificateSchema.parse(input)
  const parsedOffer = signedPairingOfferSchema.parse(offer)
  const parsedRequest = signedPairingRequestSchema.parse(request)
  await assertCertificateBindings(certificate, parsedOffer, parsedRequest)
  if (certificate.gatewayKeyId !== gatewayKeyId) {
    throw new SecurityError('key_mismatch', 'Certificate Gateway key does not match its signer')
  }
  return {
    certificate,
    signature: {
      algorithm: 'ES256',
      keyId: gatewayKeyId,
      value: await signDocument(
        'codever.pairing.certificate.v1',
        certificate,
        gatewayPrivateKey,
      ),
    },
  }
}

export async function verifyPairingCertificate(
  input: unknown,
  offerInput: SignedPairingOffer,
  requestInput: SignedPairingRequest,
  clock: PairingVerificationClock = {},
): Promise<PairingCertificate> {
  const signed = signedPairingCertificateSchema.parse(input)
  const offer = signedPairingOfferSchema.parse(offerInput)
  const request = signedPairingRequestSchema.parse(requestInput)
  await assertCertificateBindings(signed.certificate, offer, request)
  const gatewayKey = await checkedPairingKey(offer.offer.gatewayKey)
  if (
    signed.signature.keyId !== offer.offer.gatewayKey.keyId ||
    !(await verifyDocument(
      'codever.pairing.certificate.v1',
      signed.certificate,
      signed.signature.value,
      gatewayKey,
    ))
  ) {
    throw new SecurityError('invalid_signature', 'Pairing certificate signature is invalid')
  }
  assertWindow(signed.certificate, clock, DEFAULT_CERTIFICATE_LIFETIME_MS)
  return signed.certificate
}

export async function signPairingResponse(
  input: PairingResponse,
  gatewayPrivateKey: CryptoKey,
  gatewayKeyId: string,
): Promise<SignedPairingResponse> {
  const response = pairingResponseSchema.parse(input)
  if (
    response.gatewayId !== response.certificate.certificate.gatewayId ||
    response.certificate.certificate.gatewayKeyId !== gatewayKeyId ||
    response.certificate.signature.keyId !== gatewayKeyId
  ) {
    throw new SecurityError('binding_mismatch', 'Pairing response certificate is for another Gateway')
  }
  return {
    response,
    signature: {
      algorithm: 'ES256',
      keyId: gatewayKeyId,
      value: await signDocument('codever.pairing.response.v1', response, gatewayPrivateKey),
    },
  }
}

export async function verifyPairingResponse(
  input: unknown,
  offerInput: SignedPairingOffer,
  requestInput: SignedPairingRequest,
  clock: PairingVerificationClock = {},
): Promise<PairingResponse> {
  const signed = signedPairingResponseSchema.parse(input)
  const offer = signedPairingOfferSchema.parse(offerInput)
  const request = signedPairingRequestSchema.parse(requestInput)
  // A persisted response can be redelivered after its one-time offer/request
  // windows close. Revalidate those historical documents at their signed issue
  // times, while the response and certificate themselves are checked at `now`.
  await verifyPairingOffer(offer, undefined, {
    ...clock,
    now: offer.offer.issuedAt,
  })
  await verifyPairingRequest(request, offer, {
    ...clock,
    now: request.request.issuedAt,
  })
  const expectedRequestDigest = await pairingRequestDigest(request)
  if (
    signed.response.offerId !== offer.offer.offerId ||
    signed.response.requestId !== request.request.requestId ||
    signed.response.requestDigest !== expectedRequestDigest ||
    signed.response.gatewayId !== offer.offer.gatewayId ||
    signed.response.certificate.certificate.requestDigest !== expectedRequestDigest
  ) {
    throw new SecurityError('binding_mismatch', 'Pairing response is not bound to this handshake')
  }
  if (signed.response.issuedAt < request.request.issuedAt) {
    throw new SecurityError('binding_mismatch', 'Pairing response predates the signed request')
  }
  const gatewayKey = await checkedPairingKey(offer.offer.gatewayKey)
  if (
    signed.signature.keyId !== offer.offer.gatewayKey.keyId ||
    !(await verifyDocument(
      'codever.pairing.response.v1',
      signed.response,
      signed.signature.value,
      gatewayKey,
    ))
  ) {
    throw new SecurityError('invalid_signature', 'Pairing response signature is invalid')
  }
  assertWindow(signed.response, clock, DEFAULT_RESPONSE_LIFETIME_MS)
  await verifyPairingCertificate(signed.response.certificate, offer, request, clock)
  return signed.response
}

export async function signGatewayDeviceRotation(
  input: GatewayDeviceRotation,
  gatewayPrivateKey: CryptoKey,
  gatewayKeyId: string,
): Promise<SignedGatewayDeviceRotation> {
  const rotation = gatewayDeviceRotationSchema.parse(input)
  if (rotation.gatewayKeyId !== gatewayKeyId) {
    throw new SecurityError('key_mismatch', 'Rotation Gateway key does not match its signer')
  }
  return {
    rotation,
    signature: {
      algorithm: 'ES256',
      keyId: gatewayKeyId,
      value: await signDocument(
        'codever.gateway.device-rotation.v1',
        rotation,
        gatewayPrivateKey,
      ),
    },
  }
}

export async function verifyGatewayDeviceRotation(
  input: unknown,
  trustedGatewayKey: CryptoKey | JsonWebKey,
  expected: {
    gatewayId: string
    previousTransport: MatrixTransportBinding
    issuedAfter?: number
  },
  clock: PairingVerificationClock = {},
): Promise<GatewayDeviceRotation> {
  const signed = signedGatewayDeviceRotationSchema.parse(input)
  const expectedKeyId = await publicKeyId(trustedGatewayKey)
  if (
    signed.rotation.gatewayId !== expected.gatewayId ||
    signed.rotation.gatewayKeyId !== expectedKeyId
  ) {
    throw new SecurityError('binding_mismatch', 'Gateway rotation is not bound to the pinned identity')
  }
  assertEqual(
    signed.rotation.previousTransport,
    expected.previousTransport,
    'Gateway rotation does not continue from the pinned Matrix device',
  )
  if (
    expected.issuedAfter !== undefined &&
    signed.rotation.issuedAt <= expected.issuedAfter
  ) {
    throw new SecurityError(
      'replay',
      'Gateway rotation does not advance the signed rotation chain',
    )
  }
  const trustedPublicKey =
    isCryptoKey(trustedGatewayKey)
      ? trustedGatewayKey
      : await webCrypto().subtle.importKey(
          'jwk',
          trustedGatewayKey,
          { name: 'ECDSA', namedCurve: 'P-256' },
          false,
          ['verify'],
        )
  if (
    signed.signature.keyId !== expectedKeyId ||
    !(await verifyDocument(
      'codever.gateway.device-rotation.v1',
      signed.rotation,
      signed.signature.value,
      trustedPublicKey,
    ))
  ) {
    throw new SecurityError('invalid_signature', 'Gateway device rotation signature is invalid')
  }
  assertWindow(signed.rotation, clock, DEFAULT_ROTATION_LIFETIME_MS)
  return signed.rotation
}

/**
 * Atomically consumes the offer id and challenge after cryptographic
 * verification. A durable ReplayStore makes one-time pairing survive restarts.
 */
export class PairingOfferGuard {
  constructor(private readonly store: ReplayStore) {}

  async consume(
    offer: SignedPairingOffer,
    request: SignedPairingRequest,
    clock: PairingVerificationClock = {},
  ): Promise<PairingRequest> {
    const verified = await verifyPairingRequest(request, offer, clock)
    const challengeId = await sha256(offer.offer.challenge)
    const scope = canonicalJson([offer.offer.gatewayId, offer.offer.offerId])
    const accepted = await this.store.claimAll(
      [
        { key: `${scope}:pairing-offer`, expiresAt: offer.offer.expiresAt },
        { key: `${scope}:pairing-challenge:${challengeId}`, expiresAt: offer.offer.expiresAt },
      ],
      clock.now ?? Date.now(),
    )
    if (!accepted) {
      throw new SecurityError('replay', 'Pairing offer has already been consumed')
    }
    return verified
  }
}
