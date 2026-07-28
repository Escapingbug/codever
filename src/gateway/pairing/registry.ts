import { AtomicJsonFile, type FileStoreOptions } from '@codever/security/node'
import type {
  MatrixTransportBinding,
  SignedPairingCertificate,
  SignedPairingOffer,
  SignedPairingRequest,
  SignedPairingResponse,
} from '@codever/protocol'
import { canonicalJson } from '@codever/protocol'

export interface StoredPairingOffer {
  signedOffer: SignedPairingOffer
  status: 'open' | 'consumed'
  consumedAt?: number
  requestId?: string
}

export interface StoredPendingPairing {
  request: SignedPairingRequest
  verificationCode: string
  receivedAt: number
  status: 'pending' | 'approved' | 'denied'
  decidedAt?: number
  response?: SignedPairingResponse
}

export interface TrustedDeviceRecord {
  status: 'active' | 'revoked'
  certificate: SignedPairingCertificate
  /** Last Gateway Matrix device acknowledged by this PWA. */
  gatewayTransport: MatrixTransportBinding
  activatedAt: number
  revokedAt?: number
  revocationReason?: string
}

interface PairingState {
  version: 1
  offers: Record<string, StoredPairingOffer>
  pending: Record<string, StoredPendingPairing>
  trustedDevices: Record<string, TrustedDeviceRecord>
  gatewayTransport?: MatrixTransportBinding
  gatewayRotationIssuedAt?: number
}

function initialState(): PairingState {
  return { version: 1, offers: {}, pending: {}, trustedDevices: {} }
}

export class FileTrustedDeviceRegistry {
  private readonly file: AtomicJsonFile<PairingState>

  constructor(path: string, options: FileStoreOptions = {}) {
    this.file = new AtomicJsonFile(path, options)
  }

  async addOffer(signedOffer: SignedPairingOffer): Promise<void> {
    await this.file.transaction(initialState, (state) => {
      validateState(state)
      const id = signedOffer.offer.offerId
      if (state.offers[id]) throw new Error(`Pairing offer already exists: ${id}`)
      state.offers[id] = { signedOffer: structuredClone(signedOffer), status: 'open' }
      return { result: undefined, changed: true }
    })
  }

  async getOffer(offerId: string): Promise<SignedPairingOffer | undefined> {
    return this.file.transaction(initialState, (state) => {
      validateState(state)
      const stored = state.offers[offerId]
      return {
        result: stored?.status === 'open' ? structuredClone(stored.signedOffer) : undefined,
        changed: false,
      }
    })
  }

  async getOfferForAudit(offerId: string): Promise<SignedPairingOffer | undefined> {
    return this.file.transaction(initialState, (state) => {
      validateState(state)
      const stored = state.offers[offerId]
      return { result: stored ? structuredClone(stored.signedOffer) : undefined, changed: false }
    })
  }

  /**
   * Called only after PairingOfferGuard has durably consumed the challenge.
   */
  async addVerifiedRequest(
    offerId: string,
    pending: StoredPendingPairing,
    now: number,
  ): Promise<void> {
    await this.file.transaction(initialState, (state) => {
      validateState(state)
      const offer = state.offers[offerId]
      if (!offer || offer.status !== 'open') throw new Error('Pairing offer is unavailable')
      if (state.pending[pending.request.request.requestId]) {
        throw new Error('Pairing request already exists')
      }
      offer.status = 'consumed'
      offer.consumedAt = now
      offer.requestId = pending.request.request.requestId
      state.pending[pending.request.request.requestId] = structuredClone(pending)
      return { result: undefined, changed: true }
    })
  }

  async getPending(requestId: string): Promise<StoredPendingPairing | undefined> {
    return this.file.transaction(initialState, (state) => {
      validateState(state)
      const value = state.pending[requestId]
      return { result: value ? structuredClone(value) : undefined, changed: false }
    })
  }

  async approve(
    requestId: string,
    certificate: SignedPairingCertificate,
    response: SignedPairingResponse,
    now: number,
  ): Promise<TrustedDeviceRecord> {
    return this.file.transaction(initialState, (state) => {
      validateState(state)
      const pending = state.pending[requestId]
      if (!pending) throw new Error('Unknown pending pairing request')
      if (pending.status !== 'pending') throw new Error('Pairing request was already decided')
      const deviceId = certificate.certificate.deviceId
      const existing = state.trustedDevices[deviceId]
      if (existing?.status === 'active') throw new Error(`Device is already trusted: ${deviceId}`)
      const keyId = certificate.certificate.deviceKey.keyId
      const duplicateKey = Object.values(state.trustedDevices).find(record =>
        record.status === 'active'
        && record.certificate.certificate.deviceId !== deviceId
        && record.certificate.certificate.deviceKey.keyId === keyId,
      )
      if (duplicateKey) {
        throw new Error('An active device already uses this application key')
      }
      const record: TrustedDeviceRecord = {
        status: 'active',
        certificate: structuredClone(certificate),
        gatewayTransport: structuredClone(certificate.certificate.gatewayTransport),
        activatedAt: now,
      }
      pending.status = 'approved'
      pending.decidedAt = now
      pending.response = structuredClone(response)
      state.trustedDevices[deviceId] = record
      state.gatewayTransport = structuredClone(certificate.certificate.gatewayTransport)
      return { result: structuredClone(record), changed: true }
    })
  }

  async deny(requestId: string, now = Date.now()): Promise<void> {
    await this.file.transaction(initialState, (state) => {
      validateState(state)
      const pending = state.pending[requestId]
      if (!pending) throw new Error('Unknown pending pairing request')
      if (pending.status !== 'pending') throw new Error('Pairing request was already decided')
      pending.status = 'denied'
      pending.decidedAt = now
      return { result: undefined, changed: true }
    })
  }

  async revoke(deviceId: string, reason: string | undefined, now: number): Promise<void> {
    await this.file.transaction(initialState, (state) => {
      validateState(state)
      const record = state.trustedDevices[deviceId]
      if (!record) throw new Error(`Unknown trusted device: ${deviceId}`)
      if (record.status === 'revoked') throw new Error(`Device is already revoked: ${deviceId}`)
      record.status = 'revoked'
      record.revokedAt = now
      if (reason) record.revocationReason = reason
      return { result: undefined, changed: true }
    })
  }

  async get(deviceId: string): Promise<TrustedDeviceRecord | undefined> {
    return this.file.transaction(initialState, (state) => {
      validateState(state)
      const record = state.trustedDevices[deviceId]
      return { result: record ? structuredClone(record) : undefined, changed: false }
    })
  }

  async listActive(now = Date.now()): Promise<TrustedDeviceRecord[]> {
    return this.file.transaction(initialState, (state) => {
      validateState(state)
      return {
        result: Object.values(state.trustedDevices)
          .filter((record) =>
            record.status === 'active'
            && record.certificate.certificate.expiresAt > now,
          )
          .map((record) => structuredClone(record)),
        changed: false,
      }
    })
  }

  async updateGatewayTransport(
    deviceId: string,
    previous: MatrixTransportBinding,
    next: MatrixTransportBinding,
  ): Promise<void> {
    await this.file.transaction(initialState, (state) => {
      validateState(state)
      const record = state.trustedDevices[deviceId]
      if (!record || record.status !== 'active') {
        throw new Error(`Device is not actively trusted: ${deviceId}`)
      }
      const current = record.gatewayTransport
        ?? record.certificate.certificate.gatewayTransport
      if (canonicalJson(current) !== canonicalJson(previous)) {
        throw new Error(`Gateway transport changed concurrently for device ${deviceId}`)
      }
      record.gatewayTransport = structuredClone(next)
      state.gatewayTransport = structuredClone(next)
      return { result: undefined, changed: true }
    })
  }

  async getGatewayTransport(): Promise<MatrixTransportBinding | undefined> {
    return this.file.transaction(initialState, (state) => {
      validateState(state)
      return {
        result: state.gatewayTransport
          ? structuredClone(state.gatewayTransport)
          : Object.values(state.trustedDevices)[0]?.certificate.certificate.gatewayTransport,
        changed: false,
      }
    })
  }

  async getGatewayTransportHead(): Promise<{
    transport?: MatrixTransportBinding
    lastRotationIssuedAt?: number
  }> {
    return this.file.transaction(initialState, (state) => {
      validateState(state)
      return {
        result: {
          transport: state.gatewayTransport
            ? structuredClone(state.gatewayTransport)
            : Object.values(state.trustedDevices)[0]?.certificate.certificate.gatewayTransport,
          lastRotationIssuedAt: state.gatewayRotationIssuedAt,
        },
        changed: false,
      }
    })
  }

  async rotateGatewayTransport(
    previous: MatrixTransportBinding,
    next: MatrixTransportBinding,
    issuedAt = Date.now(),
  ): Promise<void> {
    await this.file.transaction(initialState, (state) => {
      validateState(state)
      const current = state.gatewayTransport
        ?? Object.values(state.trustedDevices)[0]?.certificate.certificate.gatewayTransport
      if (!current || canonicalJson(current) !== canonicalJson(previous)) {
        throw new Error('Gateway transport changed concurrently')
      }
      if (
        state.gatewayRotationIssuedAt !== undefined
        && issuedAt <= state.gatewayRotationIssuedAt
      ) {
        throw new Error('Gateway rotation timestamp did not advance')
      }
      state.gatewayTransport = structuredClone(next)
      state.gatewayRotationIssuedAt = issuedAt
      for (const record of Object.values(state.trustedDevices)) {
        if (record.status === 'active') record.gatewayTransport = structuredClone(next)
      }
      return { result: undefined, changed: true }
    })
  }
}

function validateState(state: PairingState): void {
  if (
    state.version !== 1 ||
    typeof state.offers !== 'object' ||
    !state.offers ||
    typeof state.pending !== 'object' ||
    !state.pending ||
    typeof state.trustedDevices !== 'object' ||
    !state.trustedDevices
  ) {
    throw new TypeError('Pairing registry state is invalid')
  }
}
