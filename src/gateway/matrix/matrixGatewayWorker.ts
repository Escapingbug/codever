import { randomUUID } from 'node:crypto'
import type { JWK } from '@codever/execution-auth'
import {
    CURRENT_MATRIX_CONTROL_RANGE,
    PROTOCOL_VERSION,
    matrixControlRangesOverlap,
    parseMatrixControlVersionRange,
    type ClientGatewayResponseFrame,
    type Gateway,
    type InventorySnapshot,
    type SessionEventEnvelope,
} from '@codever/protocol'
import { AuthorizedRequestProcessor } from '../authorizedRequestProcessor'
import type { MatrixTransport, NativeMatrixEvent } from './nativeMatrixTransport'

export const MATRIX_COMMAND_EVENT = 'io.codever.command.v1'
export const MATRIX_RESPONSE_EVENT = 'io.codever.response.v1'
export const MATRIX_CONVERSATION_EVENT = 'io.codever.conversation.v1'
export const MATRIX_INVENTORY_EVENT = 'io.codever.inventory.v1'
export const MATRIX_GATEWAY_EVENT = 'io.codever.gateway.v1'
export const MATRIX_DISCOVERY_EVENT = 'io.codever.discovery.v1'
export const MATRIX_AUTHORIZATION_EVENT = 'io.codever.authorization.v1'

export interface MatrixGatewayWorkerOptions {
    gatewayId: string
    controlRoomId: string
    transport: MatrixTransport
    processor: AuthorizedRequestProcessor
    currentGateway?: () => Gateway
    currentInventory?: () => Promise<InventorySnapshot>
    trustVerifiedDeviceRoot?: (ownerId: string, publicKey: JWK, label: string) => Promise<void>
    onError?: (error: Error) => void
}

export class MatrixGatewayWorker {
    private unsubscribe?: () => void
    private readonly negotiatedDevices = new Map<string, boolean>()

    constructor(private readonly options: MatrixGatewayWorkerOptions) {}

    async start(): Promise<void> {
        if (this.unsubscribe) return
        this.unsubscribe = this.options.transport.onEvent(event => {
            void this.process(event).catch(error => this.report(error))
        })
        await this.options.transport.initialize()
    }

    async stop(): Promise<void> {
        this.unsubscribe?.()
        this.unsubscribe = undefined
        await this.options.transport.close()
    }

    async publishInventory(inventory: InventorySnapshot): Promise<void> {
        await this.options.transport.send({
            roomId: this.options.controlRoomId,
            eventType: MATRIX_INVENTORY_EVENT,
            transactionId: `${this.options.gatewayId}-inventory-${inventory.revision}`,
            content: { gatewayId: this.options.gatewayId, inventory },
        })
    }

    async publishGateway(gateway: Gateway, target?: {
        recipientDeviceId: string
        clientDeviceVerified: boolean
        matrixControlCompatible: boolean
        discoveryRequestId?: string
    }): Promise<void> {
        const transactionSuffix = target?.discoveryRequestId ?? target?.recipientDeviceId ?? gateway.lastSeenAt ?? randomUUID()
        await this.options.transport.send({
            roomId: this.options.controlRoomId,
            eventType: MATRIX_GATEWAY_EVENT,
            transactionId: `${this.options.gatewayId}-presence-${transactionSuffix}`,
            content: { gateway, matrixControl: CURRENT_MATRIX_CONTROL_RANGE, ...target },
        })
    }

    async publishConversation(roomId: string, event: SessionEventEnvelope): Promise<void> {
        await this.options.transport.send({
            roomId,
            eventType: MATRIX_CONVERSATION_EVENT,
            transactionId: event.eventId,
            content: { gatewayId: this.options.gatewayId, event },
        })
    }

    private async process(input: NativeMatrixEvent): Promise<void> {
        const eventType = input.event.type
        if (typeof eventType !== 'string'
            || ![MATRIX_COMMAND_EVENT, MATRIX_DISCOVERY_EVENT, MATRIX_AUTHORIZATION_EVENT].includes(eventType)) return
        if (!input.encrypted) throw new Error('Rejected unencrypted Matrix control event')
        if (eventType === MATRIX_DISCOVERY_EVENT) {
            const discovery = parseDiscovery(input.event.content, input.senderDevice)
            const compatible = discovery.matrixControl !== undefined
                && matrixControlRangesOverlap(CURRENT_MATRIX_CONTROL_RANGE, discovery.matrixControl)
            this.negotiatedDevices.set(discovery.senderDevice, compatible)
            if (this.options.currentGateway) {
                const gateway = this.options.currentGateway()
                await this.publishGateway(input.verifiedDevice && compatible ? gateway : setupCandidate(gateway), {
                    recipientDeviceId: discovery.senderDevice,
                    clientDeviceVerified: input.verifiedDevice,
                    matrixControlCompatible: compatible,
                    discoveryRequestId: discovery.requestId,
                })
            }
            // An encrypted but unverified client may learn only that this Gateway exists so
            // the user can start SAS verification. Projects, sessions and control remain hidden.
            if (input.verifiedDevice && compatible && this.options.currentInventory) {
                await this.publishInventory(await this.options.currentInventory())
            }
            return
        }
        if (!input.verifiedDevice) {
            if (eventType === MATRIX_COMMAND_EVENT) {
                const rejected = rejectedCommand(input.event.content)
                if (this.options.currentGateway && input.senderDevice) {
                    await this.publishGateway(setupCandidate(this.options.currentGateway()), {
                        recipientDeviceId: input.senderDevice,
                        clientDeviceVerified: false,
                        matrixControlCompatible: this.negotiatedDevices.get(input.senderDevice) === true,
                    })
                }
                await this.sendResponse(input.roomId, rejected.idempotencyKey, rejected.response)
                return
            }
            throw new Error('Rejected Matrix control event from an unverified device')
        }
        const negotiation = input.senderDevice ? this.negotiatedDevices.get(input.senderDevice) : undefined
        if (negotiation !== true) {
            if (eventType === MATRIX_COMMAND_EVENT) {
                const rejected = rejectedCommand(input.event.content, negotiation === false
                    ? {
                        code: 'matrix_control_protocol_unsupported',
                        message: 'This client and Gateway use incompatible secure-control protocol versions. Update Codever on the older device.',
                        retryable: false,
                    }
                    : {
                        code: 'matrix_control_negotiation_required',
                        message: 'Secure-control protocol negotiation is required. Refresh computers and try again.',
                        retryable: true,
                    })
                await this.sendResponse(input.roomId, rejected.idempotencyKey, rejected.response)
                return
            }
            throw new Error('Rejected Matrix control event before compatible protocol negotiation')
        }
        if (eventType === MATRIX_AUTHORIZATION_EVENT) {
            if (!this.options.trustVerifiedDeviceRoot) return
            const request = parseVerifiedDeviceAuthorization(input.event.content, input.senderDevice, this.options.gatewayId)
            await this.options.trustVerifiedDeviceRoot(request.ownerId, request.publicKey, request.label)
            if (this.options.currentGateway && input.senderDevice) await this.publishGateway(this.options.currentGateway(), {
                recipientDeviceId: input.senderDevice,
                clientDeviceVerified: true,
                matrixControlCompatible: true,
            })
            if (this.options.currentInventory) await this.publishInventory(await this.options.currentInventory())
            return
        }
        const content = input.event.content
        const response = await this.options.processor.process(content)
        const request = isRecord(content) && isRecord(content.request) ? content.request : undefined
        const idempotencyKey = request && typeof request.idempotencyKey === 'string'
            ? request.idempotencyKey
            : randomUUID()
        if (response.status === 'failed') {
            const kind = request && isRecord(request.payload) && typeof request.payload.kind === 'string'
                ? request.payload.kind : 'unknown'
            this.report(new Error(`Gateway request ${kind} failed: ${response.error.code}: ${response.error.message}`))
        }
        await this.sendResponse(input.roomId, idempotencyKey, response)
    }

    private async sendResponse(roomId: string, idempotencyKey: string, response: ClientGatewayResponseFrame): Promise<void> {
        await this.options.transport.send({
            roomId,
            eventType: MATRIX_RESPONSE_EVENT,
            transactionId: `${idempotencyKey}-response`,
            content: { gatewayId: this.options.gatewayId, response },
        })
    }

    private report(value: unknown): void {
        this.options.onError?.(value instanceof Error ? value : new Error(String(value)))
    }
}

function setupCandidate(gateway: Gateway): Gateway {
    const matrixDeviceId = gateway.capabilities.metadata?.matrixDeviceId
    return {
        ...gateway,
        capabilities: {
            protocolVersions: gateway.capabilities.protocolVersions,
            providers: [],
            features: [],
            ...(typeof matrixDeviceId === 'string' ? { metadata: { matrixDeviceId } } : {}),
        },
    }
}

function parseDiscovery(value: unknown, senderDevice: string | undefined): {
    requestId: string
    senderDevice: string
    matrixControl?: ReturnType<typeof parseMatrixControlVersionRange>
} {
    if (!isRecord(value) || typeof value.requestId !== 'string' || !value.requestId) {
        throw new Error('Rejected malformed Matrix discovery request')
    }
    if (!senderDevice) throw new Error('Rejected Matrix discovery without a sender device')
    let matrixControl: ReturnType<typeof parseMatrixControlVersionRange> | undefined
    if (value.matrixControl !== undefined) {
        try { matrixControl = parseMatrixControlVersionRange(value.matrixControl) } catch { /* incompatible declaration */ }
    }
    return { requestId: value.requestId, senderDevice, ...(matrixControl ? { matrixControl } : {}) }
}

function rejectedCommand(value: unknown, error: {
    code: string
    message: string
    retryable: boolean
} = {
    code: 'matrix_device_verification_required',
    message: 'This client device is not verified by the Gateway. Verify this computer again.',
    retryable: false,
}): { idempotencyKey: string; response: ClientGatewayResponseFrame } {
    const request = isRecord(value) && isRecord(value.request) ? value.request : undefined
    if (!request || typeof request.requestId !== 'string' || !request.requestId) {
        throw new Error('Rejected malformed Matrix command from an unverified device')
    }
    const idempotencyKey = typeof request.idempotencyKey === 'string' && request.idempotencyKey
        ? request.idempotencyKey
        : request.requestId
    return {
        idempotencyKey,
        response: {
            version: PROTOCOL_VERSION,
            type: 'gateway.client.response',
            requestId: request.requestId,
            status: 'failed',
            failedAt: new Date().toISOString(),
            error,
        },
    }
}

function parseVerifiedDeviceAuthorization(
    value: unknown,
    senderDevice: string | undefined,
    gatewayId: string,
): { ownerId: string; label: string; publicKey: JWK } {
    if (!isRecord(value) || value.version !== 1 || value.type !== 'execution.root.request') {
        throw new Error('Rejected malformed Matrix execution authorization request')
    }
    if (value.gatewayId !== gatewayId) throw new Error('Rejected execution authorization for another Gateway')
    if (typeof senderDevice !== 'string' || value.ownerId !== senderDevice) {
        throw new Error('Rejected execution authorization whose owner does not match the verified Matrix device')
    }
    if (typeof value.label !== 'string' || !value.label) throw new Error('Rejected execution authorization without a label')
    const key = value.publicKey
    if (!isRecord(key) || key.kty !== 'EC' || key.crv !== 'P-256' || key.alg !== 'ES256'
        || key.use !== 'sig' || typeof key.kid !== 'string' || typeof key.x !== 'string'
        || typeof key.y !== 'string' || 'd' in key) {
        throw new Error('Rejected execution authorization with an invalid public key')
    }
    return { ownerId: value.ownerId, label: value.label, publicKey: key as JWK }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}
