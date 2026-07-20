import {
  CURRENT_MATRIX_CONTROL_RANGE,
  PROTOCOL_VERSION,
  matrixControlRangesOverlap,
  parseMatrixControlVersionRange,
  parseClientGatewayResponseFrame,
  parseGateway,
  parseInventorySnapshot,
  parseSessionEventEnvelope,
  type ClientGatewayRequestFrame,
  type ClientGatewayRequestPayload,
  type ClientGatewayResponseFrame,
  type Gateway,
  type InventorySnapshot,
  type SessionEventEnvelope,
} from '@codever/protocol'
import {
  MATRIX_CONVERSATION_EVENT,
  MATRIX_AUTHORIZATION_EVENT,
  MATRIX_DISCOVERY_EVENT,
  MATRIX_GATEWAY_EVENT,
  MATRIX_INVENTORY_EVENT,
  MATRIX_RESPONSE_EVENT,
  isMatrixTransportEvent,
  type MatrixPublicSession,
  type MatrixTransportEvent,
  type SignExecutionInput,
} from './nativeMatrixClient'

export interface MatrixTransportPort {
  send(input: { roomId: string; eventType: string; transactionId: string; content: unknown }): Promise<string>
  signExecution(account: string, input: SignExecutionInput): Promise<string>
  subscribe(subscriber: (event: MatrixTransportEvent) => void): () => void
}

export interface MatrixGatewayClientOptions {
  transport: MatrixTransportPort
  session: MatrixPublicSession
  controlRoomId: string
  executionAccount: string
  executionKeyId: string
  timeoutMs?: number
  onSecurityError?: (message: string) => void
}

export interface ExecutionRootApprovalRequest {
  requestId: string
  gatewayId: string
  ownerId: string
  label: string
  senderDevice: string
  publicKey: { kty: 'EC'; crv: 'P-256'; alg: 'ES256'; use: 'sig'; kid: string; x: string; y: string }
}

interface PendingRequest {
  resolve: (response: ClientGatewayResponseFrame) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

export class MatrixGatewayClientClosedError extends Error {
  readonly code = 'matrix_gateway_client_closed'

  constructor() {
    super('Matrix Gateway client closed')
    this.name = 'MatrixGatewayClientClosedError'
  }
}

export function isMatrixGatewayClientClosedError(value: unknown): value is MatrixGatewayClientClosedError {
  return value instanceof MatrixGatewayClientClosedError
}

export class MatrixGatewayClient {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly responses = new Map<string, ClientGatewayResponseFrame>()
  private readonly inventories = new Map<string, InventorySnapshot>()
  private readonly gateways = new Map<string, Gateway>()
  private readonly sessionSubscribers = new Map<string, Set<(event: SessionEventEnvelope) => void>>()
  private readonly seenConversationEvents = new Set<string>()
  private readonly approvalRequests = new Map<string, ExecutionRootApprovalRequest>()
  private readonly approvalSubscribers = new Set<(requests: ExecutionRootApprovalRequest[]) => void>()
  private unsubscribe?: () => void
  private discovery?: Promise<void>
  private discoveryLastCompletedAt = 0
  private gatewayAnnouncementRevision = 0
  private activeDiscoveryRequestId?: string

  constructor(private readonly options: MatrixGatewayClientOptions) {}

  start(): void {
    this.unsubscribe ??= this.options.transport.subscribe(event => this.receive(event))
  }

  close(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new MatrixGatewayClientClosedError())
    }
    this.pending.clear()
  }

  async listGateways(): Promise<Gateway[]> {
    await this.discoverGateways()
    return [...this.gateways.values()]
  }
  inventory(gatewayId: string): InventorySnapshot | undefined { return this.inventories.get(gatewayId) }

  subscribeSession(sessionId: string, subscriber: (event: SessionEventEnvelope) => void): () => void {
    const subscribers = this.sessionSubscribers.get(sessionId) ?? new Set()
    subscribers.add(subscriber)
    this.sessionSubscribers.set(sessionId, subscribers)
    return () => {
      subscribers.delete(subscriber)
      if (!subscribers.size) this.sessionSubscribers.delete(sessionId)
    }
  }

  subscribeExecutionApprovals(subscriber: (requests: ExecutionRootApprovalRequest[]) => void): () => void {
    this.approvalSubscribers.add(subscriber)
    subscriber([...this.approvalRequests.values()])
    return () => this.approvalSubscribers.delete(subscriber)
  }

  async requestExecutionApproval(input: Omit<ExecutionRootApprovalRequest, 'requestId' | 'senderDevice'>): Promise<string> {
    this.start()
    const requestId = `approval_${crypto.randomUUID()}`
    await this.options.transport.send({
      roomId: this.options.controlRoomId,
      eventType: MATRIX_AUTHORIZATION_EVENT,
      transactionId: requestId,
      content: { version: PROTOCOL_VERSION, type: 'execution.root.request', requestId, ...input },
    })
    return requestId
  }

  async approveExecutionRoot(input: ExecutionRootApprovalRequest): Promise<ClientGatewayResponseFrame> {
    const response = await this.request(input.gatewayId, {
      kind: 'execution.root.trust', ownerId: input.ownerId,
      matrixDeviceId: input.senderDevice,
      label: input.label, publicKey: input.publicKey,
    })
    if (response.status === 'completed') {
      this.approvalRequests.delete(input.requestId)
      this.notifyApprovals()
    }
    return response
  }

  async request(gatewayId: string, payload: ClientGatewayRequestPayload): Promise<ClientGatewayResponseFrame> {
    this.start()
    const gateway = this.gateways.get(gatewayId)
    if (!gateway || gateway.capabilities.metadata?.matrixControlNegotiated !== true) {
      throw new Error('Secure-control protocol negotiation has not completed. Refresh computers and try again.')
    }
    if (gateway.capabilities.metadata?.matrixControlCompatible !== true) {
      throw new Error('This Gateway uses an incompatible secure-control protocol. Update Codever Gateway.')
    }
    if (gateway.capabilities.metadata?.matrixVerified !== true) {
      throw new Error('This client device is not verified by the Gateway. Verify this computer again.')
    }
    const requestId = `req_${crypto.randomUUID()}`
    const request: ClientGatewayRequestFrame = {
      version: PROTOCOL_VERSION,
      type: 'client.gateway.request',
      requestId,
      idempotencyKey: `idem_${crypto.randomUUID()}`,
      payload,
    }
    const cached = this.responses.get(requestId)
    if (cached) return cached
    const token = await this.options.transport.signExecution(this.options.executionAccount, {
      request,
      gatewayId,
      issuer: `codever-control:${this.options.executionKeyId}`,
      subject: this.options.session.deviceId,
      operation: payload.kind,
      ttlSeconds: 90,
    })
    const response = new Promise<ClientGatewayResponseFrame>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject })
    })
    try {
      await this.options.transport.send({
        roomId: this.options.controlRoomId,
        eventType: 'io.codever.command.v1',
        transactionId: request.idempotencyKey,
        content: {
          version: PROTOCOL_VERSION,
          type: 'client.gateway.authorized-request',
          request,
          authorization: { format: 'cose-sign1-cwt', token },
        },
      })
      const waiting = this.pending.get(requestId)
      if (waiting) {
        waiting.timer = setTimeout(() => {
          this.pending.delete(requestId)
          waiting.reject(new Error('Gateway response timed out; the request may still be visible in Matrix history'))
        }, this.options.timeoutMs ?? 30_000)
      }
    } catch (error) {
      const waiting = this.pending.get(requestId)
      if (waiting) {
        if (waiting.timer) clearTimeout(waiting.timer)
        this.pending.delete(requestId)
      }
      throw error
    }
    return response
  }

  private async discoverGateways(): Promise<void> {
    this.start()
    const hasSetupCandidate = [...this.gateways.values()]
      .some(gateway => gateway.capabilities.metadata?.matrixVerified === false)
    if (this.gateways.size && !hasSetupCandidate && Date.now() - this.discoveryLastCompletedAt < 15_000) return
    if (this.discovery) return this.discovery
    this.discovery = (async () => {
      const requestId = `discover_${crypto.randomUUID()}`
      this.activeDiscoveryRequestId = requestId
      const announcementRevision = this.gatewayAnnouncementRevision
      await this.options.transport.send({
        roomId: this.options.controlRoomId,
        eventType: MATRIX_DISCOVERY_EVENT,
        transactionId: requestId,
        content: { version: PROTOCOL_VERSION, requestId, matrixControl: CURRENT_MATRIX_CONTROL_RANGE },
      })
      const startedAt = Date.now()
      while (Date.now() - startedAt < 8_000) {
        // Cached candidates are deliberately not sufficient here. In particular, the
        // announcement that follows SAS completion changes matrixVerified for the same
        // Gateway id. Returning the cached candidate would roll the UI back to setup.
        if (this.gatewayAnnouncementRevision > announcementRevision) {
          await delay(100)
          break
        }
        await delay(50)
      }
      this.discoveryLastCompletedAt = Date.now()
    })().finally(() => {
      this.activeDiscoveryRequestId = undefined
      this.discovery = undefined
    })
    return this.discovery
  }

  private receive(input: MatrixTransportEvent): void {
    if (!isMatrixTransportEvent(input)) {
      this.options.onSecurityError?.('Ignored malformed native Matrix payload')
      return
    }
    const eventType = input.event.type
    if (![MATRIX_RESPONSE_EVENT, MATRIX_CONVERSATION_EVENT, MATRIX_INVENTORY_EVENT, MATRIX_GATEWAY_EVENT, MATRIX_AUTHORIZATION_EVENT].includes(eventType ?? '')) return
    if (!input.encrypted) {
      this.options.onSecurityError?.(`Ignored unencrypted ${eventType}`)
      return
    }
    if (!input.verifiedDevice && eventType !== MATRIX_GATEWAY_EVENT) {
      this.options.onSecurityError?.(`Ignored ${eventType} from an unverified Matrix device`)
      return
    }
    try {
      const content = record(input.event.content)
      if (eventType === MATRIX_RESPONSE_EVENT) {
        const gatewayId = requiredText(content.gatewayId, 'gatewayId')
        const response = parseClientGatewayResponseFrame(content.response)
        this.rememberResponse(gatewayId, response)
      } else if (eventType === MATRIX_INVENTORY_EVENT) {
        const gatewayId = requiredText(content.gatewayId, 'gatewayId')
        const inventory = parseInventorySnapshot(content.inventory)
        const current = this.inventories.get(gatewayId)
        if (!current || inventory.revision >= current.revision) this.inventories.set(gatewayId, inventory)
      } else if (eventType === MATRIX_GATEWAY_EVENT) {
        const parsed = parseGateway(content.gateway)
        const announcedDevice = parsed.capabilities.metadata?.matrixDeviceId
        if (typeof announcedDevice !== 'string' || !input.senderDevice || announcedDevice !== input.senderDevice) {
          throw new Error('Gateway Matrix device does not match the encrypted sender')
        }
        let compatible = false
        try {
          compatible = matrixControlRangesOverlap(
            CURRENT_MATRIX_CONTROL_RANGE,
            parseMatrixControlVersionRange(content.matrixControl),
          )
        } catch { /* A missing declaration identifies a pre-negotiation Gateway. */ }
        if (!compatible) {
          this.rememberGatewayCompatibility(parsed, input.verifiedDevice, false)
          return
        }
        // Current-version untargeted announcements are presence wakeups only.
        if (typeof content.recipientDeviceId !== 'string') return
        if (content.recipientDeviceId !== this.options.session.deviceId) return
        const discoveryRequestId = typeof content.discoveryRequestId === 'string' ? content.discoveryRequestId : undefined
        if (discoveryRequestId && discoveryRequestId !== this.activeDiscoveryRequestId) return
        if (typeof content.clientDeviceVerified !== 'boolean' || content.matrixControlCompatible !== true) {
          this.rememberGatewayCompatibility(parsed, input.verifiedDevice, false)
          return
        }
        const matrixVerified = input.verifiedDevice && content.clientDeviceVerified
        const gateway: Gateway = {
          ...parsed,
          capabilities: {
            ...parsed.capabilities,
            providers: matrixVerified ? parsed.capabilities.providers : [],
            features: matrixVerified ? parsed.capabilities.features : [],
            metadata: {
              ...parsed.capabilities.metadata,
              gatewayDeviceVerified: input.verifiedDevice,
              clientDeviceVerified: content.clientDeviceVerified,
              matrixControlNegotiated: true,
              matrixControlCompatible: true,
              matrixVerified,
            },
          },
        }
        const current = this.gateways.get(gateway.id)
        if (!current || Date.parse(gateway.lastSeenAt ?? '') >= Date.parse(current.lastSeenAt ?? '')) {
          this.gateways.set(gateway.id, gateway)
          this.gatewayAnnouncementRevision += 1
        }
      } else if (eventType === MATRIX_AUTHORIZATION_EVENT) {
        const request = parseApprovalRequest(content, input.senderDevice)
        if (request.publicKey.kid === this.options.executionKeyId) return
        this.approvalRequests.set(request.requestId, request)
        this.notifyApprovals()
      } else {
        const envelope = parseSessionEventEnvelope(content.event)
        if (this.seenConversationEvents.has(envelope.eventId)) return
        this.seenConversationEvents.add(envelope.eventId)
        if (this.seenConversationEvents.size > 10_000) this.seenConversationEvents.delete(this.seenConversationEvents.values().next().value!)
        for (const subscriber of this.sessionSubscribers.get(envelope.sessionId) ?? []) subscriber(envelope)
      }
    } catch (error) {
      this.options.onSecurityError?.(`Ignored malformed ${eventType}: ${error instanceof Error ? error.message : error}`)
    }
  }

  private notifyApprovals(): void {
    const snapshot = [...this.approvalRequests.values()]
    for (const subscriber of this.approvalSubscribers) subscriber(snapshot)
  }

  private rememberGatewayCompatibility(parsed: Gateway, gatewayDeviceVerified: boolean, compatible: boolean): void {
    const gateway: Gateway = {
      ...parsed,
      capabilities: {
        ...parsed.capabilities,
        providers: [],
        features: [],
        metadata: {
          ...parsed.capabilities.metadata,
          gatewayDeviceVerified,
          matrixControlNegotiated: true,
          matrixControlCompatible: compatible,
          matrixVerified: false,
        },
      },
    }
    this.gateways.set(gateway.id, gateway)
    this.gatewayAnnouncementRevision += 1
  }

  private rememberResponse(gatewayId: string, response: ClientGatewayResponseFrame): void {
    this.responses.set(response.requestId, response)
    if (this.responses.size > 2_000) this.responses.delete(this.responses.keys().next().value!)
    const pending = this.pending.get(response.requestId)
    if (response.status === 'failed' && response.error.code === 'matrix_device_verification_required') {
      const gateway = this.gateways.get(gatewayId)
      if (gateway) {
        this.gateways.set(gatewayId, {
          ...gateway,
          capabilities: {
            ...gateway.capabilities,
            providers: [],
            features: [],
            metadata: {
              ...gateway.capabilities.metadata,
              clientDeviceVerified: false,
              matrixVerified: false,
            },
          },
        })
        this.gatewayAnnouncementRevision += 1
      }
    }
    if (response.status === 'failed' && response.error.code === 'matrix_control_protocol_unsupported') {
      const gateway = this.gateways.get(gatewayId)
      if (gateway) this.rememberGatewayCompatibility(gateway, true, false)
    }
    if (response.status === 'failed' && response.error.code === 'matrix_control_negotiation_required') {
      const gateway = this.gateways.get(gatewayId)
      if (gateway) {
        this.gateways.set(gatewayId, {
          ...gateway,
          capabilities: { ...gateway.capabilities, metadata: {
            ...gateway.capabilities.metadata,
            matrixControlNegotiated: false,
            matrixVerified: false,
          } },
        })
        this.discoveryLastCompletedAt = 0
      }
    }
    if (!pending) return
    if (pending.timer) clearTimeout(pending.timer)
    this.pending.delete(response.requestId)
    pending.resolve(response)
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('event content is not an object')
  return value as Record<string, unknown>
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${name} is required`)
  return value
}

function parseApprovalRequest(content: Record<string, unknown>, senderDevice?: string): ExecutionRootApprovalRequest {
  if (content.version !== PROTOCOL_VERSION || content.type !== 'execution.root.request') {
    throw new Error('unsupported execution approval request')
  }
  const key = record(content.publicKey)
  if (key.kty !== 'EC' || key.crv !== 'P-256' || key.alg !== 'ES256' || key.use !== 'sig'
    || 'd' in key) throw new Error('execution approval key must be a public ES256 P-256 JWK')
  const ownerId = requiredText(content.ownerId, 'ownerId')
  if (!senderDevice || ownerId !== senderDevice) {
    throw new Error('execution approval owner must match the verified Matrix sender device')
  }
  return {
    requestId: requiredText(content.requestId, 'requestId'),
    gatewayId: requiredText(content.gatewayId, 'gatewayId'),
    ownerId,
    label: requiredText(content.label, 'label'),
    senderDevice,
    publicKey: {
      kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig',
      kid: requiredText(key.kid, 'publicKey.kid'),
      x: requiredText(key.x, 'publicKey.x'),
      y: requiredText(key.y, 'publicKey.y'),
    },
  }
}
