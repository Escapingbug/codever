import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateDeviceKeyPair, PairingOfferGuard } from '@codever/security'
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
    const stop = listenForMatrixPairingRequests({
      client,
      service,
      registry,
      gatewayTransport,
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

    await vi.waitFor(() => expect(client.sent).toHaveLength(1))
    const extension = client.sent[0]?.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
    expect(extension.pairing_response).toEqual(first.response)
    expect(client.pinned).toHaveLength(1)
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
    expect(client.sent).toHaveLength(1)
  })
})

class FakePairingClient implements MatrixGatewayClient {
  readonly sent: MatrixSendEventRequest[] = []
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

  stop(): Promise<void> {
    return Promise.resolve()
  }

  emit(event: MatrixIncomingEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
