import { randomUUID } from 'node:crypto'
import {
  canonicalJson,
  encodePairingLink,
  signedPairingRequestSchema,
  type GatewayDeviceRotation,
  type MatrixTransportBinding,
  type PairingCertificate,
  type PairingOffer,
  type PairingOperation,
  type PairingRequest,
  type PairingResponse,
  type SignedGatewayDeviceRotation,
  type SignedPairingOffer,
  type SignedPairingRequest,
  type SignedPairingResponse,
} from '@codever/protocol'
import {
  base64UrlDecode,
  exportPairingPublicKey,
  generatePairingChallenge,
  pairingOfferDigest,
  pairingRequestDigest,
  PairingOfferGuard,
  sha256,
  signGatewayDeviceRotation,
  signPairingCertificate,
  signPairingOffer,
  signPairingRequest,
  signPairingResponse,
  verifyPairingOffer,
  type DeviceKeyPair,
} from '@codever/security'
import type { GatewayPairingIdentity } from './identityStore.js'
import { FileTrustedDeviceRegistry } from './registry.js'

const DEFAULT_OFFER_LIFETIME_MS = 5 * 60_000
const MAX_OFFER_LIFETIME_MS = 10 * 60_000
const REQUEST_LIFETIME_MS = 2 * 60_000
const RESPONSE_LIFETIME_MS = 10 * 60_000
const CERTIFICATE_LIFETIME_MS = 365 * 24 * 60 * 60_000
// Rotations form a durable chain for clients that may be offline. This matches
// the maximum pairing-certificate lifetime enforced by the security package.
const ROTATION_LIFETIME_MS = 366 * 24 * 60 * 60_000
const allOperations: PairingOperation[] = [
  'prompt',
  'cancel',
  'decision',
  'session.settings',
]

export interface CreatePairingOfferInput {
  gatewayName: string
  gatewayTransport: MatrixTransportBinding
  allowedOperations?: PairingOperation[]
  lifetimeMs?: number
  now?: number
}

export interface CreatePairingRequestInput {
  signedOffer: SignedPairingOffer
  requestId?: string
  deviceId: string
  deviceName: string
  deviceKeys: DeviceKeyPair
  deviceTransport: MatrixTransportBinding
  requestedOperations?: PairingOperation[]
  now?: number
}

export interface PairingGrantPolicy {
  allowedOperations?: PairingOperation[]
  certificateLifetimeMs?: number
}

export class GatewayPairingService {
  constructor(
    private readonly identity: GatewayPairingIdentity,
    private readonly registry: FileTrustedDeviceRegistry,
    private readonly offerGuard: PairingOfferGuard,
  ) {}

  async createOffer(input: CreatePairingOfferInput): Promise<{
    signedOffer: SignedPairingOffer
    link: string
  }> {
    const now = input.now ?? Date.now()
    const lifetimeMs = input.lifetimeMs ?? DEFAULT_OFFER_LIFETIME_MS
    if (
      !Number.isSafeInteger(lifetimeMs) ||
      lifetimeMs < 30_000 ||
      lifetimeMs > MAX_OFFER_LIFETIME_MS
    ) {
      throw new RangeError('Pairing offer lifetime must be between 30 seconds and 10 minutes')
    }
    const offer: PairingOffer = {
      kind: 'codever.pairing.offer',
      version: 1,
      offerId: randomUUID(),
      gatewayId: this.identity.gatewayId,
      gatewayName: requireText(input.gatewayName, 'gatewayName', 128),
      gatewayKey: await exportPairingPublicKey(this.identity.keys.publicKey),
      gatewayTransport: input.gatewayTransport,
      challenge: generatePairingChallenge(),
      allowedOperations: unique(input.allowedOperations ?? allOperations),
      issuedAt: now,
      expiresAt: now + lifetimeMs,
    }
    const signedOffer = await signPairingOffer(
      offer,
      this.identity.keys.privateKey,
      this.identity.keys.keyId,
    )
    await this.registry.addOffer(signedOffer)
    return { signedOffer, link: encodePairingLink(signedOffer) }
  }

  async receiveRequest(input: unknown, now = Date.now()): Promise<{
    requestId: string
    deviceId: string
    deviceName: string
    verificationCode: string
    response: SignedPairingResponse
  }> {
    const signedRequest = signedPairingRequestSchema.parse(input)
    const existing = await this.registry.getPending(signedRequest.request.requestId)
    if (existing) {
      if (canonicalJson(existing.request) !== canonicalJson(signedRequest)) {
        throw new Error('Pairing request ID conflicts with a different signed request')
      }
      if (existing.status === 'approved' && existing.response) {
        return {
          requestId: signedRequest.request.requestId,
          deviceId: signedRequest.request.deviceId,
          deviceName: signedRequest.request.deviceName,
          verificationCode: existing.verificationCode,
          response: existing.response,
        }
      }
      if (existing.status === 'pending') {
        const response = await this.approve(existing.request.request.requestId, {}, now)
        return {
          requestId: signedRequest.request.requestId,
          deviceId: signedRequest.request.deviceId,
          deviceName: signedRequest.request.deviceName,
          verificationCode: existing.verificationCode,
          response,
        }
      }
      throw new Error('Pairing request was denied')
    }
    const signedOffer = await this.registry.getOffer(signedRequest.request.offerId)
    if (!signedOffer) throw new Error('Pairing offer is unavailable')

    const request = await this.offerGuard.consume(signedOffer, signedRequest, { now })
    const verificationCode = await pairingVerificationCode(
      signedOffer.offer.offerId,
      signedOffer.offer.challenge,
      signedOffer.offer.gatewayKey.keyId,
    )
    await this.registry.addVerifiedRequest(
      request.offerId,
      {
        request: signedRequest,
        status: 'pending',
        verificationCode,
        receivedAt: now,
      },
      now,
    )
    const response = await this.approve(request.requestId, {}, now)
    return {
      requestId: request.requestId,
      deviceId: request.deviceId,
      deviceName: request.deviceName,
      verificationCode,
      response,
    }
  }

  async approve(
    requestId: string,
    policy: PairingGrantPolicy = {},
    now = Date.now(),
  ): Promise<SignedPairingResponse> {
    const pending = await this.registry.getPending(requestId)
    if (pending?.status === 'approved' && pending.response) return pending.response
    if (!pending || pending.status !== 'pending') {
      throw new Error('Pairing request is not awaiting approval')
    }
    const request = pending.request
    const offer = await this.registry.getOfferForAudit(request.request.offerId)
    if (!offer) throw new Error('Pairing offer record is missing')
    const allowedOperations = constrainedOperations(
      request.request.requestedOperations,
      policy.allowedOperations,
    )
    const certificateLifetimeMs = policy.certificateLifetimeMs ?? CERTIFICATE_LIFETIME_MS
    if (
      !Number.isSafeInteger(certificateLifetimeMs) ||
      certificateLifetimeMs < 60_000 ||
      certificateLifetimeMs > 366 * 24 * 60 * 60_000
    ) {
      throw new RangeError('Certificate lifetime is outside policy')
    }
    const certificateDocument: PairingCertificate = {
      kind: 'codever.pairing.certificate',
      version: 1,
      certificateId: randomUUID(),
      offerId: offer.offer.offerId,
      offerDigest: await pairingOfferDigest(offer),
      requestId: request.request.requestId,
      requestDigest: await pairingRequestDigest(request),
      gatewayId: this.identity.gatewayId,
      gatewayKeyId: this.identity.keys.keyId,
      gatewayTransport: offer.offer.gatewayTransport,
      deviceId: request.request.deviceId,
      deviceName: request.request.deviceName,
      deviceKey: request.request.deviceKey,
      deviceTransport: request.request.deviceTransport,
      allowedOperations,
      issuedAt: now,
      expiresAt: now + certificateLifetimeMs,
    }
    const certificate = await signPairingCertificate(
      certificateDocument,
      offer,
      request,
      this.identity.keys.privateKey,
      this.identity.keys.keyId,
    )
    const responseDocument: PairingResponse = {
      kind: 'codever.pairing.response',
      version: 1,
      offerId: offer.offer.offerId,
      requestId: request.request.requestId,
      requestDigest: await pairingRequestDigest(request),
      gatewayId: this.identity.gatewayId,
      certificate,
      issuedAt: now,
      // The offer is already atomically consumed. Keep the exact persisted
      // response retryable after that short invitation window closes.
      expiresAt: now + RESPONSE_LIFETIME_MS,
    }
    const response = await signPairingResponse(
      responseDocument,
      this.identity.keys.privateKey,
      this.identity.keys.keyId,
    )
    await this.registry.approve(requestId, certificate, response, now)
    return response
  }

  async deny(requestId: string, now = Date.now()): Promise<void> {
    await this.registry.deny(requestId, now)
  }

  async revoke(deviceId: string, reason?: string, now = Date.now()): Promise<void> {
    await this.registry.revoke(
      deviceId,
      reason ? requireText(reason, 'reason', 1024) : undefined,
      now,
    )
  }

  async signMatrixRotation(
    previousTransport: MatrixTransportBinding,
    nextTransport: MatrixTransportBinding,
    now = Date.now(),
  ): Promise<SignedGatewayDeviceRotation> {
    const rotation: GatewayDeviceRotation = {
      kind: 'codever.gateway.device-rotation',
      version: 1,
      rotationId: randomUUID(),
      gatewayId: this.identity.gatewayId,
      gatewayKeyId: this.identity.keys.keyId,
      previousTransport,
      nextTransport,
      issuedAt: now,
      expiresAt: now + ROTATION_LIFETIME_MS,
    }
    return signGatewayDeviceRotation(
      rotation,
      this.identity.keys.privateKey,
      this.identity.keys.keyId,
    )
  }
}

export async function createSignedPairingRequest(
  input: CreatePairingRequestInput,
): Promise<{ signedRequest: SignedPairingRequest; verificationCode: string }> {
  const now = input.now ?? Date.now()
  const offer = await verifyPairingOffer(input.signedOffer, undefined, { now })
  const deviceKey = await exportPairingPublicKey(input.deviceKeys.publicKey)
  const request: PairingRequest = {
    kind: 'codever.pairing.request',
    version: 1,
    requestId: input.requestId ?? randomUUID(),
    offerId: offer.offerId,
    offerDigest: await pairingOfferDigest(input.signedOffer),
    gatewayId: offer.gatewayId,
    deviceId: requireText(input.deviceId, 'deviceId'),
    deviceName: requireText(input.deviceName, 'deviceName', 128),
    deviceKey,
    deviceTransport: input.deviceTransport,
    requestedOperations: unique(input.requestedOperations ?? offer.allowedOperations),
    issuedAt: now,
    expiresAt: Math.min(offer.expiresAt, now + REQUEST_LIFETIME_MS),
  }
  const signedRequest = await signPairingRequest(
    request,
    input.signedOffer,
    input.deviceKeys.privateKey,
    input.deviceKeys.keyId,
  )
  return {
    signedRequest,
    verificationCode: await pairingVerificationCode(
      offer.offerId,
      offer.challenge,
      offer.gatewayKey.keyId,
    ),
  }
}

export async function pairingVerificationCode(
  offerId: string,
  challenge: string,
  gatewayKeyId: string,
): Promise<string> {
  const digest = base64UrlDecode(
    await sha256(canonicalJson({ offerId, challenge, gatewayKeyId })),
  )
  const value =
    (((digest[0] ?? 0) << 16) | ((digest[1] ?? 0) << 8) | (digest[2] ?? 0)) %
    1_000_000
  return value.toString().padStart(6, '0')
}

function constrainedOperations(
  requested: PairingOperation[],
  policy?: PairingOperation[],
): PairingOperation[] {
  const normalized = unique(requested)
  if (!policy) return normalized
  const allowed = new Set(unique(policy))
  if (normalized.some((operation) => !allowed.has(operation))) {
    throw new Error('Requested operation exceeds the approval policy')
  }
  return normalized
}

function unique<T extends string>(values: T[]): T[] {
  if (new Set(values).size !== values.length) throw new Error('Pairing values must be unique')
  return [...values]
}

function requireText(value: string, label: string, max = 256): string {
  if (!value.trim() || value.length > max) throw new TypeError(`${label} is invalid`)
  return value
}
