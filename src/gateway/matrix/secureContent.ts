import {
    importDeviceKeyPair,
    openSecureEnvelope,
    publicKeyId,
    sealSecureEnvelope,
    type DeviceKeyPair,
} from '@codever/security'
import { randomUUID } from 'node:crypto'
import { FileReplayStore } from '@codever/security/node'
import type { JsonValue, SignedSecureEnvelope } from '@codever/protocol'
import {
    CODEVER_MATRIX_EXTENSION,
    CODEVER_MATRIX_PROTOCOL_VERSION,
    type MatrixSendEventRequest,
    type MatrixSendEventResult,
    type MatrixTransport,
} from '@/channel/matrix'
import type {
    MatrixGatewayApplicationSecurityConfig,
    MatrixGatewayRoomConfig,
    MatrixGatewayTrustedDevice,
} from './config'

export interface OpenedGatewayMatrixContent {
    content: Record<string, unknown>
    authenticatedDeviceId: string
}

export class GatewaySecureContentLayer {
    private gatewayKeys: DeviceKeyPair | null = null
    private readonly replayStore: FileReplayStore

    constructor(
        private readonly gatewayId: string,
        private readonly config: MatrixGatewayApplicationSecurityConfig,
        private readonly trustedDevices: readonly MatrixGatewayTrustedDevice[],
    ) {
        this.replayStore = new FileReplayStore(config.envelopeReplayLedgerPath)
    }

    async initialize(now = Date.now()): Promise<void> {
        this.gatewayKeys = await importDeviceKeyPair(this.config.gatewayKeyPair)
        await this.replayStore.prune(now)
    }

    transportForRoom(room: MatrixGatewayRoomConfig, transport: MatrixTransport): MatrixTransport {
        const recipient = this.recipientForRoom(room.roomId)
        return {
            sendEncryptedRoomEvent: request =>
                this.sealOutgoing(request, room, recipient, transport),
            ...(transport.setTyping ? { setTyping: transport.setTyping.bind(transport) } : {}),
        }
    }

    async openIncoming(
        input: unknown,
        room: MatrixGatewayRoomConfig,
        now = Date.now(),
    ): Promise<OpenedGatewayMatrixContent> {
        const extension = asRecord(input)
        if (
            extension?.version !== CODEVER_MATRIX_PROTOCOL_VERSION
            || extension.kind !== 'secure_envelope'
        ) {
            throw new Error('Application-layer encrypted Matrix envelope is required')
        }
        const envelope = extension.secure_envelope as SignedSecureEnvelope
        const senderDeviceId = asRecord(envelope)?.envelope
        const senderId = asRecord(senderDeviceId)?.senderDeviceId
        const device = this.trustedDevices.find(candidate =>
            candidate.deviceId === senderId && candidate.allowedRoomIds.includes(room.roomId),
        )
        if (!device) throw new Error('Secure envelope sender is not trusted for this room')
        this.assertCertificateActive(device, now)
        const keys = this.requireGatewayKeys()
        const opened = await openSecureEnvelope(envelope, {
            recipientPrivateKey: keys.privateKey,
            senderPublicKey: device.publicKey,
            expected: {
                gatewayId: this.gatewayId,
                conversationId: room.conversationId,
                direction: 'device_to_gateway',
                senderDeviceId: device.deviceId,
                recipientDeviceId: this.config.gatewayDeviceId,
                senderKeyId: await publicKeyId(device.publicKey),
                recipientKeyId: keys.keyId,
            },
            replayStore: this.replayStore,
            now,
        })
        return {
            content: requireRecord(opened.plaintext, 'Secure Matrix plaintext'),
            authenticatedDeviceId: device.deviceId,
        }
    }

    async sendCommandAccepted(
        room: MatrixGatewayRoomConfig,
        deviceId: string,
        commandId: string,
        sequence: number,
        transport: MatrixTransport,
    ): Promise<MatrixSendEventResult> {
        const recipient = this.trustedDevices.find(device =>
            device.deviceId === deviceId && device.allowedRoomIds.includes(room.roomId),
        )
        if (!recipient) throw new Error(`Command recipient ${deviceId} is not trusted for this room`)
        return this.sealOutgoing({
            roomId: room.roomId,
            eventType: 'm.room.message',
            transactionId: `codever.command.ack.${commandId}.${randomUUID()}`,
            content: {
                msgtype: 'm.notice',
                body: 'Codever command accepted',
                [CODEVER_MATRIX_EXTENSION]: {
                    version: CODEVER_MATRIX_PROTOCOL_VERSION,
                    kind: 'command_ack',
                    command_id: commandId,
                    sequence,
                },
            },
        }, room, recipient, transport)
    }

    private async sealOutgoing(
        request: MatrixSendEventRequest,
        room: MatrixGatewayRoomConfig,
        recipient: MatrixGatewayTrustedDevice,
        transport: MatrixTransport,
    ): Promise<MatrixSendEventResult> {
        const now = Date.now()
        this.assertCertificateActive(recipient, now)
        const keys = this.requireGatewayKeys()
        const certificateExpiresAt = recipient.certificateExpiresAt
        if (certificateExpiresAt === undefined) {
            throw new Error(`Trusted device ${recipient.deviceId} has no certificate expiry`)
        }
        const secureEnvelope = await sealSecureEnvelope({
            plaintext: toJsonValue(request.content),
            gatewayId: this.gatewayId,
            conversationId: room.conversationId,
            direction: 'gateway_to_device',
            senderDeviceId: this.config.gatewayDeviceId,
            recipientDeviceId: recipient.deviceId,
            senderKeyId: keys.keyId,
            recipientKeyId: await publicKeyId(recipient.publicKey),
            senderPrivateKey: keys.privateKey,
            recipientPublicKey: recipient.publicKey,
            envelopeId: request.transactionId,
            now,
            lifetimeMs: Math.min(
                certificateExpiresAt - now,
                366 * 24 * 60 * 60_000,
            ),
        })
        return transport.sendEncryptedRoomEvent({
            ...request,
            content: {
                msgtype: 'm.notice',
                body: 'Encrypted Codever message',
                [CODEVER_MATRIX_EXTENSION]: {
                    version: CODEVER_MATRIX_PROTOCOL_VERSION,
                    kind: 'secure_envelope',
                    secure_envelope: secureEnvelope,
                },
            },
        })
    }

    private recipientForRoom(roomId: string): MatrixGatewayTrustedDevice {
        const recipients = this.trustedDevices.filter(device => device.allowedRoomIds.includes(roomId))
        if (recipients.length !== 1) {
            throw new Error(`Expected exactly one application-layer recipient for room ${roomId}`)
        }
        return recipients[0] as MatrixGatewayTrustedDevice
    }

    private assertCertificateActive(device: MatrixGatewayTrustedDevice, now: number): void {
        if (device.certificateExpiresAt !== undefined && device.certificateExpiresAt <= now) {
            throw new Error(`Trusted device ${device.deviceId} pairing certificate has expired`)
        }
    }

    private requireGatewayKeys(): DeviceKeyPair {
        if (!this.gatewayKeys) throw new Error('Gateway application security is not initialized')
        return this.gatewayKeys
    }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function requireRecord(value: JsonValue, label: string): Record<string, unknown> {
    const record = asRecord(value)
    if (!record) throw new TypeError(`${label} must be a JSON object`)
    return record
}

function toJsonValue(value: unknown): JsonValue {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new TypeError('Matrix content is not JSON serializable')
    return JSON.parse(serialized) as JsonValue
}
