import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { decodePairingLink } from '@codever/protocol'
import {
  FileReplayStore,
} from '@codever/security/node'
import {
  generateDeviceKeyPair,
  PairingOfferGuard,
  verifyGatewayDeviceRotation,
  verifyGatewayTransportSnapshot,
  verifyPairingResponse,
} from '@codever/security'
import {
  createSignedPairingRequest,
  FileGatewayIdentityStore,
  FileTrustedDeviceRegistry,
  GatewayPairingService,
  trustedDeviceFromRecord,
} from '@/gateway/pairing'

const temporaryDirectories: string[] = []
const now = 1_800_000_000_000

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('Gateway pairing', () => {
  it('persists one stable Gateway application identity', async () => {
    const directory = await temporaryDirectory()
    const store = new FileGatewayIdentityStore(join(directory, 'identity.json'))
    const first = await store.loadOrCreate('gateway-one', now)
    const restarted = await new FileGatewayIdentityStore(
      join(directory, 'identity.json'),
    ).loadOrCreate('ignored-new-id', now + 1)

    expect(restarted.gatewayId).toBe('gateway-one')
    expect(restarted.keys.keyId).toBe(first.keys.keyId)
    expect(restarted.serialized.privateKey.d).toBe(first.serialized.privateKey.d)
  })

  it('automatically grants one valid hidden-challenge request and persists trust', async () => {
    const fixture = await pairingFixture()
    const { signedOffer, link } = await fixture.service.createOffer({
      gatewayName: 'Development Gateway',
      gatewayTransport: gatewayTransport(),
      now,
    })
    expect(decodePairingLink(link)).toEqual(signedOffer)

    const deviceKeys = await generateDeviceKeyPair()
    const request = await createSignedPairingRequest({
      signedOffer,
      deviceId: 'phone-one',
      deviceName: 'Alice phone',
      deviceKeys,
      deviceTransport: deviceTransport(),
      now: now + 1_000,
    })
    expect(request.signedRequest.request).not.toHaveProperty('challenge')

    const accepted = await fixture.service.receiveRequest(
      request.signedRequest,
      now + 2_000,
    )
    expect(accepted.verificationCode).toBe(request.verificationCode)
    await expect(
      verifyPairingResponse(
        accepted.response,
        signedOffer,
        request.signedRequest,
        { now: now + 2_000 },
      ),
    ).resolves.toMatchObject({
      gatewayId: fixture.identity.gatewayId,
      certificate: {
        certificate: {
          deviceId: 'phone-one',
        },
      },
    })

    const restartedRegistry = new FileTrustedDeviceRegistry(fixture.registryPath)
    await expect(restartedRegistry.get('phone-one')).resolves.toMatchObject({
      status: 'active',
      certificate: {
        certificate: {
          deviceId: 'phone-one',
          deviceTransport: { deviceId: 'PWA_DEVICE' },
        },
      },
    })

    const retried = await fixture.service.receiveRequest(
      request.signedRequest,
      now + 3_000,
    )
    expect(retried.response).toEqual(accepted.response)
    expect(retried.response.response.certificate.certificate.certificateId)
      .toBe(accepted.response.response.certificate.certificate.certificateId)
  })

  it('rejects a tampered request without consuming the offer', async () => {
    const fixture = await pairingFixture()
    const { signedOffer } = await fixture.service.createOffer({
      gatewayName: 'Development Gateway',
      gatewayTransport: gatewayTransport(),
      now,
    })
    const request = await createSignedPairingRequest({
      signedOffer,
      deviceId: 'phone-one',
      deviceName: 'Alice phone',
      deviceKeys: await generateDeviceKeyPair(),
      deviceTransport: deviceTransport(),
      now: now + 1_000,
    })
    const tampered = structuredClone(request.signedRequest)
    tampered.request.deviceName = 'Mallory phone'

    await expect(
      fixture.service.receiveRequest(tampered, now + 2_000),
    ).rejects.toMatchObject({ code: 'invalid_signature' })
    await expect(
      fixture.service.receiveRequest(request.signedRequest, now + 2_000),
    ).resolves.toMatchObject({ deviceId: 'phone-one' })
  })

  it('revokes a trusted device and excludes it from the active registry', async () => {
    const fixture = await pairingFixture()
    const { signedOffer } = await fixture.service.createOffer({
      gatewayName: 'Development Gateway',
      gatewayTransport: gatewayTransport(),
      now,
    })
    const request = await createSignedPairingRequest({
      signedOffer,
      deviceId: 'phone-one',
      deviceName: 'Alice phone',
      deviceKeys: await generateDeviceKeyPair(),
      deviceTransport: deviceTransport(),
      now: now + 1_000,
    })
    await fixture.service.receiveRequest(request.signedRequest, now + 2_000)
    await fixture.service.revoke('phone-one', 'lost device', now + 3_000)

    await expect(fixture.registry.listActive()).resolves.toEqual([])
    await expect(fixture.registry.get('phone-one')).resolves.toMatchObject({
      status: 'revoked',
      revocationReason: 'lost device',
      revokedAt: now + 3_000,
    })
  })

  it('renews an active device in place when the verified request uses the same application key', async () => {
    const fixture = await pairingFixture()
    const deviceKeys = await generateDeviceKeyPair()
    const firstOffer = await fixture.service.createOffer({
      gatewayName: 'Development Gateway',
      gatewayTransport: gatewayTransport(),
      allowedOperations: ['prompt', 'cancel', 'decision', 'session.settings'],
      now,
    })
    const firstRequest = await createSignedPairingRequest({
      signedOffer: firstOffer.signedOffer,
      deviceId: 'phone-one',
      deviceName: 'Alice phone',
      deviceKeys,
      deviceTransport: deviceTransport(),
      now: now + 1_000,
    })
    const first = await fixture.service.receiveRequest(firstRequest.signedRequest, now + 2_000)

    const renewalOffer = await fixture.service.createOffer({
      gatewayName: 'Development Gateway',
      gatewayTransport: gatewayTransport(),
      now: now + 3_000,
    })
    const renewalRequest = await createSignedPairingRequest({
      signedOffer: renewalOffer.signedOffer,
      deviceId: 'phone-one',
      deviceName: 'Alice phone',
      deviceKeys,
      deviceTransport: deviceTransport(),
      now: now + 4_000,
    })
    const renewed = await fixture.service.receiveRequest(
      renewalRequest.signedRequest,
      now + 5_000,
    )

    expect(renewed.response.response.activeDeviceCount).toBe(1)
    expect(renewed.response.response.certificate.certificate.allowedOperations)
      .toEqual(expect.arrayContaining(['session.create']))
    expect(renewed.response.response.certificate.certificate.allowedOperations)
      .not.toContain('session.select')
    const legacyRecord = await fixture.registry.get('phone-one')
    expect(legacyRecord).not.toBeNull()
    legacyRecord!.certificate.certificate.allowedOperations.push('session.select')
    expect(trustedDeviceFromRecord(legacyRecord!).allowedOperations)
      .not.toContain('session.select')
    expect(trustedDeviceFromRecord(legacyRecord!).allowedOperations)
      .toContain('device.invite')
    expect(renewed.response.response.certificate.certificate.certificateId)
      .not.toBe(first.response.response.certificate.certificate.certificateId)
    await expect(fixture.registry.listActive(now + 5_000)).resolves.toHaveLength(1)
    await expect(fixture.registry.get('phone-one')).resolves.toMatchObject({
      status: 'active',
      certificate: {
        certificate: {
          certificateId: renewed.response.response.certificate.certificate.certificateId,
        },
      },
    })
  })

  it('rejects renewal of an active device ID with a different application key', async () => {
    const fixture = await pairingFixture()
    const firstOffer = await fixture.service.createOffer({
      gatewayName: 'Development Gateway',
      gatewayTransport: gatewayTransport(),
      now,
    })
    const firstRequest = await createSignedPairingRequest({
      signedOffer: firstOffer.signedOffer,
      deviceId: 'phone-one',
      deviceName: 'Alice phone',
      deviceKeys: await generateDeviceKeyPair(),
      deviceTransport: deviceTransport(),
      now: now + 1_000,
    })
    const first = await fixture.service.receiveRequest(firstRequest.signedRequest, now + 2_000)

    const attackerOffer = await fixture.service.createOffer({
      gatewayName: 'Development Gateway',
      gatewayTransport: gatewayTransport(),
      now: now + 3_000,
    })
    const attackerRequest = await createSignedPairingRequest({
      signedOffer: attackerOffer.signedOffer,
      deviceId: 'phone-one',
      deviceName: 'Mallory phone',
      deviceKeys: await generateDeviceKeyPair(),
      deviceTransport: deviceTransport(),
      now: now + 4_000,
    })

    await expect(
      fixture.service.receiveRequest(attackerRequest.signedRequest, now + 5_000),
    ).rejects.toThrow('cannot renew with a different application key')
    await expect(fixture.registry.get('phone-one')).resolves.toMatchObject({
      certificate: {
        certificate: {
          certificateId: first.response.response.certificate.certificate.certificateId,
        },
      },
    })
  })

  it('rejects a second active device ID that reuses an application key', async () => {
    const fixture = await pairingFixture()
    const sharedKeys = await generateDeviceKeyPair()
    const firstOffer = await fixture.service.createOffer({
      gatewayName: 'Development Gateway',
      gatewayTransport: gatewayTransport(),
      now,
    })
    const first = await createSignedPairingRequest({
      signedOffer: firstOffer.signedOffer,
      deviceId: 'phone-one',
      deviceName: 'Alice phone',
      deviceKeys: sharedKeys,
      deviceTransport: deviceTransport(),
      now: now + 1_000,
    })
    await fixture.service.receiveRequest(first.signedRequest, now + 2_000)

    const secondOffer = await fixture.service.createOffer({
      gatewayName: 'Development Gateway',
      gatewayTransport: gatewayTransport(),
      now: now + 3_000,
    })
    const second = await createSignedPairingRequest({
      signedOffer: secondOffer.signedOffer,
      deviceId: 'laptop-two',
      deviceName: 'Alice laptop',
      deviceKeys: sharedKeys,
      deviceTransport: {
        ...deviceTransport(),
        deviceId: 'PWA_DEVICE_TWO',
        ed25519: 'device-ed25519-second-key',
      },
      now: now + 4_000,
    })

    await expect(
      fixture.service.receiveRequest(second.signedRequest, now + 5_000),
    ).rejects.toThrow('already uses this application key')
  })

  it('signs a Matrix device rotation with the stable Gateway key', async () => {
    const fixture = await pairingFixture()
    const previousTransport = gatewayTransport()
    const nextTransport = {
      ...previousTransport,
      deviceId: 'GATEWAY_NEXT',
      ed25519: 'gateway-ed25519-next-key',
    }
    const rotation = await fixture.service.signMatrixRotation(
      previousTransport,
      nextTransport,
      now,
    )

    await expect(
      verifyGatewayDeviceRotation(
        rotation,
        fixture.identity.keys.publicKey,
        { gatewayId: fixture.identity.gatewayId, previousTransport },
        { now },
      ),
    ).resolves.toMatchObject({ nextTransport })
  })

  it('signs a durable current-transport snapshot with the stable Gateway key', async () => {
    const fixture = await pairingFixture()
    const currentTransport = {
      ...gatewayTransport(),
      deviceId: 'GATEWAY_CURRENT',
      ed25519: 'gateway-ed25519-current-key',
    }
    const snapshot = await fixture.service.signMatrixTransportSnapshot(
      currentTransport,
      now,
    )

    await expect(
      verifyGatewayTransportSnapshot(
        snapshot,
        fixture.identity.keys.publicKey,
        {
          gatewayId: fixture.identity.gatewayId,
          currentTransport: gatewayTransport(),
          issuedAfter: now - 1,
        },
        { now },
      ),
    ).resolves.toMatchObject({ transport: currentTransport })
  })

  it('persists the acknowledged Gateway transport across restarts', async () => {
    const fixture = await pairingFixture()
    const previousTransport = gatewayTransport()
    const { signedOffer } = await fixture.service.createOffer({
      gatewayName: 'Development Gateway',
      gatewayTransport: previousTransport,
      now,
    })
    const request = await createSignedPairingRequest({
      signedOffer,
      deviceId: 'phone-one',
      deviceName: 'Alice phone',
      deviceKeys: await generateDeviceKeyPair(),
      deviceTransport: deviceTransport(),
      now: now + 1_000,
    })
    await fixture.service.receiveRequest(request.signedRequest, now + 2_000)

    const nextTransport = {
      ...previousTransport,
      deviceId: 'GATEWAY_NEXT',
      ed25519: 'gateway-ed25519-next-key',
    }
    await fixture.registry.rotateGatewayTransport(previousTransport, nextTransport, now)
    await fixture.registry.recordGatewayTransportSnapshot(nextTransport, now + 1)

    const restarted = new FileTrustedDeviceRegistry(fixture.registryPath)
    await expect(restarted.getGatewayTransport()).resolves.toEqual(nextTransport)
    await expect(restarted.getGatewayTransportHead()).resolves.toMatchObject({
      transport: nextTransport,
      lastRotationIssuedAt: now,
      lastSnapshotIssuedAt: now + 1,
    })
    await expect(
      restarted.rotateGatewayTransport(previousTransport, {
        ...nextTransport,
        deviceId: 'GATEWAY_ATTACKER',
      }, now + 1),
    ).rejects.toThrow('changed concurrently')
    await expect(
      restarted.rotateGatewayTransport(nextTransport, {
        ...nextTransport,
        deviceId: 'GATEWAY_LATER',
        ed25519: 'gateway-ed25519-later-key',
      }, now + 1),
    ).rejects.toThrow('timestamp did not advance')
  })
})

async function pairingFixture() {
  const directory = await temporaryDirectory()
  const identity = await new FileGatewayIdentityStore(
    join(directory, 'identity.json'),
  ).loadOrCreate('gateway-one', now)
  const registryPath = join(directory, 'registry.json')
  const registry = new FileTrustedDeviceRegistry(registryPath)
  const service = new GatewayPairingService(
    identity,
    registry,
    new PairingOfferGuard(new FileReplayStore(join(directory, 'offers-replay.json'))),
  )
  return { identity, registry, registryPath, service }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'codever-pairing-'))
  temporaryDirectories.push(directory)
  return directory
}

function gatewayTransport() {
  return {
    homeserver: 'http://localhost:8008',
    roomId: '!secure:localhost',
    userId: '@gateway:localhost',
    deviceId: 'GATEWAY_DEVICE',
    ed25519: 'gateway-ed25519-current-key',
  }
}

function deviceTransport() {
  return {
    homeserver: 'http://localhost:8008',
    roomId: '!secure:localhost',
    userId: '@tester:localhost',
    deviceId: 'PWA_DEVICE',
    ed25519: 'device-ed25519-current-key',
  }
}
