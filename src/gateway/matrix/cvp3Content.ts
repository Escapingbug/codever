import { createHash } from 'node:crypto'
import {
  CODEVER_MATRIX_EXTENSION,
  CVP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE,
  CVP3_MATRIX_PROJECT_POINTER_EVENT_TYPE,
  CVP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE,
  cvp3ContentEnvelopeSchema,
  cvp3EventSchema,
  cvp3ProjectKeyGrantStateSchema,
  canonicalJson,
  type Cvp3Command,
  type Cvp3CurrentPointer,
  type Cvp3Event,
  type Cvp3ProjectKeyGrantPlaintext,
  type SignedCvp3Command,
} from '@codever/protocol'
import {
  base64UrlEncode,
  importDeviceKeyPair,
  openCvp3Envelope,
  publicKeyId,
  sealCvp3Envelope,
  sealCvp3ProjectKeyGrant,
  signCvp3Event,
  signCvp3Pointer,
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
import { FileMatrixCvp3Outbox, type MatrixCvp3Delivery } from './fileMatrixCvp3Outbox'
import { gatewayProjectIdentity } from './project'

export type Cvp3TrustedDeviceProvider = () => Promise<
  readonly MatrixGatewayTrustedDevice[]
>

export interface OpenedCvp3Command {
  signed: SignedCvp3Command
  command: Cvp3Command
  authenticatedDeviceId: string
  trustedDevice: MatrixGatewayTrustedDevice
  logicalEventId: string
}

export interface EnqueuedCvp3Event {
  deliveryId: string
  confirmation: Promise<MatrixSendEventResult>
}

/**
 * Thin CVP/3 application-security and delivery boundary.
 *
 * It owns one project key ring, one content envelope and one durable Matrix
 * outbox. It does not know session directories, revisions or command state.
 */
export class GatewayCvp3ContentLayer {
  private gatewayKeys: DeviceKeyPair | null = null
  private readonly projectKeys: FileTimelineKeyStore
  private readonly outbox: FileMatrixCvp3Outbox
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly retryAttempts = new Map<string, number>()
  private readonly transports = new Map<string, MatrixTransport>()
  private readonly inFlightDeliveries = new Map<string, Promise<MatrixSendEventResult>>()
  private readonly deliveryConfirmations = new Map<string, {
    promise: Promise<MatrixSendEventResult>
    resolve: (result: MatrixSendEventResult) => void
  }>()
  private deliveryChain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly workspaceId: string,
    private readonly config: MatrixGatewayApplicationSecurityConfig,
    private readonly trustedDevices: readonly MatrixGatewayTrustedDevice[],
    private readonly getTrustedDevices?: Cvp3TrustedDeviceProvider,
  ) {
    this.projectKeys = new FileTimelineKeyStore(
      `${config.envelopeReplayLedgerPath}.v3-project-keys.json`,
    )
    this.outbox = new FileMatrixCvp3Outbox(
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
  ): Promise<OpenedCvp3Command | null> {
    const extension = asRecord(input)
    if (extension?.version !== 3 || !extension.envelope) {
      throw new Error('Codever CVP/3 project envelope is required')
    }
    const envelope = cvp3ContentEnvelopeSchema.parse(extension.envelope)
    const projectId = this.projectId(room)
    if (envelope.projectId !== projectId || envelope.roomId !== room.roomId) {
      throw new Error('Codever CVP/3 project envelope route does not match')
    }
    const devices = await this.activeDevices(room.roomId)
    const ring = await this.projectKeys.ensureRoom(
      room.roomId,
      devices.map(device => device.deviceId),
    )
    const epoch = ring.epochs.find(candidate => candidate.epochId === envelope.keyId)
    if (!epoch) throw new Error('Codever CVP/3 project key is unavailable')
    const opened = await openCvp3Envelope(envelope, {
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
    eventInput: Cvp3Event,
    transport: MatrixTransport,
    options: {
      transactionId?: string
      relation?: Record<string, unknown>
    } = {},
  ): Promise<MatrixSendEventResult> {
    const delivery = await this.stageEvent(room, eventInput, transport, options)
    return this.deliver(delivery, transport)
  }

  /**
   * Fsync the semantic event before handing network delivery to the shared
   * account lane. Agent execution waits for durable acceptance, not for a
   * homeserver token bucket or a physical Matrix event ID.
   */
  async enqueueEvent(
    room: MatrixGatewayRoomConfig,
    eventInput: Cvp3Event,
    transport: MatrixTransport,
    options: {
      transactionId?: string
      relation?: Record<string, unknown>
    } = {},
  ): Promise<EnqueuedCvp3Event> {
    const delivery = await this.stageEvent(room, eventInput, transport, options)
    const confirmation = this.confirmationFor(delivery.deliveryId)
    // deliver() owns a rejection handler that schedules durable retry. The
    // stable confirmation intentionally remains pending across failed attempts
    // and resolves when any retry commits the Matrix event.
    void this.deliver(delivery, transport)
    return {
      deliveryId: delivery.deliveryId,
      confirmation,
    }
  }

  /**
   * Durably stages an event and returns immediately. The outbox owns Matrix
   * delivery and subsequent retries, so callers must not resend it.
   */
  async queueEvent(
    room: MatrixGatewayRoomConfig,
    eventInput: Cvp3Event,
    transport: MatrixTransport,
    options: {
      transactionId?: string
      relation?: Record<string, unknown>
    } = {},
  ): Promise<{ status: 'delivered' | 'queued'; eventId?: string }> {
    await this.enqueueEvent(room, eventInput, transport, options)
    return { status: 'queued' }
  }

  private async stageEvent(
    room: MatrixGatewayRoomConfig,
    eventInput: Cvp3Event,
    transport: MatrixTransport,
    options: {
      transactionId?: string
      relation?: Record<string, unknown>
    },
  ): Promise<Extract<MatrixCvp3Delivery, { kind: 'event' }>> {
    this.transports.set(room.roomId, transport)
    const event = cvp3EventSchema.parse(eventInput)
    const projectId = this.projectId(room)
    if (
      event.workspaceId !== this.workspaceId
      || (event.projectId !== undefined && event.projectId !== projectId)
    ) {
      throw new Error('CVP/3 event is not bound to this project')
    }
    const devices = await this.activeDevices(room.roomId)
    if (devices.length === 0) throw new Error('Project has no active Codever device')
    const ring = await this.projectKeys.ensureRoom(
      room.roomId,
      devices.map(device => device.deviceId),
    )
    const active = ring.epochs.find(epoch => epoch.epochId === ring.activeEpochId)
    if (!active) throw new Error('CVP/3 project key ring has no active key')
    const keys = this.requireGatewayKeys()
    const signed = await signCvp3Event(event, keys.privateKey, keys.keyId)
    const envelope = await sealCvp3Envelope({
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
    return (this.outbox.delivery(delivery.deliveryId) ?? delivery) as Extract<
      MatrixCvp3Delivery,
      { kind: 'event' }
    >
  }

  async publishProjectPointer(
    room: MatrixGatewayRoomConfig,
    snapshotEvent: Cvp3Event,
    snapshotEventId: string,
    transport: MatrixTransport,
  ): Promise<MatrixSendEventResult> {
    const projectId = this.projectId(room)
    if (snapshotEvent.payload.type !== 'project.snapshot') {
      throw new Error('Project pointer must reference a project snapshot')
    }
    const keys = this.requireGatewayKeys()
    const pointer: Cvp3CurrentPointer = await signCvp3Pointer({
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
      eventType: CVP3_MATRIX_PROJECT_POINTER_EVENT_TYPE,
      stateKey: projectId,
      content: pointer,
      createdAt: Date.now(),
    })
    await this.outbox.stage(delivery)
    return this.deliver(this.outbox.delivery(delivery.deliveryId) ?? delivery, transport)
  }

  async publishWorkspacePointer(
    room: MatrixGatewayRoomConfig,
    snapshotEvent: Cvp3Event,
    snapshotEventId: string,
    transport: MatrixTransport,
  ): Promise<MatrixSendEventResult> {
    const projectId = this.projectId(room)
    if (snapshotEvent.payload.type !== 'workspace.snapshot') {
      throw new Error('Workspace pointer must reference a workspace snapshot')
    }
    const keys = this.requireGatewayKeys()
    const pointer: Cvp3CurrentPointer = await signCvp3Pointer({
      kind: 'workspace.current',
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
      eventType: CVP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE,
      stateKey: this.workspaceId,
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
      CVP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE,
      stateKey,
    )
    if (asRecord(previous?.content)?.grantId === grantId) return
    const keys = this.requireGatewayKeys()
    const recipientKeyId = await publicKeyId(device.publicKey)
    const plaintext: Cvp3ProjectKeyGrantPlaintext = {
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
    const sealedGrant = await sealCvp3ProjectKeyGrant({
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
    const content = cvp3ProjectKeyGrantStateSchema.parse({
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
      eventType: CVP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE,
      stateKey,
      content,
      createdAt: Date.now(),
    })
    await this.outbox.stage(delivery)
    await this.deliver(this.outbox.delivery(delivery.deliveryId) ?? delivery, transport)
  }

  private deliver(
    delivery: MatrixCvp3Delivery,
    transport: MatrixTransport,
  ): Promise<MatrixSendEventResult> {
    const delivered = this.outbox.deliveredEventId(delivery.deliveryId)
    if (delivered) return Promise.resolve({ eventId: delivered })
    const inFlight = this.inFlightDeliveries.get(delivery.deliveryId)
    if (inFlight) return inFlight
    const operation = this.deliveryChain.then(async () => {
      let result: MatrixSendEventResult
      if (delivery.kind === 'event') {
        if (!transport.sendApplicationTimelineEvent) {
          throw new Error('Matrix transport cannot publish CVP/3 timeline events')
        }
        result = await transport.sendApplicationTimelineEvent({
          roomId: delivery.roomId,
          eventType: 'm.room.message',
          content: delivery.content as MatrixRoomMessageContent,
          transactionId: delivery.transactionId,
        })
      } else {
        if (!transport.setApplicationRoomState) {
          throw new Error('Matrix transport cannot publish CVP/3 state')
        }
        result = await transport.setApplicationRoomState({
          roomId: delivery.roomId,
          eventType: delivery.eventType,
          stateKey: delivery.stateKey,
          content: delivery.content,
        })
      }
      await this.outbox.markDelivered(delivery.deliveryId, result.eventId)
      this.resolveConfirmation(delivery.deliveryId, result)
      this.retryAttempts.delete(delivery.roomId)
      return result
    })
    this.deliveryChain = operation.then(() => undefined, () => undefined)
    this.inFlightDeliveries.set(delivery.deliveryId, operation)
    void operation.then(
      () => {
        if (this.inFlightDeliveries.get(delivery.deliveryId) === operation) {
          this.inFlightDeliveries.delete(delivery.deliveryId)
        }
      },
      () => {
        if (this.inFlightDeliveries.get(delivery.deliveryId) === operation) {
          this.inFlightDeliveries.delete(delivery.deliveryId)
        }
        this.scheduleRetry(delivery.roomId, transport)
      },
    )
    return operation
  }

  private confirmationFor(deliveryId: string): Promise<MatrixSendEventResult> {
    const delivered = this.outbox.deliveredEventId(deliveryId)
    if (delivered) return Promise.resolve({ eventId: delivered })
    const current = this.deliveryConfirmations.get(deliveryId)
    if (current) return current.promise
    let resolve!: (result: MatrixSendEventResult) => void
    const promise = new Promise<MatrixSendEventResult>(done => { resolve = done })
    this.deliveryConfirmations.set(deliveryId, { promise, resolve })
    return promise
  }

  private resolveConfirmation(deliveryId: string, result: MatrixSendEventResult): void {
    const confirmation = this.deliveryConfirmations.get(deliveryId)
    if (!confirmation) return
    this.deliveryConfirmations.delete(deliveryId)
    confirmation.resolve(result)
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
    if (!this.gatewayKeys) throw new Error('CVP/3 content layer is not initialized')
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
