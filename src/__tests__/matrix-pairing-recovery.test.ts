import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  generateDeviceKeyPair,
  PairingOfferGuard,
  verifyGatewayTransportSnapshot,
  verifyPairingRejection,
} from '@codever/security'
import { CODEVER_GATEWAY_TRANSPORT_PROFILE_FIELD } from '@codever/protocol'
import { FileReplayStore } from '@codever/security/node'
import {
  CODEVER_MATRIX_EXTENSION,
  type MatrixIncomingEvent,
  type MatrixSendEventRequest,
} from '@/channel/matrix'
import type {
  MatrixGatewayClient,
  MatrixGatewayCryptoConfig,
  MatrixGatewayEventListener,
  MatrixGatewayTrustedDevice,
} from '@/gateway/matrix'
import {
  createSignedPairingRequest,
  FileGatewayIdentityStore,
  FileTrustedDeviceRegistry,
  GatewayPairingService,
  listenForMatrixPairingRequests,
  publishMatrixTransportSnapshot,
} from '@/gateway/pairing'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('long-lived Matrix pairing recovery', () => {
  it('publishes a root-signed current transport in the durable Gateway profile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codever-transport-state-'))
    temporaryDirectories.push(directory)
    const gatewayTransport = {
      homeserver: 'http://localhost:8008',
      roomId: '!secure:localhost',
      userId: '@gateway:localhost',
      deviceId: 'GATEWAY_MATRIX',
      ed25519: 'gateway-matrix-ed25519',
    }
    const identity = await new FileGatewayIdentityStore(
      join(directory, 'identity.json'),
    ).loadOrCreate('gateway-one')
    const registry = new FileTrustedDeviceRegistry(join(directory, 'registry.json'))
    const service = new GatewayPairingService(
      identity,
      registry,
      new PairingOfferGuard(new FileReplayStore(join(directory, 'offers.json'))),
    )
    const client = new FakePairingClient()

    await publishMatrixTransportSnapshot({
      client,
      service,
      registry,
      transport: gatewayTransport,
    })

    expect(client.profile).toEqual({
      key: CODEVER_GATEWAY_TRANSPORT_PROFILE_FIELD,
      value: expect.objectContaining({ version: 1 }),
    })
    const profileValue = client.profile?.value as Record<string, unknown>
    const signedSnapshot = profileValue.signed_snapshot
    await expect(
      verifyGatewayTransportSnapshot(
        signedSnapshot,
        identity.keys.publicKey,
        {
          gatewayId: identity.gatewayId,
          currentTransport: gatewayTransport,
        },
      ),
    ).resolves.toMatchObject({ transport: gatewayTransport })
    await expect(registry.getGatewayTransportHead()).resolves.toMatchObject({
      lastSnapshotIssuedAt: expect.any(Number),
    })
  })

  it('resends the exact persisted response for an already approved request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codever-pairing-recovery-'))
    temporaryDirectories.push(directory)
    const gatewayTransport = {
      homeserver: 'http://localhost:8008',
      roomId: '!secure:localhost',
      userId: '@gateway:localhost',
      deviceId: 'GATEWAY_MATRIX',
      ed25519: 'gateway-matrix-ed25519',
    }
    const deviceTransport = {
      homeserver: gatewayTransport.homeserver,
      roomId: gatewayTransport.roomId,
      userId: '@phone:localhost',
      deviceId: 'PHONE_MATRIX',
      ed25519: 'phone-matrix-ed25519',
    }
    const identity = await new FileGatewayIdentityStore(
      join(directory, 'identity.json'),
    ).loadOrCreate('gateway-one')
    const registry = new FileTrustedDeviceRegistry(join(directory, 'registry.json'))
    const service = new GatewayPairingService(
      identity,
      registry,
      new PairingOfferGuard(new FileReplayStore(join(directory, 'offers.json'))),
    )
    const offer = await service.createOffer({
      gatewayName: 'Gateway',
      gatewayTransport,
    })
    const request = await createSignedPairingRequest({
      signedOffer: offer.signedOffer,
      deviceId: 'phone-one',
      deviceName: 'Alice phone',
      deviceKeys: await generateDeviceKeyPair(),
      deviceTransport,
    })
    const first = await service.receiveRequest(request.signedRequest)
    const client = new FakePairingClient()
    const onRejected = vi.fn()
    let provisioningAttempts = 0
    const stop = listenForMatrixPairingRequests({
      client,
      service,
      registry,
      gatewayTransport,
      onProvisioned: async record => {
        provisioningAttempts += 1
        expect(record.certificate.certificate.deviceId).toBe('phone-one')
        expect(client.sent).toHaveLength(0)
        if (provisioningAttempts === 1) {
          throw new Error('Room State publication interrupted')
        }
      },
      onRejected,
    })

    client.emit({
      roomId: gatewayTransport.roomId,
      eventId: '$request-retry',
      eventType: 'm.room.message',
      sender: deviceTransport.userId,
      senderDeviceId: deviceTransport.ed25519,
      encrypted: true,
      content: {
        msgtype: 'm.text',
        body: 'Pairing request',
        [CODEVER_MATRIX_EXTENSION]: {
          version: 1,
          kind: 'pairing_request',
          pairing_request: request.signedRequest,
        },
      },
    })

    await vi.waitFor(() => expect(onRejected).toHaveBeenCalledOnce())
    expect(client.sent).toHaveLength(0)
    await expect(registry.listActive()).resolves.toHaveLength(1)

    // The same signed request is recoverable after the durable pairing record
    // was written but Room State publication failed. No pairing response is
    // observable until provisioning succeeds.
    client.emit({
      roomId: gatewayTransport.roomId,
      eventId: '$request-retry-after-state-failure',
      eventType: 'm.room.message',
      sender: deviceTransport.userId,
      senderDeviceId: deviceTransport.ed25519,
      encrypted: true,
      content: {
        msgtype: 'm.text',
        body: 'Pairing request',
        [CODEVER_MATRIX_EXTENSION]: {
          version: 1,
          kind: 'pairing_request',
          pairing_request: request.signedRequest,
        },
      },
    })

    await vi.waitFor(() => expect(client.sent).toHaveLength(1))
    expect(provisioningAttempts).toBe(2)
    const extension = client.sent[0]?.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
    expect(extension.pairing_response).toEqual(first.response)
    expect(client.pinned).toHaveLength(2)
    await expect(registry.listActive()).resolves.toHaveLength(1)

    const unusedOffer = await service.createOffer({
      gatewayName: 'Gateway',
      gatewayTransport,
    })
    const newRequest = await createSignedPairingRequest({
      signedOffer: unusedOffer.signedOffer,
      deviceId: 'phone-two',
      deviceName: 'Second phone',
      deviceKeys: await generateDeviceKeyPair(),
      deviceTransport: {
        ...deviceTransport,
        deviceId: 'PHONE_MATRIX_TWO',
        ed25519: 'phone-matrix-ed25519-two',
      },
    })
    client.emit({
      roomId: gatewayTransport.roomId,
      eventId: '$new-request',
      eventType: 'm.room.message',
      sender: newRequest.signedRequest.request.deviceTransport.userId,
      senderDeviceId: newRequest.signedRequest.request.deviceTransport.ed25519,
      encrypted: true,
      content: {
        [CODEVER_MATRIX_EXTENSION]: {
          version: 1,
          kind: 'pairing_request',
          pairing_request: newRequest.signedRequest,
        },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(client.sent).toHaveLength(1)
    await expect(registry.getOffer(unusedOffer.signedOffer.offer.offerId))
      .resolves.toBeDefined()

    stop()
    const stopNewPairing = listenForMatrixPairingRequests({
      client,
      service,
      registry,
      gatewayTransport,
      acceptNewOffers: true,
      onProvisioned: () => undefined,
    })
    client.emit({
      roomId: gatewayTransport.roomId,
      eventId: '$new-request-approved',
      eventType: 'm.room.message',
      sender: newRequest.signedRequest.request.deviceTransport.userId,
      senderDeviceId: newRequest.signedRequest.request.deviceTransport.ed25519,
      encrypted: true,
      content: {
        [CODEVER_MATRIX_EXTENSION]: {
          version: 1,
          kind: 'pairing_request',
          pairing_request: newRequest.signedRequest,
        },
      },
    })
    await vi.waitFor(() => expect(client.sent).toHaveLength(2))
    await expect(registry.listActive()).resolves.toHaveLength(2)
    stopNewPairing()

    client.emit({
      roomId: gatewayTransport.roomId,
      eventId: '$request-after-stop',
      eventType: 'm.room.message',
      sender: deviceTransport.userId,
      senderDeviceId: deviceTransport.ed25519,
      encrypted: true,
      content: {
        [CODEVER_MATRIX_EXTENSION]: {
          version: 1,
          kind: 'pairing_request',
          pairing_request: request.signedRequest,
        },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(client.sent).toHaveLength(2)
  })

  it('returns an immediate signed rejection for a verified approval failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codever-pairing-rejection-'))
    temporaryDirectories.push(directory)
    const gatewayTransport = {
      homeserver: 'http://localhost:8008',
      roomId: '!secure:localhost',
      userId: '@gateway:localhost',
      deviceId: 'GATEWAY_MATRIX',
      ed25519: 'gateway-matrix-ed25519',
    }
    const sharedKeys = await generateDeviceKeyPair()
    const identity = await new FileGatewayIdentityStore(
      join(directory, 'identity.json'),
    ).loadOrCreate('gateway-one')
    const registry = new FileTrustedDeviceRegistry(join(directory, 'registry.json'))
    const service = new GatewayPairingService(
      identity,
      registry,
      new PairingOfferGuard(new FileReplayStore(join(directory, 'offers.json'))),
    )
    const firstOffer = await service.createOffer({
      gatewayName: 'Gateway',
      gatewayTransport,
    })
    const firstRequest = await createSignedPairingRequest({
      signedOffer: firstOffer.signedOffer,
      deviceId: 'phone-one',
      deviceName: 'Alice phone',
      deviceKeys: sharedKeys,
      deviceTransport: {
        ...gatewayTransport,
        userId: '@alice:localhost',
        deviceId: 'PHONE_MATRIX',
        ed25519: 'phone-matrix-ed25519',
      },
    })
    await service.receiveRequest(firstRequest.signedRequest)

    const secondOffer = await service.createOffer({
      gatewayName: 'Gateway',
      gatewayTransport,
    })
    const secondRequest = await createSignedPairingRequest({
      signedOffer: secondOffer.signedOffer,
      deviceId: 'laptop-two',
      deviceName: 'Alice laptop',
      deviceKeys: sharedKeys,
      deviceTransport: {
        ...gatewayTransport,
        userId: '@alice:localhost',
        deviceId: 'LAPTOP_MATRIX',
        ed25519: 'laptop-matrix-ed25519',
      },
    })
    const client = new FakePairingClient()
    const onRejected = vi.fn()
    const stop = listenForMatrixPairingRequests({
      client,
      service,
      registry,
      gatewayTransport,
      acceptNewOffers: true,
      onProvisioned: () => undefined,
      onRejected,
    })

    client.emit({
      roomId: gatewayTransport.roomId,
      eventId: '$conflicting-request',
      eventType: 'm.room.message',
      sender: secondRequest.signedRequest.request.deviceTransport.userId,
      senderDeviceId: secondRequest.signedRequest.request.deviceTransport.ed25519,
      encrypted: true,
      content: {
        [CODEVER_MATRIX_EXTENSION]: {
          version: 1,
          kind: 'pairing_request',
          pairing_request: secondRequest.signedRequest,
        },
      },
    })

    await vi.waitFor(() => expect(client.sent).toHaveLength(1))
    const extension = client.sent[0]?.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
    expect(extension.kind).toBe('pairing_rejection')
    await expect(
      verifyPairingRejection(
        extension.pairing_rejection,
        secondOffer.signedOffer,
        secondRequest.signedRequest,
      ),
    ).resolves.toMatchObject({ code: 'device_conflict', retryable: false })
    expect(client.pinned).toHaveLength(1)
    await vi.waitFor(() => expect(onRejected).toHaveBeenCalledOnce())

    // The consumed offer remains recoverable through its durable pending
    // request, so an exact Matrix redelivery receives a prompt signed failure
    // instead of being ignored until the PWA times out.
    client.emit({
      roomId: gatewayTransport.roomId,
      eventId: '$conflicting-request-retry',
      eventType: 'm.room.message',
      sender: secondRequest.signedRequest.request.deviceTransport.userId,
      senderDeviceId: secondRequest.signedRequest.request.deviceTransport.ed25519,
      encrypted: true,
      content: {
        [CODEVER_MATRIX_EXTENSION]: {
          version: 1,
          kind: 'pairing_request',
          pairing_request: secondRequest.signedRequest,
        },
      },
    })
    await vi.waitFor(() => expect(client.sent).toHaveLength(2))
    await vi.waitFor(() => expect(onRejected).toHaveBeenCalledTimes(2))
    stop()
  })
})

class FakePairingClient implements MatrixGatewayClient {
  readonly sent: MatrixSendEventRequest[] = []
  profile: { key: string; value: unknown } | null = null
  readonly pinned: MatrixGatewayTrustedDevice[][] = []
  private readonly listeners = new Set<MatrixGatewayEventListener>()

  initializeCrypto(_config: MatrixGatewayCryptoConfig): Promise<void> {
    return Promise.resolve()
  }

  onRoomEvent(listener: MatrixGatewayEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): Promise<void> {
    return Promise.resolve()
  }

  waitUntilReady(): Promise<void> {
    return Promise.resolve()
  }

  assertRoomEncrypted(): Promise<void> {
    return Promise.resolve()
  }

  pinTrustedDevices(devices: MatrixGatewayTrustedDevice[]): Promise<void> {
    this.pinned.push(devices)
    return Promise.resolve()
  }

  sendEncryptedRoomEvent(request: MatrixSendEventRequest) {
    this.sent.push(request)
    return Promise.resolve({ eventId: `$sent-${this.sent.length}` })
  }

  setExtendedProfileProperty(key: string, value: unknown) {
    this.profile = { key, value }
    return Promise.resolve()
  }

  stop(): Promise<void> {
    return Promise.resolve()
  }

  emit(event: MatrixIncomingEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
