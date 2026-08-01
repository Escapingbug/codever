import {
    encryptMedia,
    importDeviceKeyPair,
    openSecureEnvelope,
    publicKeyId,
    sealSecureEnvelope,
    sha256,
    type DeviceKeyPair,
} from '@codever/security'
import { createHash, randomUUID } from 'node:crypto'
import { FileReplayStore } from '@codever/security/node'
import {
    MAX_HISTORY_PAGE_BYTES,
    MAX_INLINE_HISTORY_PAGE_BYTES,
    type HistoryPage,
    type HistoryRequest,
    type CodeverAttachment,
    type JsonValue,
    type SignedSecureEnvelope,
} from '@codever/protocol'
import {
    CODEVER_MATRIX_EXTENSION,
    CODEVER_MATRIX_PROTOCOL_VERSION,
    type MatrixRoomMessageContent,
    type MatrixSendEventRequest,
    type MatrixSendEventResult,
    type MatrixTransport,
} from '@/channel/matrix'
import type {
    MatrixGatewayApplicationSecurityConfig,
    MatrixGatewayRoomConfig,
    MatrixGatewayTrustedDevice,
} from './config'
import {
    FileMatrixDeliveryOutbox,
    type DurableMatrixDelivery,
    type MatrixHistoryDeliveryPage,
} from './fileDeliveryOutbox'

export interface OpenedGatewayMatrixContent {
    content: Record<string, unknown>
    authenticatedDeviceId: string
    trustedDevice: MatrixGatewayTrustedDevice
}

export type TrustedDeviceProvider = () => Promise<readonly MatrixGatewayTrustedDevice[]>

export interface GatewayStateSnapshot {
    revision: number
    revisionEpoch: string
    revisionEpochGeneration: number
    stateVersion: number
    currentSessionId: string | null
    sessions: Array<{
        id: string
        title: string
        updatedAt: number
        status: 'idle' | 'running' | 'stopping' | 'failed'
        projectId: string
        projectName: string
        cwd: string
        provider: string
        model?: string
        reasoningEffort?: string
    }>
    workspace: {
        projectId: string
        projectName: string
        cwd: string
        provider: string
        model?: string
        reasoningEffort?: string
        permissionMode: string
    }
    capabilities: {
        models: Array<{
            id: string
            name: string
            defaultReasoningLevel?: string
            supportedReasoningLevels?: Array<{
                effort: string
                description?: string
            }>
        }>
        permissionModes: Array<{ id: string; name: string }>
        canCreateSession: boolean
        canSelectSession: boolean
    }
}

export class GatewaySecureContentLayer {
    private gatewayKeys: DeviceKeyPair | null = null
    private readonly replayStore: FileReplayStore
    private readonly deliveryOutbox: FileMatrixDeliveryOutbox
    /** Logical Matrix event ID -> per-recipient physical event ID. */
    private readonly deliveryIds = new Map<string, Map<string, string>>()
    private readonly retryingRooms = new Map<string, Promise<void>>()
    private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
    private readonly retryAttempts = new Map<string, number>()

    constructor(
        private readonly gatewayId: string,
        private readonly config: MatrixGatewayApplicationSecurityConfig,
        private readonly trustedDevices: readonly MatrixGatewayTrustedDevice[],
        private readonly getTrustedDevices?: TrustedDeviceProvider,
    ) {
        this.replayStore = new FileReplayStore(config.envelopeReplayLedgerPath)
        this.deliveryOutbox = new FileMatrixDeliveryOutbox(
            `${config.envelopeReplayLedgerPath}.delivery-outbox.jsonl`,
        )
    }

    async initialize(now = Date.now()): Promise<void> {
        this.gatewayKeys = await importDeviceKeyPair(this.config.gatewayKeyPair)
        await this.replayStore.prune(now)
        await this.deliveryOutbox.initialize()
        for (const mapping of this.deliveryOutbox.logicalEventMappings()) {
            this.deliveryIds.set(mapping.eventId, mapping.recipientEvents)
        }
    }

    stopRetries(): void {
        for (const timer of this.retryTimers.values()) clearTimeout(timer)
        this.retryTimers.clear()
        this.retryAttempts.clear()
    }

    transportForRoom(room: MatrixGatewayRoomConfig, transport: MatrixTransport): MatrixTransport {
        return {
            sendEncryptedRoomEvent: request =>
                this.sealOutgoingToAll(request, room, transport),
            ...(transport.setTyping ? { setTyping: transport.setTyping.bind(transport) } : {}),
            ...(transport.uploadEncryptedMedia
                ? { uploadEncryptedMedia: transport.uploadEncryptedMedia.bind(transport) }
                : {}),
            ...(transport.downloadEncryptedMedia
                ? { downloadEncryptedMedia: transport.downloadEncryptedMedia.bind(transport) }
                : {}),
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
        const device = (await this.currentTrustedDevices(now)).find(candidate =>
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
            trustedDevice: device,
        }
    }

    async sendCommandAccepted(
        room: MatrixGatewayRoomConfig,
        deviceId: string,
        commandId: string,
        sequence: number,
        revision: number,
        revisionEpoch: string,
        transport: MatrixTransport,
    ): Promise<MatrixSendEventResult> {
        const active = (await this.currentTrustedDevices()).filter(device =>
            device.allowedRoomIds.includes(room.roomId),
        )
        const recipient = active.find(device =>
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
                    revision,
                    revision_epoch: revisionEpoch,
                    active_device_count: active.length,
                },
            },
        }, room, recipient, transport)
    }

    async sendRevisionConflict(
        room: MatrixGatewayRoomConfig,
        deviceId: string,
        commandId: string,
        expectedRevision: number,
        receivedBaseRevision: number,
        revisionEpoch: string,
        transport: MatrixTransport,
    ): Promise<MatrixSendEventResult> {
        return this.sendToDevice(room, deviceId, {
            version: CODEVER_MATRIX_PROTOCOL_VERSION,
            kind: 'revision_conflict',
            command_id: commandId,
            expected_revision: expectedRevision,
            received_base_revision: receivedBaseRevision,
            revision_epoch: revisionEpoch,
        }, `codever.command.conflict.${commandId}`, transport)
    }

    async sendCollaborationPrompt(
        room: MatrixGatewayRoomConfig,
        input: {
            commandId: string
            revision: number
            sessionId?: string
            originDeviceId: string
            originDeviceName: string
            text: string
            attachments?: CodeverAttachment[]
        },
        transport: MatrixTransport,
    ): Promise<MatrixSendEventResult> {
        return this.sealOutgoingToAll({
            roomId: room.roomId,
            eventType: 'm.room.message',
            transactionId: `codever.collaboration.${input.revision}.${input.commandId}`,
            content: {
                msgtype: 'm.text',
                body: 'Encrypted Codever collaboration event',
                [CODEVER_MATRIX_EXTENSION]: {
                    version: CODEVER_MATRIX_PROTOCOL_VERSION,
                    kind: 'collaboration_command',
                    command_id: input.commandId,
                    revision: input.revision,
                    ...(input.sessionId ? { session_id: input.sessionId } : {}),
                    origin_device_id: input.originDeviceId,
                    origin_device_name: input.originDeviceName,
                    operation: 'prompt',
                    text: input.text,
                    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
                },
            },
        }, room, transport)
    }

    async sendCommandResult(
        room: MatrixGatewayRoomConfig,
        deviceId: string,
        commandId: string,
        sequence: number,
        revision: number,
        revisionEpoch: string,
        outcome: 'succeeded' | 'failed',
        transport: MatrixTransport,
        error?: string,
        sessionId?: string | null,
        result?: JsonValue,
    ): Promise<MatrixSendEventResult> {
        return this.sendToDevice(room, deviceId, {
            version: CODEVER_MATRIX_PROTOCOL_VERSION,
            kind: 'command_result',
            command_id: commandId,
            sequence,
            revision,
            revision_epoch: revisionEpoch,
            ...(sessionId ? { session_id: sessionId } : {}),
            outcome,
            ...(error ? { error } : {}),
            ...(result === undefined ? {} : { result }),
        }, `codever.command.result.${commandId}.${outcome}`, transport)
    }

    async sendGatewayState(
        room: MatrixGatewayRoomConfig,
        state: GatewayStateSnapshot,
        transport: MatrixTransport,
    ): Promise<MatrixSendEventResult> {
        if (!Number.isSafeInteger(state.revision) || state.revision < 0) {
            throw new Error('Gateway state revision must be a non-negative integer')
        }
        if (
            !Number.isSafeInteger(state.revisionEpochGeneration)
            || state.revisionEpochGeneration < 1
        ) {
            throw new Error('Gateway revision epoch generation must be a positive integer')
        }
        if (!Number.isSafeInteger(state.stateVersion) || state.stateVersion < 1) {
            throw new Error('Gateway state version must be a positive integer')
        }
        const extension = {
            version: CODEVER_MATRIX_PROTOCOL_VERSION,
            kind: 'gateway_state',
            revision: state.revision,
            revision_epoch: state.revisionEpoch,
            revision_epoch_generation: state.revisionEpochGeneration,
            state_version: state.stateVersion,
            current_session_id: state.currentSessionId,
            sessions: state.sessions.map(session => ({
                id: session.id,
                title: session.title,
                updated_at: session.updatedAt,
                status: session.status,
                project_id: session.projectId,
                project_name: session.projectName,
                cwd: session.cwd,
                provider: session.provider,
                ...(session.model ? { model: session.model } : {}),
                ...(session.reasoningEffort
                    ? { reasoning_effort: session.reasoningEffort }
                    : {}),
            })),
            workspace: {
                project_id: state.workspace.projectId,
                project_name: state.workspace.projectName,
                cwd: state.workspace.cwd,
                provider: state.workspace.provider,
                ...(state.workspace.model ? { model: state.workspace.model } : {}),
                ...(state.workspace.reasoningEffort
                    ? { reasoning_effort: state.workspace.reasoningEffort }
                    : {}),
                permission_mode: state.workspace.permissionMode,
            },
            capabilities: {
                models: state.capabilities.models.map(model => ({
                    id: model.id,
                    name: model.name,
                    ...(model.defaultReasoningLevel
                        ? { default_reasoning_level: model.defaultReasoningLevel }
                        : {}),
                    ...(model.supportedReasoningLevels
                        ? {
                            supported_reasoning_levels:
                                model.supportedReasoningLevels.map(level => ({
                                    effort: level.effort,
                                    ...(level.description
                                        ? { description: level.description }
                                        : {}),
                                })),
                        }
                        : {}),
                })),
                permission_modes: state.capabilities.permissionModes.map(mode => ({
                    id: mode.id,
                    name: mode.name,
                })),
                can_create_session: state.capabilities.canCreateSession,
                can_select_session: state.capabilities.canSelectSession,
            },
        }
        return this.sealOutgoingToAll({
            roomId: room.roomId,
            eventType: 'm.room.message',
            // A state sync is an explicit new snapshot even when the command
            // revision is unchanged (for example, after device pairing).
            transactionId: `codever.gateway.state.${state.revision}.${randomUUID()}`,
            content: {
                msgtype: 'm.notice',
                body: 'Encrypted Codever gateway state',
                [CODEVER_MATRIX_EXTENSION]: extension,
            },
        }, room, transport)
    }

    /** Sends one bounded transcript page instead of replaying every item as a
     * separate Matrix event. Stable logical item IDs keep later edits working
     * without manufacturing recipient-specific timeline history.
     */
    async sendHistoryPage(
        room: MatrixGatewayRoomConfig,
        deviceId: string,
        request: HistoryRequest,
        transport: MatrixTransport,
    ): Promise<MatrixSendEventResult> {
        const now = Date.now()
        const active = (await this.currentTrustedDevices(now)).filter(device =>
            device.allowedRoomIds.includes(room.roomId),
        )
        const recipient = active.find(device => device.deviceId === deviceId)
        if (!recipient) throw new Error(`History recipient ${deviceId} is not active for this room`)
        const page = this.deliveryOutbox.historyPage(
            room.roomId,
            request.sessionId,
            request.before,
            request.limit,
            request.maxBytes ?? MAX_HISTORY_PAGE_BYTES,
        )
        if (request.maxBytes === undefined) {
            return this.sendLegacyHistoryPage(
                room,
                recipient,
                request,
                page,
                active.length,
                now,
                transport,
            )
        }
        const encodedItems = new TextEncoder().encode(JSON.stringify(page.items))
        if (encodedItems.byteLength !== page.byteLength) {
            throw new Error('Matrix history page byte accounting mismatch')
        }
        const baseResponse = {
            kind: 'codever.history.page',
            version: CODEVER_MATRIX_PROTOCOL_VERSION,
            requestId: request.requestId,
            sessionId: request.sessionId,
            ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
            hasMore: page.hasMore,
            replayed: page.items.length,
        } as const
        let response: HistoryPage
        if (encodedItems.byteLength <= MAX_INLINE_HISTORY_PAGE_BYTES) {
            response = { ...baseResponse, items: page.items }
        } else {
            const upload = transport.uploadEncryptedMedia
            if (!upload) {
                throw new Error('Matrix transport does not support encrypted history batch upload')
            }
            const encrypted = await encryptMedia(encodedItems)
            const uploaded = await upload.call(transport, {
                ciphertext: encrypted.ciphertext,
            })
            response = {
                ...baseResponse,
                batch: {
                    encoding: 'json',
                    itemCount: page.items.length,
                    plaintextSize: encodedItems.byteLength,
                    plaintextSha256: await sha256(encodedItems),
                    media: {
                        url: uploaded.url,
                        ...encrypted.descriptor,
                    },
                },
            }
        }
        return this.sendToDevice(room, deviceId, {
            version: CODEVER_MATRIX_PROTOCOL_VERSION,
            kind: 'history_page',
            history_page: response,
        }, `codever.history.page.${request.requestId}`, transport, {
            retryPending: false,
        })
    }

    private async sendLegacyHistoryPage(
        room: MatrixGatewayRoomConfig,
        recipient: MatrixGatewayTrustedDevice,
        request: HistoryRequest,
        page: MatrixHistoryDeliveryPage,
        activeDeviceCount: number,
        now: number,
        transport: MatrixTransport,
    ): Promise<MatrixSendEventResult> {
        await this.retryPendingForRoom(room, transport).catch(() => undefined)
        const identity = await recipientIdentity(recipient)
        let replayed = 0
        for (const entry of page.deliveries) {
            const prior = this.deliveryOutbox.recipientDelivery(
                entry.logicalKey,
                recipient.deviceId,
            )
            if (prior && !sameRecipientIdentity(prior, identity)) {
                await this.deliveryOutbox.markAbandoned(
                    prior.deliveryId,
                    'recipient_identity_changed',
                    now,
                )
            } else if (prior) {
                continue
            }

            const logicalTargetId = entry.replacementLogicalKey
                ? this.deliveryOutbox.logicalEventId(entry.replacementLogicalKey)
                : undefined
            const physicalTargetId = logicalTargetId
                ? this.deliveryIds.get(logicalTargetId)?.get(recipient.deviceId)
                : undefined
            const originalTargetId = replacementTargetId(entry.content)
            const addressed = originalTargetId
                ? contentForRecipient(entry.content, originalTargetId, physicalTargetId)
                : structuredClone(entry.content)
            const content = withHistoryReplay(
                withActiveDeviceCount(addressed, activeDeviceCount),
                request.requestId,
                entry.createdAt,
            )
            const recipientRequest: MatrixSendEventRequest = {
                roomId: room.roomId,
                eventType: 'm.room.message',
                transactionId: recipientTransactionId(
                    `codever.history.replay.${request.requestId}.${entry.cursor}`,
                    recipient.deviceId,
                ),
                content,
            }
            const delivery = durableDelivery(
                entry.logicalKey,
                recipient.deviceId,
                identity,
                recipientRequest,
                entry.createdAt,
            )
            await this.deliveryOutbox.stage(delivery)
            let result: MatrixSendEventResult
            try {
                result = await this.deliverDurable(delivery, room, recipient, transport)
            } catch (error) {
                this.schedulePendingRetry(room, transport)
                throw error
            }
            const logicalEventId = this.deliveryOutbox.logicalEventId(entry.logicalKey)
                ?? result.eventId
            await this.deliveryOutbox.recordLogicalEvent(
                entry.logicalKey,
                logicalEventId,
                entry.createdAt,
            )
            this.deliveryIds.set(
                logicalEventId,
                this.deliveryOutbox.recipientEvents(entry.logicalKey),
            )
            replayed += 1
        }

        const response: HistoryPage = {
            kind: 'codever.history.page',
            version: CODEVER_MATRIX_PROTOCOL_VERSION,
            requestId: request.requestId,
            sessionId: request.sessionId,
            ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
            hasMore: page.hasMore,
            replayed,
        }
        return this.sendToDevice(room, recipient.deviceId, {
            version: CODEVER_MATRIX_PROTOCOL_VERSION,
            kind: 'history_page',
            history_page: response,
        }, `codever.history.page.${request.requestId}`, transport)
    }

    /**
     * Retries only the durable recipient copies that are still missing. Calls
     * for the same room are coalesced so duplicate commands and startup
     * recovery cannot race each other.
     */
    retryPendingForRoom(
        room: MatrixGatewayRoomConfig,
        transport: MatrixTransport,
        commandId?: string,
    ): Promise<void> {
        const retryKey = commandId ? `${room.roomId}\0${commandId}` : room.roomId
        const existing = this.retryingRooms.get(retryKey)
        if (existing) return existing
        const retry = this.performPendingRetries(room, transport, commandId)
            .finally(() => this.retryingRooms.delete(retryKey))
        this.retryingRooms.set(retryKey, retry)
        return retry
    }

    scheduleRecoveryForRoom(
        room: MatrixGatewayRoomConfig,
        transport: MatrixTransport,
    ): void {
        this.schedulePendingRetry(room, transport)
    }

    private async sealOutgoingToAll(
        request: MatrixSendEventRequest,
        room: MatrixGatewayRoomConfig,
        transport: MatrixTransport,
    ): Promise<MatrixSendEventResult> {
        const now = Date.now()
        await this.retryPendingForRoom(room, transport).catch(() => undefined)
        const recipients = (await this.currentTrustedDevices(now))
            .filter(device => device.allowedRoomIds.includes(room.roomId))
        if (recipients.length === 0) {
            throw new Error(`No active application-layer recipients for room ${room.roomId}`)
        }
        const replacementTarget = replacementTargetId(request.content)
        const targetDeliveries = replacementTarget
            ? this.deliveryIds.get(replacementTarget)
            : undefined
        const stableTarget = replacementTarget
            ? this.deliveryOutbox.historyEventIdForEvent(replacementTarget)
            : undefined
        const logicalKey = logicalDeliveryKey(request)
        const candidates = await Promise.all(recipients.map(async recipient => {
            const recipientTarget = targetDeliveries?.get(recipient.deviceId) ?? stableTarget
            const recipientContent = replacementTarget
                ? contentForRecipient(request.content, replacementTarget, recipientTarget)
                : request.content
            const content = withActiveDeviceCount(recipientContent, recipients.length)
            const recipientRequest = {
                ...request,
                content,
                transactionId: recipientTransactionId(request.transactionId, recipient.deviceId),
            }
            const identity = await recipientIdentity(recipient)
            const prior = this.deliveryOutbox.recipientDelivery(logicalKey, recipient.deviceId)
            if (prior && !sameRecipientIdentity(prior, identity)) {
                await this.deliveryOutbox.markAbandoned(
                    prior.deliveryId,
                    'recipient_identity_changed',
                    now,
                )
                return null
            }
            const delivery = durableDelivery(
                logicalKey,
                recipient.deviceId,
                identity,
                recipientRequest,
                now,
            )
            await this.deliveryOutbox.stage(delivery)
            return { recipient, delivery }
        }))
        const deliveries = candidates.filter(
            (candidate): candidate is NonNullable<typeof candidate> => candidate !== null,
        )
        const settled = await Promise.allSettled(deliveries.map(async ({ recipient, delivery }) => ({
            deviceId: recipient.deviceId,
            result: await this.deliverDurable(delivery, room, recipient, transport),
        })))
        const successful = settled
            .filter((delivery): delivery is PromiseFulfilledResult<{
                deviceId: string
                result: MatrixSendEventResult
            }> => delivery.status === 'fulfilled')
            .map(delivery => delivery.value)
        const existingLogicalEventId = this.deliveryOutbox.logicalEventId(logicalKey)
        const primaryEventId = existingLogicalEventId ?? successful[0]?.result.eventId
        if (!primaryEventId) {
            const firstFailure = settled.find(
                (delivery): delivery is PromiseRejectedResult => delivery.status === 'rejected',
            )
            throw firstFailure?.reason ?? new Error(`No Matrix delivery completed for room ${room.roomId}`)
        }
        await this.deliveryOutbox.recordLogicalEvent(logicalKey, primaryEventId, now)
        this.deliveryIds.set(
            primaryEventId,
            this.deliveryOutbox.recipientEvents(logicalKey),
        )
        // A partial fan-out is a successful logical delivery. Missing device
        // copies remain durable and keep their original recipient transaction
        // IDs; they are retried at startup, on duplicate commands, or on the
        // next explicit recovery pass. This prevents DeliveryOutbox from
        // emitting a room-wide fallback message for an edit.
        if (settled.some(delivery => delivery.status === 'rejected')) {
            this.schedulePendingRetry(room, transport)
        }
        return { eventId: primaryEventId }
    }

    private async sendToDevice(
        room: MatrixGatewayRoomConfig,
        deviceId: string,
        extension: Record<string, unknown>,
        transactionId: string,
        transport: MatrixTransport,
        options: { retryPending?: boolean } = {},
    ): Promise<MatrixSendEventResult> {
        if (options.retryPending !== false) {
            await this.retryPendingForRoom(room, transport).catch(() => undefined)
        }
        const active = (await this.currentTrustedDevices()).filter(device =>
            device.allowedRoomIds.includes(room.roomId),
        )
        const recipient = active.find(device => device.deviceId === deviceId)
        if (!recipient) throw new Error(`Command recipient ${deviceId} is not active for this room`)
        const request: MatrixSendEventRequest = {
            roomId: room.roomId,
            eventType: 'm.room.message',
            transactionId: recipientTransactionId(transactionId, deviceId),
            content: {
                msgtype: 'm.notice',
                body: 'Encrypted Codever command status',
                [CODEVER_MATRIX_EXTENSION]: {
                    ...extension,
                    active_device_count: active.length,
                },
            },
        }
        const logicalKey = logicalDeliveryKey(request)
        const identity = await recipientIdentity(recipient)
        const prior = this.deliveryOutbox.recipientDelivery(logicalKey, recipient.deviceId)
        if (prior && !sameRecipientIdentity(prior, identity)) {
            await this.deliveryOutbox.markAbandoned(
                prior.deliveryId,
                'recipient_identity_changed',
            )
            throw new Error(
                `Refusing to recover delivery for rotated recipient ${recipient.deviceId}`,
            )
        }
        const delivery = durableDelivery(
            logicalKey,
            recipient.deviceId,
            identity,
            request,
            Date.now(),
        )
        await this.deliveryOutbox.stage(delivery)
        let result: MatrixSendEventResult
        try {
            result = await this.deliverDurable(delivery, room, recipient, transport)
        } catch (error) {
            this.schedulePendingRetry(room, transport)
            throw error
        }
        await this.deliveryOutbox.recordLogicalEvent(logicalKey, result.eventId)
        return result
    }

    private schedulePendingRetry(
        room: MatrixGatewayRoomConfig,
        transport: MatrixTransport,
    ): void {
        if (this.retryTimers.has(room.roomId)) return
        const attempt = this.retryAttempts.get(room.roomId) ?? 0
        const delayMs = Math.min(250 * (2 ** attempt), 30_000)
        const timer = setTimeout(() => {
            this.retryTimers.delete(room.roomId)
            void this.retryPendingForRoom(room, transport)
                .then(() => this.retryAttempts.delete(room.roomId))
                .catch(() => {
                    this.retryAttempts.set(room.roomId, attempt + 1)
                    this.schedulePendingRetry(room, transport)
                })
        }, delayMs)
        timer.unref?.()
        this.retryTimers.set(room.roomId, timer)
    }

    private async performPendingRetries(
        room: MatrixGatewayRoomConfig,
        transport: MatrixTransport,
        commandId?: string,
    ): Promise<void> {
        const active = (await this.currentTrustedDevices())
            .filter(device => device.allowedRoomIds.includes(room.roomId))
        const byId = new Map(active.map(device => [device.deviceId, device]))
        const pending = this.deliveryOutbox.listPending(room.roomId)
            .filter(delivery => byId.has(delivery.recipientDeviceId))
            .filter(delivery =>
                commandId === undefined || deliveryBelongsToCommand(delivery, commandId),
            )
        const settled = await Promise.allSettled(pending.map(async delivery => {
            const recipient = byId.get(delivery.recipientDeviceId)!
            const identity = await recipientIdentity(recipient)
            if (!sameRecipientIdentity(delivery, identity)) {
                await this.deliveryOutbox.markAbandoned(
                    delivery.deliveryId,
                    'recipient_identity_changed',
                )
                return
            }
            const result = await this.deliverDurable(delivery, room, recipient, transport)
            const logicalEventId = this.deliveryOutbox.logicalEventId(delivery.logicalKey)
            if (logicalEventId) {
                this.deliveryIds.set(
                    logicalEventId,
                    this.deliveryOutbox.recipientEvents(delivery.logicalKey),
                )
            } else {
                await this.deliveryOutbox.recordLogicalEvent(delivery.logicalKey, result.eventId)
                this.deliveryIds.set(
                    result.eventId,
                    this.deliveryOutbox.recipientEvents(delivery.logicalKey),
                )
            }
        }))
        const firstFailure = settled.find(
            (delivery): delivery is PromiseRejectedResult => delivery.status === 'rejected',
        )
        if (firstFailure) throw firstFailure.reason
    }

    private async deliverDurable(
        delivery: DurableMatrixDelivery,
        room: MatrixGatewayRoomConfig,
        recipient: MatrixGatewayTrustedDevice,
        transport: MatrixTransport,
    ): Promise<MatrixSendEventResult> {
        const deliveredEventId = this.deliveryOutbox.deliveredEventId(delivery.deliveryId)
        if (deliveredEventId) return { eventId: deliveredEventId }
        const result = await this.sealOutgoing(delivery.request, room, recipient, transport)
        await this.deliveryOutbox.markDelivered(delivery.deliveryId, result.eventId)
        return result
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

    private assertCertificateActive(device: MatrixGatewayTrustedDevice, now: number): void {
        if (device.certificateExpiresAt !== undefined && device.certificateExpiresAt <= now) {
            throw new Error(`Trusted device ${device.deviceId} pairing certificate has expired`)
        }
    }

    private requireGatewayKeys(): DeviceKeyPair {
        if (!this.gatewayKeys) throw new Error('Gateway application security is not initialized')
        return this.gatewayKeys
    }

    private async currentTrustedDevices(now = Date.now()): Promise<readonly MatrixGatewayTrustedDevice[]> {
        const devices = this.getTrustedDevices
            ? await this.getTrustedDevices()
            : this.trustedDevices
        return devices.filter(device =>
            device.certificateExpiresAt === undefined || device.certificateExpiresAt > now,
        )
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

function recipientTransactionId(transactionId: string, deviceId: string): string {
    const recipient = createHash('sha256').update(deviceId).digest('hex').slice(0, 16)
    return `${transactionId}.${recipient}`
}

function logicalDeliveryKey(request: MatrixSendEventRequest): string {
    return JSON.stringify([request.roomId, request.eventType, request.transactionId])
}

function durableDelivery(
    logicalKey: string,
    recipientDeviceId: string,
    identity: RecipientIdentity,
    request: MatrixSendEventRequest,
    createdAt: number,
): DurableMatrixDelivery {
    const deliveryId = createHash('sha256')
        .update('codever-matrix-delivery:v1\0')
        .update(logicalKey)
        .update('\0')
        .update(recipientDeviceId)
        .update('\0')
        .update(identity.recipientSequenceEpoch)
        .update('\0')
        .update(identity.recipientPublicKeyId)
        .digest('hex')
    return {
        deliveryId,
        logicalKey,
        recipientDeviceId,
        ...identity,
        request,
        createdAt,
    }
}

interface RecipientIdentity {
    recipientSequenceEpoch: string
    recipientPublicKeyId: string
}

async function recipientIdentity(
    recipient: MatrixGatewayTrustedDevice,
): Promise<RecipientIdentity> {
    if (!recipient.sequenceEpoch) {
        throw new Error(`Trusted device ${recipient.deviceId} has no certificate sequence epoch`)
    }
    return {
        recipientSequenceEpoch: recipient.sequenceEpoch,
        recipientPublicKeyId: await publicKeyId(recipient.publicKey),
    }
}

function sameRecipientIdentity(
    delivery: Pick<DurableMatrixDelivery, 'recipientSequenceEpoch' | 'recipientPublicKeyId'>,
    identity: RecipientIdentity,
): boolean {
    return delivery.recipientSequenceEpoch === identity.recipientSequenceEpoch
        && delivery.recipientPublicKeyId === identity.recipientPublicKeyId
}

function deliveryBelongsToCommand(
    delivery: DurableMatrixDelivery,
    commandId: string,
): boolean {
    const transactionId = delivery.request.transactionId
    return (
        transactionId.startsWith('codever.collaboration.')
        && transactionId.includes(`.${commandId}.`)
    ) || transactionId.startsWith(`codever.command.result.${commandId}.`)
}

function replacementTargetId(content: Record<string, unknown>): string | undefined {
    const relation = asRecord(content['m.relates_to'])
    return relation?.rel_type === 'm.replace' && typeof relation.event_id === 'string'
        ? relation.event_id
        : undefined
}

function contentForRecipient(
    content: MatrixRoomMessageContent,
    logicalTarget: string,
    physicalTarget: string | undefined,
): MatrixRoomMessageContent {
    const copy = structuredClone(content)
    if (!physicalTarget) {
        delete copy['m.relates_to']
        const extension = asRecord(copy[CODEVER_MATRIX_EXTENSION])
        if (extension?.replaces_event_id === logicalTarget) delete extension.replaces_event_id
        const newContent = asRecord(copy['m.new_content'])
        const newExtension = asRecord(newContent?.[CODEVER_MATRIX_EXTENSION])
        if (newExtension?.replaces_event_id === logicalTarget) {
            delete newExtension.replaces_event_id
        }
        return copy
    }
    const relation = asRecord(copy['m.relates_to'])
    if (relation?.event_id === logicalTarget) relation.event_id = physicalTarget
    const extension = asRecord(copy[CODEVER_MATRIX_EXTENSION])
    if (extension?.replaces_event_id === logicalTarget) {
        extension.replaces_event_id = physicalTarget
    }
    const newContent = asRecord(copy['m.new_content'])
    const newExtension = asRecord(newContent?.[CODEVER_MATRIX_EXTENSION])
    if (newExtension?.replaces_event_id === logicalTarget) {
        newExtension.replaces_event_id = physicalTarget
    }
    return copy
}

function withActiveDeviceCount(
    content: MatrixRoomMessageContent,
    activeDeviceCount: number,
): MatrixRoomMessageContent {
    const copy = structuredClone(content)
    const extension = asRecord(copy[CODEVER_MATRIX_EXTENSION])
    if (extension) extension.active_device_count = activeDeviceCount
    const newContent = asRecord(copy['m.new_content'])
    const newExtension = asRecord(newContent?.[CODEVER_MATRIX_EXTENSION])
    if (newExtension) newExtension.active_device_count = activeDeviceCount
    return copy
}

function withHistoryReplay(
    content: MatrixRoomMessageContent,
    requestId: string,
    timestamp: number,
): MatrixRoomMessageContent {
    const copy = structuredClone(content)
    const marker = { request_id: requestId, display_only: true, timestamp }
    const extension = asRecord(copy[CODEVER_MATRIX_EXTENSION])
    if (extension) extension.history_replay = marker
    const newContent = asRecord(copy['m.new_content'])
    const newExtension = asRecord(newContent?.[CODEVER_MATRIX_EXTENSION])
    if (newExtension) newExtension.history_replay = marker
    return copy
}
