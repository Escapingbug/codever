import { describe, expect, it } from 'vitest'
import {
  createDeviceInvitationLink,
  decodeDeviceInvitationLink,
  decodePairingLink,
  encodePairingLink,
  gatewayDeviceRotationSchema,
  pairingCertificateSchema,
  pairingOfferSchema,
  pairingRequestSchema,
  pairingLinkFromDeviceInvitation,
  type SignedPairingOffer,
} from '../src/index.js'

const publicKey = {
  version: 1 as const,
  algorithm: 'ES256' as const,
  keyId: 'a'.repeat(43),
  publicKey: {
    kty: 'EC' as const,
    crv: 'P-256' as const,
    x: 'b'.repeat(43),
    y: 'c'.repeat(43),
    ext: true as const,
    key_ops: ['verify'] as ['verify'],
  },
}

const gatewayTransport = {
  homeserver: 'https://matrix.example.org',
  roomId: '!pairing:example.org',
  userId: '@gateway:example.org',
  deviceId: 'GATEWAY1',
  ed25519: 'gateway-ed25519-fingerprint',
}

describe('pairing schemas', () => {
  it('accepts a strict one-time offer', () => {
    expect(
      pairingOfferSchema.parse({
        kind: 'codever.pairing.offer',
        version: 1,
        offerId: 'offer-1',
        gatewayId: 'gateway-1',
        gatewayName: 'Studio gateway',
        gatewayKey: publicKey,
        gatewayTransport,
        challenge: 'd'.repeat(43),
        allowedOperations: ['prompt', 'cancel'],
        issuedAt: 1,
        expiresAt: 2,
      }),
    ).toMatchObject({ offerId: 'offer-1' })
  })

  it('rejects duplicate capabilities and unknown transport authority', () => {
    expect(
      pairingOfferSchema.safeParse({
        kind: 'codever.pairing.offer',
        version: 1,
        offerId: 'offer-1',
        gatewayId: 'gateway-1',
        gatewayName: 'Studio gateway',
        gatewayKey: publicKey,
        gatewayTransport,
        challenge: 'd'.repeat(43),
        allowedOperations: ['prompt', 'prompt'],
        issuedAt: 1,
        expiresAt: 2,
        matrixUserId: '@gateway:example.org',
      }).success,
    ).toBe(false)
  })

  it('requires request and certificate temporal windows', () => {
    expect(
      pairingRequestSchema.safeParse({
        kind: 'codever.pairing.request',
        version: 1,
        requestId: 'request-1',
        offerId: 'offer-1',
        offerDigest: 'e'.repeat(43),
        gatewayId: 'gateway-1',
        deviceId: 'phone-1',
        deviceName: 'Phone',
        deviceKey: publicKey,
        deviceTransport: {
          ...gatewayTransport,
          userId: '@phone:example.org',
          deviceId: 'PHONE1',
          ed25519: 'phone-ed25519-fingerprint',
        },
        requestedOperations: ['prompt'],
        issuedAt: 2,
        expiresAt: 2,
      }).success,
    ).toBe(false)

    expect(
      pairingCertificateSchema.safeParse({
        kind: 'codever.pairing.certificate',
        version: 1,
        certificateId: 'cert-1',
        offerId: 'offer-1',
        offerDigest: 'e'.repeat(43),
        requestId: 'request-1',
        requestDigest: 'f'.repeat(43),
        gatewayId: 'gateway-1',
        gatewayKeyId: 'a'.repeat(43),
        gatewayTransport,
        deviceId: 'phone-1',
        deviceName: 'Phone',
        deviceKey: publicKey,
        deviceTransport: {
          ...gatewayTransport,
          userId: '@phone:example.org',
          deviceId: 'PHONE1',
          ed25519: 'phone-ed25519-fingerprint',
        },
        allowedOperations: ['prompt'],
        issuedAt: 3,
        expiresAt: 3,
      }).success,
    ).toBe(false)
  })

  it('round-trips the canonical QR/deep-link form', () => {
    const signed: SignedPairingOffer = {
      offer: {
        kind: 'codever.pairing.offer',
        version: 1,
        offerId: 'offer-link',
        gatewayId: 'gateway-1',
        gatewayName: 'Studio gateway',
        gatewayKey: publicKey,
        gatewayTransport,
        challenge: 'd'.repeat(43),
        allowedOperations: ['prompt'],
        issuedAt: 1,
        expiresAt: 2,
      },
      signature: {
        algorithm: 'ES256',
        keyId: 'a'.repeat(43),
        value: 'signature',
      },
    }
    expect(decodePairingLink(encodePairingLink(signed))).toEqual(signed)
  })

  it('round-trips a PWA invitation without exposing a long-lived access token', () => {
    const signed: SignedPairingOffer = {
      offer: {
        kind: 'codever.pairing.offer',
        version: 1,
        offerId: 'offer-invitation',
        gatewayId: 'gateway-1',
        gatewayName: 'Studio gateway',
        gatewayKey: publicKey,
        gatewayTransport,
        challenge: 'd'.repeat(43),
        allowedOperations: ['prompt', 'device.invite'],
        issuedAt: 1,
        expiresAt: 300_001,
      },
      signature: {
        algorithm: 'ES256',
        keyId: 'a'.repeat(43),
        value: 'signature',
      },
    }
    const pairingLink = encodePairingLink(signed)
    const generated = createDeviceInvitationLink({
      pairingLink,
      appUrl: 'https://pwa.example/settings?discard=true',
      matrixLogin: {
        homeserver: gatewayTransport.homeserver,
        userId: '@pwa:example.org',
        loginToken: 'one-time-login-token',
        expiresAt: 120_001,
      },
    })

    expect(generated.link).not.toContain('discard=true')
    expect(generated.expiresAt).toBe(120_001)
    const decoded = decodeDeviceInvitationLink(generated.link)
    expect(decoded.matrixLogin?.loginToken).toBe('one-time-login-token')
    expect(pairingLinkFromDeviceInvitation(decoded)).toBe(pairingLink)
  })

  it('only accepts a device-key-only Matrix rotation', () => {
    const common = {
      kind: 'codever.gateway.device-rotation' as const,
      version: 1 as const,
      rotationId: 'rotation-1',
      gatewayId: 'gateway-1',
      gatewayKeyId: 'a'.repeat(43),
      previousTransport: gatewayTransport,
      issuedAt: 1,
      expiresAt: 2,
    }
    expect(
      gatewayDeviceRotationSchema.safeParse({
        ...common,
        nextTransport: {
          ...gatewayTransport,
          deviceId: 'GATEWAY2',
          ed25519: 'new-gateway-ed25519',
        },
      }).success,
    ).toBe(true)
    expect(
      gatewayDeviceRotationSchema.safeParse({
        ...common,
        nextTransport: {
          ...gatewayTransport,
          roomId: '!attacker:example.org',
          deviceId: 'GATEWAY2',
          ed25519: 'new-gateway-ed25519',
        },
      }).success,
    ).toBe(false)
  })
})
