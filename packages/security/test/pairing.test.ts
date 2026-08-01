import { describe, expect, it } from 'vitest'
import type {
  MatrixTransportBinding,
  PairingCertificate,
  PairingOffer,
  PairingRejection,
  PairingRequest,
  PairingResponse,
  SignedPairingOffer,
  SignedPairingRequest,
} from '@codever/protocol'
import {
  exportPairingPublicKey,
  generateDeviceKeyPair,
  generatePairingChallenge,
  InMemoryReplayStore,
  pairingOfferDigest,
  pairingRequestDigest,
  PairingOfferGuard,
  signGatewayDeviceRotation,
  signGatewayTransportSnapshot,
  signPairingCertificate,
  signPairingOffer,
  signPairingRejection,
  signPairingRequest,
  signPairingResponse,
  verifyGatewayDeviceRotation,
  verifyGatewayTransportSnapshot,
  verifyPairingOffer,
  verifyPairingRejection,
  verifyPairingRequest,
  verifyPairingResponse,
} from '../src/index.js'

const now = 1_800_000_000_000
const gatewayTransport: MatrixTransportBinding = {
  homeserver: 'https://matrix.example.org',
  roomId: '!private:example.org',
  userId: '@gateway:example.org',
  deviceId: 'GATEWAY1',
  ed25519: 'gateway-ed25519-fingerprint',
}
const deviceTransport: MatrixTransportBinding = {
  homeserver: 'https://matrix.example.org',
  roomId: '!private:example.org',
  userId: '@alice:example.org',
  deviceId: 'PHONE1',
  ed25519: 'phone-ed25519-fingerprint',
}

async function handshake(timestamps: {
  offerIssuedAt?: number
  requestIssuedAt?: number
  certificateIssuedAt?: number
  responseIssuedAt?: number
} = {}) {
  const gatewayKeys = await generateDeviceKeyPair()
  const deviceKeys = await generateDeviceKeyPair()
  const offerDocument: PairingOffer = {
    kind: 'codever.pairing.offer',
    version: 1,
    offerId: 'offer-1',
    gatewayId: 'gateway-1',
    gatewayName: 'Studio gateway',
    gatewayKey: await exportPairingPublicKey(gatewayKeys.publicKey),
    gatewayTransport,
    challenge: generatePairingChallenge(),
    allowedOperations: ['prompt', 'cancel'],
    issuedAt: timestamps.offerIssuedAt ?? now - 1_000,
    expiresAt: now + 60_000,
  }
  const offer = await signPairingOffer(
    offerDocument,
    gatewayKeys.privateKey,
    gatewayKeys.keyId,
  )
  const requestIssuedAt = timestamps.requestIssuedAt ?? now
  const requestDocument: PairingRequest = {
    kind: 'codever.pairing.request',
    version: 1,
    requestId: 'request-1',
    offerId: offer.offer.offerId,
    offerDigest: await pairingOfferDigest(offer),
    gatewayId: offer.offer.gatewayId,
    deviceId: 'phone-1',
    deviceName: 'Alice phone',
    deviceKey: await exportPairingPublicKey(deviceKeys.publicKey),
    deviceTransport,
    requestedOperations: ['prompt'],
    issuedAt: requestIssuedAt,
    expiresAt: Math.min(offer.offer.expiresAt, requestIssuedAt + 30_000),
  }
  const request = await signPairingRequest(
    requestDocument,
    offer,
    deviceKeys.privateKey,
    deviceKeys.keyId,
  )
  const certificateDocument: PairingCertificate = {
    kind: 'codever.pairing.certificate',
    version: 1,
    certificateId: 'certificate-1',
    offerId: offer.offer.offerId,
    offerDigest: await pairingOfferDigest(offer),
    requestId: request.request.requestId,
    requestDigest: await pairingRequestDigest(request),
    gatewayId: offer.offer.gatewayId,
    gatewayKeyId: gatewayKeys.keyId,
    gatewayTransport,
    deviceId: request.request.deviceId,
    deviceName: request.request.deviceName,
    deviceKey: request.request.deviceKey,
    deviceTransport,
    allowedOperations: ['prompt'],
    issuedAt: timestamps.certificateIssuedAt ?? now + 1,
    expiresAt: now + 24 * 60 * 60_000,
  }
  const certificate = await signPairingCertificate(
    certificateDocument,
    offer,
    request,
    gatewayKeys.privateKey,
    gatewayKeys.keyId,
  )
  const responseDocument: PairingResponse = {
    kind: 'codever.pairing.response',
    version: 1,
    offerId: offer.offer.offerId,
    requestId: request.request.requestId,
    requestDigest: await pairingRequestDigest(request),
    gatewayId: offer.offer.gatewayId,
    certificate,
    issuedAt: timestamps.responseIssuedAt ?? now + 2,
    expiresAt: now + 90_000,
  }
  const response = await signPairingResponse(
    responseDocument,
    gatewayKeys.privateKey,
    gatewayKeys.keyId,
  )
  return { gatewayKeys, deviceKeys, offer, request, response }
}

describe('independent Codever pairing', () => {
  it('completes a signed offer/request/certificate/response handshake', async () => {
    const { gatewayKeys, offer, request, response } = await handshake()
    await expect(
      verifyPairingOffer(offer, gatewayKeys.publicKey, { now }),
    ).resolves.toMatchObject({ gatewayId: 'gateway-1' })
    await expect(verifyPairingRequest(request, offer, { now })).resolves.toMatchObject({
      deviceId: 'phone-1',
    })
    await expect(verifyPairingResponse(response, offer, request, { now })).resolves.toMatchObject({
      gatewayId: 'gateway-1',
      certificate: {
        certificate: {
          deviceId: 'phone-1',
          allowedOperations: ['prompt'],
        },
      },
    })
  })

  it('verifies a persisted response after the one-time offer has expired', async () => {
    const { offer, request, response } = await handshake()
    await expect(
      verifyPairingResponse(response, offer, request, {
        now: offer.offer.expiresAt + 1,
      }),
    ).resolves.toMatchObject({ requestId: request.request.requestId })
  })

  it('uses signed digests instead of cross-device clock order for causality', async () => {
    const joiningDeviceAhead = await handshake({
      requestIssuedAt: now + 113,
      certificateIssuedAt: now,
      responseIssuedAt: now,
    })
    await expect(
      verifyPairingResponse(
        joiningDeviceAhead.response,
        joiningDeviceAhead.offer,
        joiningDeviceAhead.request,
        { now: now + 113 },
      ),
    ).resolves.toMatchObject({ requestId: 'request-1' })

    const joiningDeviceBehind = await handshake({
      offerIssuedAt: now,
      requestIssuedAt: now - 10_000,
      certificateIssuedAt: now,
      responseIssuedAt: now,
    })
    await expect(
      verifyPairingResponse(
        joiningDeviceBehind.response,
        joiningDeviceBehind.offer,
        joiningDeviceBehind.request,
        { now },
      ),
    ).resolves.toMatchObject({ requestId: 'request-1' })
  })

  it('still rejects independently signed documents beyond the future-skew policy', async () => {
    const atBoundary = await handshake({ requestIssuedAt: now + 30_000 })
    await expect(
      verifyPairingRequest(atBoundary.request, atBoundary.offer, { now }),
    ).resolves.toMatchObject({ requestId: 'request-1' })

    const { offer, request } = await handshake({ requestIssuedAt: now + 30_001 })
    await expect(
      verifyPairingRequest(request, offer, { now }),
    ).rejects.toMatchObject({ code: 'issued_in_future' })
  })

  it('accepts only Gateway-signed rejections bound to the exact request digest', async () => {
    const { gatewayKeys, offer, request } = await handshake()
    const document: PairingRejection = {
      kind: 'codever.pairing.rejection',
      version: 1,
      offerId: offer.offer.offerId,
      requestId: request.request.requestId,
      requestDigest: await pairingRequestDigest(request),
      gatewayId: offer.offer.gatewayId,
      code: 'gateway_error',
      message: 'The Gateway could not complete secure pairing.',
      retryable: true,
      issuedAt: now,
      expiresAt: now + 60_000,
    }
    const rejection = await signPairingRejection(
      document,
      gatewayKeys.privateKey,
      gatewayKeys.keyId,
    )
    await expect(
      verifyPairingRejection(rejection, offer, request, { now }),
    ).resolves.toMatchObject({ code: 'gateway_error', retryable: true })

    const rebound = structuredClone(rejection)
    rebound.rejection.requestId = 'another-request'
    await expect(
      verifyPairingRejection(rebound, offer, request, { now }),
    ).rejects.toMatchObject({ code: 'binding_mismatch' })
  })

  it('never sends the one-time challenge in the Matrix request or response', async () => {
    const { offer, request, response } = await handshake()
    expect(JSON.stringify(request)).not.toContain(offer.offer.challenge)
    expect(JSON.stringify(response)).not.toContain(offer.offer.challenge)
  })

  it('rejects a request signed with a different hidden challenge', async () => {
    const { gatewayKeys, offer, request } = await handshake()
    const changedOfferDocument = {
      ...offer.offer,
      challenge: generatePairingChallenge(),
    }
    const changedOffer = await signPairingOffer(
      changedOfferDocument,
      gatewayKeys.privateKey,
      gatewayKeys.keyId,
    )
    const rebound: SignedPairingRequest = {
      ...request,
      request: {
        ...request.request,
        offerDigest: await pairingOfferDigest(changedOffer),
      },
    }
    await expect(
      verifyPairingRequest(rebound, changedOffer, { now }),
    ).rejects.toMatchObject({ code: 'invalid_signature' })
  })

  it('rejects Matrix device substitution even though Matrix is only transport', async () => {
    const { offer, request } = await handshake()
    const tampered = structuredClone(request)
    tampered.request.deviceTransport.deviceId = 'ATTACKER'
    await expect(
      verifyPairingRequest(tampered, offer, { now }),
    ).rejects.toMatchObject({ code: 'invalid_signature' })
  })

  it('atomically consumes an offer only once', async () => {
    const { offer, request } = await handshake()
    const guard = new PairingOfferGuard(new InMemoryReplayStore())
    await expect(guard.consume(offer, request, { now })).resolves.toMatchObject({
      requestId: 'request-1',
    })
    await expect(guard.consume(offer, request, { now })).rejects.toMatchObject({
      code: 'replay',
    })
  })

  it('rejects expired offers before accepting a request', async () => {
    const { offer, request } = await handshake()
    await expect(
      verifyPairingRequest(request, offer, { now: offer.offer.expiresAt }),
    ).rejects.toMatchObject({ code: 'expired' })
  })

  it('rejects a certificate transplanted into another handshake', async () => {
    const first = await handshake()
    const second = await handshake()
    const transplanted = structuredClone(first.response)
    transplanted.response.certificate = second.response.response.certificate
    await expect(
      verifyPairingResponse(transplanted, first.offer, first.request, { now }),
    ).rejects.toMatchObject({ code: 'binding_mismatch' })
  })
})

describe('Gateway Matrix device rotation', () => {
  it('accepts a new Matrix device only when signed by the stable Gateway key', async () => {
    const gatewayKeys = await generateDeviceKeyPair()
    const nextTransport = {
      ...gatewayTransport,
      deviceId: 'GATEWAY2',
      ed25519: 'replacement-ed25519-fingerprint',
    }
    const signed = await signGatewayDeviceRotation(
      {
        kind: 'codever.gateway.device-rotation',
        version: 1,
        rotationId: 'rotation-1',
        gatewayId: 'gateway-1',
        gatewayKeyId: gatewayKeys.keyId,
        previousTransport: gatewayTransport,
        nextTransport,
        issuedAt: now - 1,
        expiresAt: now + 60_000,
      },
      gatewayKeys.privateKey,
      gatewayKeys.keyId,
    )

    await expect(
      verifyGatewayDeviceRotation(
        signed,
        gatewayKeys.publicKey,
        { gatewayId: 'gateway-1', previousTransport: gatewayTransport },
        { now },
      ),
    ).resolves.toMatchObject({ nextTransport })
  })

  it('keeps a signed rotation verifiable while an authorized client was offline', async () => {
    const gatewayKeys = await generateDeviceKeyPair()
    const nextTransport = {
      ...gatewayTransport,
      deviceId: 'GATEWAY2',
      ed25519: 'replacement-ed25519-fingerprint',
    }
    const signed = await signGatewayDeviceRotation(
      {
        kind: 'codever.gateway.device-rotation',
        version: 1,
        rotationId: 'rotation-offline',
        gatewayId: 'gateway-1',
        gatewayKeyId: gatewayKeys.keyId,
        previousTransport: gatewayTransport,
        nextTransport,
        issuedAt: now,
        expiresAt: now + 366 * 24 * 60 * 60_000,
      },
      gatewayKeys.privateKey,
      gatewayKeys.keyId,
    )

    await expect(
      verifyGatewayDeviceRotation(
        signed,
        gatewayKeys.publicKey,
        {
          gatewayId: 'gateway-1',
          previousTransport: gatewayTransport,
          issuedAfter: now - 1,
        },
        { now: now + 30 * 24 * 60 * 60_000 },
      ),
    ).resolves.toMatchObject({ nextTransport })
  })

  it('rejects a signed rotation that does not advance the chain timestamp', async () => {
    const gatewayKeys = await generateDeviceKeyPair()
    const signed = await signGatewayDeviceRotation(
      {
        kind: 'codever.gateway.device-rotation',
        version: 1,
        rotationId: 'rotation-replay',
        gatewayId: 'gateway-1',
        gatewayKeyId: gatewayKeys.keyId,
        previousTransport: gatewayTransport,
        nextTransport: {
          ...gatewayTransport,
          deviceId: 'GATEWAY2',
          ed25519: 'replacement-ed25519-fingerprint',
        },
        issuedAt: now,
        expiresAt: now + 366 * 24 * 60 * 60_000,
      },
      gatewayKeys.privateKey,
      gatewayKeys.keyId,
    )

    await expect(
      verifyGatewayDeviceRotation(
        signed,
        gatewayKeys.publicKey,
        {
          gatewayId: 'gateway-1',
          previousTransport: gatewayTransport,
          issuedAfter: now,
        },
        { now },
      ),
    ).rejects.toMatchObject({ code: 'replay' })
  })

  it('rejects a rotation signed by an unrelated key', async () => {
    const legitimate = await generateDeviceKeyPair()
    const attacker = await generateDeviceKeyPair()
    const signed = await signGatewayDeviceRotation(
      {
        kind: 'codever.gateway.device-rotation',
        version: 1,
        rotationId: 'rotation-1',
        gatewayId: 'gateway-1',
        gatewayKeyId: attacker.keyId,
        previousTransport: gatewayTransport,
        nextTransport: {
          ...gatewayTransport,
          deviceId: 'GATEWAY2',
          ed25519: 'attacker-ed25519-fingerprint',
        },
        issuedAt: now - 1,
        expiresAt: now + 60_000,
      },
      attacker.privateKey,
      attacker.keyId,
    )
    await expect(
      verifyGatewayDeviceRotation(
        signed,
        legitimate.publicKey,
        { gatewayId: 'gateway-1', previousTransport: gatewayTransport },
        { now },
      ),
    ).rejects.toMatchObject({ code: 'binding_mismatch' })
  })
})

describe('Gateway Matrix transport snapshot', () => {
  it('recovers the current device directly from the stable Gateway key', async () => {
    const gatewayKeys = await generateDeviceKeyPair()
    const currentTransport = {
      ...gatewayTransport,
      deviceId: 'GATEWAY_CURRENT',
      ed25519: 'current-gateway-ed25519-fingerprint',
    }
    const signed = await signGatewayTransportSnapshot(
      {
        kind: 'codever.gateway.transport-snapshot',
        version: 1,
        snapshotId: 'snapshot-1',
        gatewayId: 'gateway-1',
        gatewayKeyId: gatewayKeys.keyId,
        transport: currentTransport,
        issuedAt: now,
        expiresAt: now + 366 * 24 * 60 * 60_000,
      },
      gatewayKeys.privateKey,
      gatewayKeys.keyId,
    )

    await expect(
      verifyGatewayTransportSnapshot(
        signed,
        gatewayKeys.publicKey,
        {
          gatewayId: 'gateway-1',
          currentTransport: gatewayTransport,
          issuedAfter: now - 1,
        },
        { now: now + 30 * 24 * 60 * 60_000 },
      ),
    ).resolves.toMatchObject({ transport: currentTransport })
  })

  it('rejects a root-signed snapshot that changes the Matrix room scope', async () => {
    const gatewayKeys = await generateDeviceKeyPair()
    const signed = await signGatewayTransportSnapshot(
      {
        kind: 'codever.gateway.transport-snapshot',
        version: 1,
        snapshotId: 'snapshot-wrong-room',
        gatewayId: 'gateway-1',
        gatewayKeyId: gatewayKeys.keyId,
        transport: {
          ...gatewayTransport,
          roomId: '!attacker:example.org',
          deviceId: 'GATEWAY_CURRENT',
          ed25519: 'current-gateway-ed25519-fingerprint',
        },
        issuedAt: now,
        expiresAt: now + 60_000,
      },
      gatewayKeys.privateKey,
      gatewayKeys.keyId,
    )

    await expect(
      verifyGatewayTransportSnapshot(
        signed,
        gatewayKeys.publicKey,
        {
          gatewayId: 'gateway-1',
          currentTransport: gatewayTransport,
          issuedAfter: now - 1,
        },
        { now },
      ),
    ).rejects.toMatchObject({ code: 'binding_mismatch' })
  })
})
