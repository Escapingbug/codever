import { randomUUID } from 'node:crypto'
import {
  CODEVER_GATEWAY_TRANSPORT_PROFILE_FIELD,
  signedPairingRequestSchema,
  type MatrixTransportBinding,
  type SignedPairingRequest,
} from '@codever/protocol'
import type { MatrixIncomingEvent } from '@/channel/matrix'
import { CODEVER_MATRIX_EXTENSION } from '@/channel/matrix'
import type {
  MatrixGatewayClient,
  MatrixGatewayPinnedTransportDevice,
  MatrixGatewayTrustedDevice,
} from '@/gateway/matrix'
import type { FileTrustedDeviceRegistry, TrustedDeviceRecord } from './registry.js'
import type { GatewayPairingService } from './service.js'

export interface MatrixPairingRequestOptions {
  client: MatrixGatewayClient
  service: GatewayPairingService
  registry: FileTrustedDeviceRegistry
  gatewayTransport: MatrixTransportBinding
  /**
   * Commits every Gateway-side resource the new device needs before the
   * signed response makes pairing observable to that device. Throwing keeps
   * the persisted request recoverable and suppresses the response.
   */
  onProvisioned: (record: TrustedDeviceRecord) => void | Promise<void>
  onRejected?: (error: unknown) => void
}

export interface MatrixPairingListenerOptions extends MatrixPairingRequestOptions {
  onAccepted?: (record: TrustedDeviceRecord) => void | Promise<void>
  /** Accepts a new request only when its explicit offer is still open. */
  acceptNewOffers?: boolean
}

export async function announceMatrixDeviceRotation(options: {
  client: MatrixGatewayClient
  service: GatewayPairingService
  registry: FileTrustedDeviceRegistry
  nextTransport: MatrixTransportBinding
  trustedDevices: TrustedDeviceRecord[]
}): Promise<boolean> {
  const head = await options.registry.getGatewayTransportHead()
  const previousTransport = head.transport
  if (!previousTransport || sameTransport(previousTransport, options.nextTransport)) {
    return false
  }
  await options.client.pinTrustedDevices?.(
    options.trustedDevices.map(trustedDeviceFromRecord),
  )
  const signedRotation = await options.service.signMatrixRotation(
    previousTransport,
    options.nextTransport,
    Math.max(
      Date.now(),
      (head.lastRotationIssuedAt ?? 0) + 1,
      (head.lastSnapshotIssuedAt ?? 0) + 1,
    ),
  )
  await options.client.sendEncryptedRoomEvent({
    roomId: options.nextTransport.roomId,
    eventType: 'm.room.message',
    content: {
      msgtype: 'm.notice',
      body: 'Codever Gateway transport key rotation',
      [CODEVER_MATRIX_EXTENSION]: {
        version: 1,
        kind: 'gateway_device_rotation',
        gateway_device_rotation: signedRotation,
      },
    },
    transactionId: `codever.gateway.rotation.${signedRotation.rotation.rotationId}`,
  })
  await options.registry.rotateGatewayTransport(
    previousTransport,
    options.nextTransport,
    signedRotation.rotation.issuedAt,
  )
  return true
}

/**
 * Publishes a root-signed, overwrite-in-place recovery anchor. Unlike the
 * encrypted timeline rotation event, the Gateway's extended Matrix profile
 * remains fetchable after a PWA was offline across any number of restarts.
 */
export async function publishMatrixTransportSnapshot(options: {
  client: MatrixGatewayClient
  service: GatewayPairingService
  registry: FileTrustedDeviceRegistry
  transport: MatrixTransportBinding
}): Promise<void> {
  if (!options.client.setExtendedProfileProperty) {
    throw new Error('Matrix transport does not support durable profile fields')
  }
  const head = await options.registry.getGatewayTransportHead()
  const signedSnapshot = await options.service.signMatrixTransportSnapshot(
    options.transport,
    Math.max(
      Date.now(),
      (head.lastRotationIssuedAt ?? 0) + 1,
      (head.lastSnapshotIssuedAt ?? 0) + 1,
    ),
  )
  await options.client.setExtendedProfileProperty(
    CODEVER_GATEWAY_TRANSPORT_PROFILE_FIELD,
    {
      version: 1,
      signed_snapshot: signedSnapshot,
    },
  )
  await options.registry.recordGatewayTransportSnapshot(
    options.transport,
    signedSnapshot.snapshot.issuedAt,
  )
}

/**
 * Keeps pairing recovery available for the lifetime of the Gateway.
 *
 * A PWA may resend the exact same signed request after losing the response.
 * GatewayPairingService returns the persisted response byte-for-byte; a
 * different request reusing the ID is rejected by the durable state machine.
 */
export function listenForMatrixPairingRequests(
  options: MatrixPairingListenerOptions,
): () => void {
  let stopped = false
  let chain = Promise.resolve()
  const unsubscribe = options.client.onRoomEvent((event) => {
    if (stopped || !isPairingEvent(event, options.gatewayTransport.roomId)) return
    chain = chain
      .then(async () => {
        const extension = asRecord(event.content[CODEVER_MATRIX_EXTENSION])
        const request = signedPairingRequestSchema.parse(extension?.pairing_request)
        const persisted = await options.registry.getPending(request.request.requestId)
        // A verified pending request may be retried after an approval or
        // process failure; an approved request replays its persisted response.
        const recoverable = Boolean(persisted)
        const openOffer = options.acceptNewOffers
          ? await options.registry.getOffer(request.request.offerId)
          : undefined
        if (!recoverable && !openOffer) return
        const record = await acceptMatrixPairing(options, event)
        await options.onAccepted?.(record)
      })
      .catch(error => {
        options.onRejected?.(error)
      })
  })
  return () => {
    stopped = true
    unsubscribe()
  }
}

async function acceptMatrixPairing(
  options: MatrixPairingRequestOptions,
  event: MatrixIncomingEvent,
): Promise<TrustedDeviceRecord> {
  const extension = asRecord(event.content[CODEVER_MATRIX_EXTENSION])
  const signedRequest = signedPairingRequestSchema.parse(extension?.pairing_request)
  assertObservedDevice(event, signedRequest, options.gatewayTransport)

  // GatewayPairingService is the single durable state machine. It validates
  // and consumes a first request, then returns the exact persisted response
  // for an identical signed request whose Matrix delivery was interrupted.
  let accepted: Awaited<ReturnType<GatewayPairingService['receiveRequest']>>
  try {
    accepted = await options.service.receiveRequest(signedRequest)
  } catch (error) {
    const rejection = await options.service.createRejectionForVerifiedRequest(
      signedRequest,
      error,
    )
    if (rejection) {
      // Matrix encryption blacklists unverified devices. The signed request
      // proves the observed Matrix fingerprint, so verify transport delivery
      // without granting application command authority in the registry.
      await options.client.pinTrustedDevices?.([
        trustedDeviceFromRequest(signedRequest),
      ])
      await options.client.sendEncryptedRoomEvent({
        roomId: options.gatewayTransport.roomId,
        eventType: 'm.room.message',
        content: {
          msgtype: 'm.notice',
          body: 'Codever secure pairing could not be completed',
          [CODEVER_MATRIX_EXTENSION]: {
            version: 1,
            kind: 'pairing_rejection',
            pairing_rejection: rejection,
          },
        },
        transactionId: pairingDeliveryTransactionId(
          'rejection',
          signedRequest.request.requestId,
        ),
      })
    }
    throw error
  }
  const trustedDevice = trustedDeviceFromRequest(signedRequest)
  await options.client.pinTrustedDevices?.([trustedDevice])
  const record = await options.registry.get(accepted.deviceId)
  if (!record || record.status !== 'active') {
    throw new Error('Paired device was not persisted')
  }
  // The response is the pairing commit marker from the client's point of
  // view. Publish Room State (including the key bundle for this device)
  // first, so a client that immediately reads /state can always decrypt a
  // complete authoritative snapshot. A failed publication is safe to retry:
  // receiveRequest returns the exact persisted response for this request.
  await options.onProvisioned(record)
  await options.client.sendEncryptedRoomEvent({
    roomId: options.gatewayTransport.roomId,
    eventType: 'm.room.message',
    content: {
      msgtype: 'm.notice',
      body: 'Codever secure pairing completed',
      [CODEVER_MATRIX_EXTENSION]: {
        version: 1,
        kind: 'pairing_response',
        pairing_response: accepted.response,
      },
    },
    // Matrix transaction IDs are idempotency keys, not application message
    // IDs. The signed response is intentionally stable for this request, but
    // every recovery delivery must become a fresh timeline event so a client
    // process that missed the previous event can observe the replay.
    transactionId: pairingDeliveryTransactionId('response', accepted.requestId),
  })
  return record
}

function pairingDeliveryTransactionId(
  kind: 'response' | 'rejection',
  requestId: string,
): string {
  return `codever.pair.${kind}.${requestId}.${randomUUID()}`
}

export function trustedDeviceFromRecord(
  record: TrustedDeviceRecord,
): MatrixGatewayTrustedDevice {
  const certificate = record.certificate.certificate
  return {
    deviceId: certificate.deviceId,
    deviceName: certificate.deviceName,
    publicKey: certificate.deviceKey.publicKey,
    allowedRoomIds: [certificate.deviceTransport.roomId],
    // The signed certificate is the complete authorization policy. There is
    // no local compatibility grant that can silently widen it.
    allowedOperations: certificate.allowedOperations,
    matrixUserId: certificate.deviceTransport.userId,
    matrixDeviceId: certificate.deviceTransport.deviceId,
    matrixDeviceKeys: [certificate.deviceTransport.ed25519],
    certificateExpiresAt: certificate.expiresAt,
    sequenceEpoch: certificate.certificateId,
  }
}

function trustedDeviceFromRequest(
  request: SignedPairingRequest,
): MatrixGatewayPinnedTransportDevice {
  return {
    matrixUserId: request.request.deviceTransport.userId,
    matrixDeviceId: request.request.deviceTransport.deviceId,
    matrixDeviceKeys: [request.request.deviceTransport.ed25519],
  }
}

function isPairingEvent(event: MatrixIncomingEvent, roomId: string): boolean {
  if (
    event.roomId !== roomId
    || event.eventType !== 'm.room.message'
    || !event.encrypted
  ) return false
  const extension = asRecord(event.content[CODEVER_MATRIX_EXTENSION])
  return extension?.version === 1
    && extension.kind === 'pairing_request'
    && extension.pairing_request !== undefined
}

function assertObservedDevice(
  event: MatrixIncomingEvent,
  signedRequest: SignedPairingRequest,
  gatewayTransport: MatrixTransportBinding,
): void {
  const device = signedRequest.request.deviceTransport
  if (
    device.homeserver.replace(/\/+$/u, '') !== gatewayTransport.homeserver.replace(/\/+$/u, '')
    || device.roomId !== gatewayTransport.roomId
    || event.sender !== device.userId
    || event.senderDeviceId !== device.ed25519
  ) {
    throw new Error('Pairing request Matrix device does not match the encrypted event')
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined
}

function sameTransport(
  left: MatrixTransportBinding,
  right: MatrixTransportBinding,
): boolean {
  return left.homeserver.replace(/\/+$/u, '') === right.homeserver.replace(/\/+$/u, '')
    && left.roomId === right.roomId
    && left.userId === right.userId
    && left.deviceId === right.deviceId
    && left.ed25519 === right.ed25519
}
