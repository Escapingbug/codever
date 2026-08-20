import { createHash } from 'node:crypto'
import {
  CODEVER_MATRIX_EXTENSION,
  CODEVER_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE,
  CODEVER_MATRIX_PROJECT_POINTER_EVENT_TYPE,
  codeverV3ContentEnvelopeSchema,
  codeverV3EventSchema,
  codeverV3ProjectKeyGrantStateSchema,
  canonicalJson,
  type CodeverV3Command,
  type CodeverV3CurrentPointer,
  type CodeverV3Event,
  type CodeverV3ProjectKeyGrantPlaintext,
  type SignedCodeverV3Command,
} from '@codever/protocol'
import {
  base64UrlEncode,
  importDeviceKeyPair,
  openCodeverV3Envelope,
  publicKeyId,
  sealCodeverV3Envelope,
  sealCodeverV3ProjectKeyGrant,
  signCodeverV3Event,
  signCodeverV3Pointer,
  type DeviceKeyPair,
} from '@codever/security'
import type {
  MatrixGatewayApplicationSecurityConfig,
  MatrixGatewayRoomConfig,
  MatrixGatewayTrustedDevice,
} from './config'
import type {
  MatrixRoomMessageContent,
  MatrixSendEventResult,
  MatrixTransport,
} from '@/channel/matrix'
import { FileTimelineKeyStore, type TimelineKeyRing } from './fileTimelineKeyStore'
import { FileV3MatrixOutbox, type V3MatrixDelivery } from './fileV3MatrixOutbox'
import { gatewayProjectIdentity } from './project'

export type V3TrustedDeviceProvider = () => Promise<
  readonly MatrixGatewayTrustedDevice[]
>

export interface OpenedV3Command {
  signed: SignedCodeverV3Command
  command: CodeverV3Command
  authenticatedDeviceId: string
  trustedDevice: MatrixGatewayTrustedDevice
  logicalEventId: string
}

/**
 * Thin v3 application-security and delivery boundary.
 *
 * It owns one project key ring, one content envelope and one durable Matrix
 * outbox. It does not know session directories, revisions or command state.
 */
export class GatewayV3ContentLayer {
  private gatewayKeys: DeviceKeyPair | null = null
  private readonly projectKeys: FileTimelineKeyStore
  private readonly outbox: FileV3MatrixOutbox
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly retryAttempts = new Map<string, number>()
  private readonly transports = new Map<string, MatrixTransport>()
  private deliveryChain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly workspaceId: string,
    private readonly config: MatrixGatewayApplicationSecurityConfig,
    private readonly trustedDevices: readonly MatrixGatewayTrustedDevice[],
    private readonly getTrustedDevices?: V3TrustedDeviceProvider,
  ) {
    this.projectKeys = new FileTimelineKeyStore(
      `${config.envelopeReplayLedgerPath}.v3-project-keys.json`,
    )
    this.outbox = new FileV3MatrixOutbox(
      `${config.envelopeReplayLedgerPath}.v3-outbox.jsonl`,
    )
  }

  async initialize(): Promise<void> {
    this.gatewayKeys = await importDeviceKeyPair(this.config.gatewayKeyPair)
    await this.projectKeys.initialize()
    await this.outbox.initialize()
  }

  stopRetries(): void {
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
    this.retryAttempts.clear()
  }

  projectId(room: MatrixGatewayRoomConfig): string {
    return gatewayProjectIdentity(room.cwd).id
  }

  async hasActiveDevices(roomId: string): Promise<boolean> {
    return (await this.activeDevices(roomId)).length > 0
  }

  async provisionProject(
    room: MatrixGatewayRoomConfig,
    transport: MatrixTransport,
  ): Promise<void> {
    this.transports.set(room.roomId, transport)
    const devices = await this.activeDevices(room.roomId)
    if (devices.length === 0) return
    const ring = await this.projectKeys.ensureRoom(
      room.roomId,
      devices.map(device => device.deviceId),
    )
    await Promise.all(devices.map(device =>
      this.publishKeyGrant(room, ring, device, transport)
    ))
    await this.retryPending(room.roomId, transport)
  }

  async openIncoming(
    input: unknown,
    room: MatrixGatewayRoomConfig,
  ): Promise<OpenedV3Command | null> {
    const extension = asRecord(input)
    if (extension?.version !== 3 || !extension.envelope) {
      throw new Error('Codever Matrix v3 project envelope is required')
    }
    const envelope = codeverV3ContentEnvelopeSchema.parse(extension.envelope)
    const projectId = this.projectId(room)
    if (envelope.projectId !== projectId || envelope.roomId !== room.roomId) {
      throw new Error('Codever Matrix v3 project envelope route does not match')
    }
    const devices = await this.activeDevices(room.roomId)
    const ring = await this.projectKeys.ensureRoom(
      room.roomId,
      devices.map(device => device.deviceId),
    )
    const epoch = ring.epochs.find(candidate => candidate.epochId === envelope.keyId)
    if (!epoch) throw new Error('Codever Matrix v3 project key is unavailable')
    const opened = await openCodeverV3Envelope(envelope, {
      projectKey: epoch.key,
      roomId: room.roomId,
      projectId,
      keyId: epoch.epochId,
    })
    // Matrix echoes the Gateway's own events. Their signed payload is valid,
    // but they are projections rather than inbound work.
    if (opened.plaintext.kind === 'signed_event') return null
    const signed = opened.plaintext.value
    if (envelope.logicalEventId !== signed.command.commandId) {
      throw new Error('Codever command logical event ID does not match its signed command ID')
    }
    const device = devices.find(candidate => candidate.deviceId === signed.command.deviceId)
    if (!device) throw new Error('Codever command device is not active for this project')
    return {
      signed,
      command: signed.command,
      authenticatedDeviceId: device.deviceId,
      trustedDevice: device,
      logicalEventId: envelope.logicalEventId,
    }
  }

  async sendEvent(
    room: MatrixGatewayRoomConfig,
    eventInput: CodeverV3Event,
    transport: MatrixTransport,
    options: {
      transactionId?: string
      relation?: Record<string, unknown>
    } = {},
  ): Promise<MatrixSendEventResult> {
    this.transports.set(room.roomId, transport)
    const event = codeverV3EventSchema.parse(eventInput)
    const projectId = this.projectId(room)
    if (
      event.workspaceId !== this.workspaceId
      || (event.projectId !== undefined && event.projectId !== projectId)
    ) {
      throw new Error('Codever v3 event is not bound to this project')
    }
    const devices = await this.activeDevices(room.roomId)
    if (devices.length === 0) throw new Error('Project has no active Codever device')
    const ring = await this.projectKeys.ensureRoom(
      room.roomId,
      devices.map(device => device.deviceId),
    )
    const active = ring.epochs.find(epoch => epoch.epochId === ring.activeEpochId)
    if (!active) throw new Error('Codever v3 project key ring has no active key')
    const keys = this.requireGatewayKeys()
    const signed = await signCodeverV3Event(event, keys.privateKey, keys.keyId)
    const envelope = await sealCodeverV3Envelope({
      plaintext: { kind: 'signed_event', value: signed },
      projectKey: active.key,
      roomId: room.roomId,
      projectId,
      keyId: active.epochId,
      logicalEventId: event.eventId,
    })
    const content: MatrixRoomMessageContent = {
      msgtype: 'm.notice',
      body: 'Encrypted Codever event',
      ...(options.relation ? { 'm.relates_to': structuredClone(options.relation) } : {}),
      [CODEVER_MATRIX_EXTENSION]: { version: 3, envelope },
    }
    const delivery = this.outbox.createEvent({
      roomId: room.roomId,
      transactionId: options.transactionId ?? matrixTransactionId(event.eventId),
      content,
      createdAt: Date.now(),
    })
    await this.outbox.stage(delivery)
    return this.deliver(this.outbox.delivery(delivery.deliveryId) ?? delivery, transport)
  }

  async publishProjectPointer(
    room: MatrixGatewayRoomConfig,
    snapshotEvent: CodeverV3Event,
    snapshotEventId: string,
    transport: MatrixTransport,
  ): Promise<MatrixSendEventResult> {
    const projectId = this.projectId(room)
    if (snapshotEvent.payload.type !== 'project.snapshot') {
      throw new Error('Project pointer must reference a project snapshot')
    }
    const keys = this.requireGatewayKeys()
    const pointer: CodeverV3CurrentPointer = await signCodeverV3Pointer({
      kind: 'project.current',
      version: 3,
      workspaceId: this.workspaceId,
      projectId,
      roomId: room.roomId,
      eventId: snapshotEventId,
      logicalEventId: snapshotEvent.eventId,
      snapshotVersion: snapshotEvent.payload.snapshotVersion,
      gatewayKeyId: keys.keyId,
      updatedAt: snapshotEvent.occurredAt,
    }, keys.privateKey, keys.keyId)
    const delivery = this.outbox.createState({
      roomId: room.roomId,
      eventType: CODEVER_MATRIX_PROJECT_POINTER_EVENT_TYPE,
      stateKey: projectId,
      content: pointer,
      createdAt: Date.now(),
    })
    await this.outbox.stage(delivery)
    return this.deliver(this.outbox.delivery(delivery.deliveryId) ?? delivery, transport)
  }

  async retryPending(roomId: string, transport: MatrixTransport): Promise<void> {
    for (const delivery of this.outbox.pending(roomId)) {
      try {
        await this.deliver(delivery, transport)
      } catch {
        this.scheduleRetry(roomId, transport)
        return
      }
    }
  }

  private async publishKeyGrant(
    room: MatrixGatewayRoomConfig,
    ring: TimelineKeyRing,
    device: MatrixGatewayTrustedDevice,
    transport: MatrixTransport,
  ): Promise<void> {
    const projectId = this.projectId(room)
    const certificateId = certificateIdFor(device)
    const grantId = keyGrantId(projectId, device.deviceId, certificateId, ring)
    const stateKey = `${projectId}.${device.deviceId}`
    const previous = this.outbox.latestState(
      room.roomId,
      CODEVER_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE,
      stateKey,
    )
    if (asRecord(previous?.content)?.grantId === grantId) return
    const keys = this.requireGatewayKeys()
    const recipientKeyId = await publicKeyId(device.publicKey)
    const plaintext: CodeverV3ProjectKeyGrantPlaintext = {
      kind: 'project.key_grant',
      version: 3,
      workspaceId: this.workspaceId,
      projectId,
      roomId: room.roomId,
      deviceId: device.deviceId,
      certificateId,
      activeKeyId: ring.activeEpochId,
      keys: ring.epochs.map(epoch => ({
        keyId: epoch.epochId,
        key: base64UrlEncode(epoch.key),
        createdAt: epoch.createdAt,
      })),
    }
    const sealedGrant = await sealCodeverV3ProjectKeyGrant({
      plaintext,
      bindings: {
        grantId,
        workspaceId: this.workspaceId,
        projectId,
        roomId: room.roomId,
        deviceId: device.deviceId,
        certificateId,
        senderKeyId: keys.keyId,
        recipientKeyId,
      },
      senderPrivateKey: keys.privateKey,
      recipientPublicKey: device.publicKey,
    })
    const content = codeverV3ProjectKeyGrantStateSchema.parse({
      kind: 'project.key_grant',
      version: 3,
      workspaceId: this.workspaceId,
      projectId,
      roomId: room.roomId,
      deviceId: device.deviceId,
      certificateId,
      grantId,
      sealedGrant,
    })
    const delivery = this.outbox.createState({
      roomId: room.roomId,
      eventType: CODEVER_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE,
      stateKey,
      content,
      createdAt: Date.now(),
    })
    await this.outbox.stage(delivery)
    await this.deliver(this.outbox.delivery(delivery.deliveryId) ?? delivery, transport)
  }

  private deliver(
    delivery: V3MatrixDelivery,
    transport: MatrixTransport,
  ): Promise<MatrixSendEventResult> {
    const delivered = this.outbox.deliveredEventId(delivery.deliveryId)
    if (delivered) return Promise.resolve({ eventId: delivered })
    const operation = this.deliveryChain.then(async () => {
      let result: MatrixSendEventResult
      if (delivery.kind === 'event') {
        if (!transport.sendApplicationTimelineEvent) {
          throw new Error('Matrix transport cannot publish Codever v3 timeline events')
        }
        result = await transport.sendApplicationTimelineEvent({
          roomId: delivery.roomId,
          eventType: 'm.room.message',
          content: delivery.content as MatrixRoomMessageContent,
          transactionId: delivery.transactionId,
        })
      } else {
        if (!transport.setApplicationRoomState) {
          throw new Error('Matrix transport cannot publish Codever v3 state')
        }
        result = await transport.setApplicationRoomState({
          roomId: delivery.roomId,
          eventType: delivery.eventType,
          stateKey: delivery.stateKey,
          content: delivery.content,
        })
      }
      await this.outbox.markDelivered(delivery.deliveryId, result.eventId)
      this.retryAttempts.delete(delivery.roomId)
      return result
    })
    this.deliveryChain = operation.then(() => undefined, () => undefined)
    void operation.catch(() => this.scheduleRetry(delivery.roomId, transport))
    return operation
  }

  private scheduleRetry(roomId: string, transport: MatrixTransport): void {
    if (this.retryTimers.has(roomId)) return
    const attempt = (this.retryAttempts.get(roomId) ?? 0) + 1
    this.retryAttempts.set(roomId, attempt)
    const delayMs = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6))
    const timer = setTimeout(() => {
      this.retryTimers.delete(roomId)
      void this.retryPending(roomId, transport)
    }, delayMs)
    timer.unref?.()
    this.retryTimers.set(roomId, timer)
  }

  private async activeDevices(roomId: string): Promise<MatrixGatewayTrustedDevice[]> {
    const now = Date.now()
    const devices = this.getTrustedDevices
      ? await this.getTrustedDevices()
      : this.trustedDevices
    return devices.filter(device =>
      device.allowedRoomIds.includes(roomId)
      && (device.certificateExpiresAt === undefined || device.certificateExpiresAt > now),
    )
  }

  private requireGatewayKeys(): DeviceKeyPair {
    if (!this.gatewayKeys) throw new Error('Codever v3 content layer is not initialized')
    return this.gatewayKeys
  }
}

function certificateIdFor(device: MatrixGatewayTrustedDevice): string {
  return device.sequenceEpoch
}

function keyGrantId(
  projectId: string,
  deviceId: string,
  certificateId: string,
  ring: TimelineKeyRing,
): string {
  return createHash('sha256')
    .update('codever-project-key-grant:v3\0')
    .update(canonicalJson([
      projectId,
      deviceId,
      certificateId,
      ring.activeEpochId,
      ring.epochs.map(epoch => [epoch.epochId, base64UrlEncode(epoch.key)]),
    ]))
    .digest('base64url')
}

function matrixTransactionId(logicalEventId: string): string {
  return `codever.v3.${createHash('sha256')
    .update(logicalEventId)
    .digest('hex')}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
