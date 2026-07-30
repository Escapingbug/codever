import {
  signedPairingRequestSchema,
  type CommandOperation,
  type MatrixTransportBinding,
  type PairingOperation,
  type SignedPairingRequest,
} from '@codever/protocol'
import type { MatrixIncomingEvent } from '@/channel/matrix'
import { CODEVER_MATRIX_EXTENSION } from '@/channel/matrix'
import type {
  MatrixGatewayClient,
  MatrixGatewayTrustedDevice,
} from '@/gateway/matrix'
import type { FileTrustedDeviceRegistry, TrustedDeviceRecord } from './registry.js'
import type { GatewayPairingService } from './service.js'

export interface MatrixPairingWaitOptions {
  client: MatrixGatewayClient
  service: GatewayPairingService
  registry: FileTrustedDeviceRegistry
  gatewayTransport: MatrixTransportBinding
  timeoutMs?: number
  onRejected?: (error: unknown) => void
}

export interface MatrixPairingListenerOptions extends MatrixPairingWaitOptions {
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
    Math.max(Date.now(), (head.lastRotationIssuedAt ?? 0) + 1),
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

export async function waitForMatrixPairing(
  options: MatrixPairingWaitOptions,
): Promise<TrustedDeviceRecord> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000
  return new Promise<TrustedDeviceRecord>((resolve, reject) => {
    let handling = false
    let settled = false
    const finish = (outcome: { record: TrustedDeviceRecord } | { error: unknown }): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      unsubscribe()
      if ('record' in outcome) resolve(outcome.record)
      else reject(outcome.error)
    }
    const timeout = setTimeout(
      () => finish({ error: new Error(`Pairing timed out after ${timeoutMs}ms`) }),
      timeoutMs,
    )
    const unsubscribe = options.client.onRoomEvent((event) => {
      if (settled || handling || !isPairingEvent(event, options.gatewayTransport.roomId)) return
      handling = true
      void acceptMatrixPairing(options, event)
        .then((record) => finish({ record }))
        .catch((error) => {
          handling = false
          options.onRejected?.(error)
        })
    })
  })
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
        const recoverable = persisted?.status === 'approved' && persisted.response
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
  options: MatrixPairingWaitOptions,
  event: MatrixIncomingEvent,
): Promise<TrustedDeviceRecord> {
  const extension = asRecord(event.content[CODEVER_MATRIX_EXTENSION])
  const signedRequest = signedPairingRequestSchema.parse(extension?.pairing_request)
  assertObservedDevice(event, signedRequest, options.gatewayTransport)

  // GatewayPairingService is the single durable state machine. It validates
  // and consumes a first request, then returns the exact persisted response
  // for an identical signed request whose Matrix delivery was interrupted.
  const accepted = await options.service.receiveRequest(signedRequest)
  const trustedDevice = trustedDeviceFromRequest(signedRequest)
  await options.client.pinTrustedDevices?.([trustedDevice])
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
    transactionId: `codever.pair.response.${accepted.requestId}`,
  })
  const record = await options.registry.get(accepted.deviceId)
  if (!record || record.status !== 'active') {
    throw new Error('Paired device was not persisted')
  }
  return record
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
    // Device invitations are a local Gateway management capability granted
    // to every active paired device. Adding it here also upgrades certificates
    // issued before device.invite existed without weakening the trust root.
    allowedOperations: withDeviceInvitation(
      executableOperations(certificate.allowedOperations),
    ),
    matrixUserId: certificate.deviceTransport.userId,
    matrixDeviceId: certificate.deviceTransport.deviceId,
    matrixDeviceKeys: [certificate.deviceTransport.ed25519],
    certificateExpiresAt: certificate.expiresAt,
    sequenceEpoch: certificate.certificateId,
  }
}

function trustedDeviceFromRequest(
  request: SignedPairingRequest,
): MatrixGatewayTrustedDevice {
  return {
    deviceId: request.request.deviceId,
    deviceName: request.request.deviceName,
    publicKey: request.request.deviceKey.publicKey,
    allowedRoomIds: [request.request.deviceTransport.roomId],
    allowedOperations: executableOperations(request.request.requestedOperations),
    matrixUserId: request.request.deviceTransport.userId,
    matrixDeviceId: request.request.deviceTransport.deviceId,
    matrixDeviceKeys: [request.request.deviceTransport.ed25519],
  }
}

function executableOperations(
  operations: readonly PairingOperation[],
): CommandOperation[] {
  return operations.filter(
    (operation): operation is CommandOperation => operation !== 'session.select',
  )
}

function withDeviceInvitation(
  operations: readonly CommandOperation[],
): CommandOperation[] {
  return operations.includes('device.invite')
    ? [...operations]
    : [...operations, 'device.invite']
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
