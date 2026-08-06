import {
    encryptMedia,
    importDeviceKeyPair,
    openSecureEnvelope,
    publicKeyId,
    sealSecureEnvelopeBundle,
    sealSecureEnvelope,
    sha256,
    type DeviceKeyPair,
} from '@codever/security'
import { createHash, randomUUID } from 'node:crypto'
import { FileReplayStore } from '@codever/security/node'
import {
    MAX_HISTORY_PAGE_BYTES,
    MAX_INLINE_HISTORY_PAGE_BYTES,
    CODEVER_MATRIX_APPLICATION_CONTROL_EVENT_TYPE,
    type HistoryPage,
    type HistoryRequest,
    type CodeverAttachment,
    type JsonValue,
    type SessionExtensionDescriptor,
    type SessionExtensionSummary,
    type SignedSecureEnvelope,
    type SignedSecureEnvelopeBundle,
} from '@codever/protocol'
import {
    CODEVER_MATRIX_EXTENSION,
    CODEVER_MATRIX_PROTOCOL_VERSION,
    type MatrixRoomMessageContent,
    type MatrixSendEventRequest,
    type MatrixSendEventResult,
    type MatrixTransport,
} from '@/channel/matrix'
import {
    ChannelDeliveryQueuedError,
    type ChannelSendResult,
} from '@/bridge/channelPort'
import type {
    MatrixGatewayApplicationSecurityConfig,
    MatrixGatewayRoomConfig,
    MatrixGatewayTrustedDevice,
} from './config'
import {
    FileMatrixDeliveryOutbox,
    type DurableMatrixBundleDelivery,
    type DurableMatrixBundleRecipient,
    type DurableMatrixDelivery,
    type MatrixHistoryDeliveryPage,
} from './fileDeliveryOutbox'

export interface OpenedGatewayMatrixContent {
    content: Record<string, unknown>
    authenticatedDeviceId: string
    trustedDevice: MatrixGatewayTrustedDevice
}

export type TrustedDeviceProvider = () => Promise<readonly MatrixGatewayTrustedDevice[]>

const DEFAULT_DELIVERY_ATTEMPT_TIMEOUT_MS = 25_000
const MAX_MATRIX_NORMAL_IN_FLIGHT = 2

type MatrixDeliveryPriority = 'control' | 'normal' | 'recovery'

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
        activityPhase?: 'starting' | 'working' | 'stopping' | 'idle' | 'failed'
        archived?: boolean
        projectId: string
        projectName: string
        cwd: string
        provider: string
        model?: string
        reasoningEffort?: string
        extensions: SessionExtensionSummary[]
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
        canArchiveSession?: boolean
        canDeleteSession?: boolean
        sessionExtensions: SessionExtensionDescriptor[]
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
    private readonly inFlightDeliveries = new Map<string, Promise<MatrixSendEventResult>>()
    private readonly sendScheduler = new MatrixSendScheduler()
    private readonly deliveryConfirmations = new Map<string, {
        promise: Promise<ChannelSendResult>
        resolve: (result: ChannelSendResult) => void
    }>()
    private readonly confirmationCandidates = new Set<string>()
    private readonly confirmedDeliveries = new Map<string, ChannelSendResult>()

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
                this.sealOutgoingToAll(
                    request,
                    room,
                    transport,
                    matrixDeliveryPriority(request),
                ),
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
        return this.sendToDevice(room, deviceId, {
            version: CODEVER_MATRIX_PROTOCOL_VERSION,
            kind: 'command_ack',
            command_id: commandId,
            sequence,
            revision,
            revision_epoch: revisionEpoch,
        }, commandDeliveryTransactionId('ack', commandId), transport)
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
        }, commandDeliveryTransactionId('conflict', commandId), transport)
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
        }, commandDeliveryTransactionId('result', commandId, outcome), transport)
    }

    async sendGatewayState(
        room: MatrixGatewayRoomConfig,
        state: GatewayStateSnapshot,
        transport: MatrixTransport,
    ): Promise<MatrixSendEventResult> {
        const extension = gatewayStateExtension(state)
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

    async sendGatewayStateToDevice(
        room: MatrixGatewayRoomConfig,
        deviceId: string,
        state: GatewayStateSnapshot,
        requestId: string,
        transport: MatrixTransport,
    ): Promise<MatrixSendEventResult> {
        return this.sendToDevice(
            room,
            deviceId,
            gatewayStateExtension(state),
            `codever.gateway.state.request.${requestId}`,
            transport,
            'Encrypted Codever gateway state',
        )
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
        }, `codever.history.page.${request.requestId}`, transport)
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
                result = await this.deliverDurable(
                    delivery,
                    room,
                    recipient,
                    transport,
                    'control',
                )
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
     * Retries durable bundles and legacy recipient copies that are still
     * missing. Calls for the same room are coalesced so duplicate commands and
     * startup recovery cannot race each other.
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
        priority: MatrixDeliveryPriority = 'normal',
    ): Promise<MatrixSendEventResult> {
        const now = Date.now()
        const recipients = (await this.currentTrustedDevices(now))
            .filter(device => device.allowedRoomIds.includes(room.roomId))
            .sort((left, right) => left.deviceId.localeCompare(right.deviceId))
        if (recipients.length === 0) {
            throw new Error(`No active application-layer recipients for room ${room.roomId}`)
        }
        const logicalKey = logicalDeliveryKey(request)
        const existingLogicalEventId = this.deliveryOutbox.logicalEventId(logicalKey)
        if (existingLogicalEventId) return { eventId: existingLogicalEventId }
        const replacementTarget = replacementTargetId(request.content)
        const targetDeliveries = replacementTarget
            ? this.deliveryIds.get(replacementTarget)
            : undefined
        const stableTarget = replacementTarget
            ? this.deliveryOutbox.historyEventIdForEvent(replacementTarget)
            : undefined
        const physicalTargets = targetDeliveries
            ? recipients.map(recipient => targetDeliveries.get(recipient.deviceId) ?? stableTarget)
            : recipients.map(() => stableTarget)
        const uniqueTargets = new Set(physicalTargets.filter(
            (target): target is string => target !== undefined,
        ))
        const sharedTarget = stableTarget ?? (
            uniqueTargets.size === 1
                && physicalTargets.every(target => target !== undefined)
                ? [...uniqueTargets][0]
                : undefined
        )
        const addressed = replacementTarget
            ? contentForRecipient(request.content, replacementTarget, sharedTarget)
            : request.content
        const bundleRequest: MatrixSendEventRequest = {
            ...request,
            content: withLogicalDeliveryIdentity(
                withActiveDeviceCount(addressed, recipients.length),
                stableLogicalEventId(logicalKey),
                sharedTarget,
            ),
        }
        const identities = await Promise.all(recipients.map(bundleRecipientIdentity))
        const prior = this.deliveryOutbox.bundleDelivery(logicalKey)
        if (prior && !sameBundleRecipientIdentities(prior.recipients, identities)) {
            await this.deliveryOutbox.markAbandoned(
                prior.deliveryId,
                'recipient_identity_changed',
                now,
            )
        }
        const delivery = durableBundleDelivery(logicalKey, identities, bundleRequest, now)
        await this.deliveryOutbox.stageBundle(delivery)

        // Stage the current logical message before touching older gaps. A slow
        // or offline device must never keep the newest reply outside the WAL.
        this.schedulePendingRetry(room, transport)
        this.confirmationCandidates.add(logicalKey)

        let result: MatrixSendEventResult
        try {
            result = await this.deliverBundleDurable(
                delivery,
                room,
                recipients,
                transport,
                priority,
            )
        } catch (error) {
            if (error instanceof PermanentMatrixDeliveryError) {
                this.clearConfirmationCandidate(logicalKey)
                if (isCoalescibleSnapshot(request) && error instanceof SupersededMatrixDeliveryError) {
                    return { eventId: supersededEventId(logicalKey) }
                }
                throw error.deliveryCause
            }
            this.schedulePendingRetry(room, transport)
            throw new ChannelDeliveryQueuedError(
                `Matrix delivery is durably queued for retry: ${formatError(error)}`,
                logicalKey,
                error,
                this.waitForDeliveryConfirmation(logicalKey),
            )
        }

        const primaryEventId = result.eventId
        this.clearConfirmationCandidate(logicalKey)
        await this.deliveryOutbox.recordLogicalEvent(logicalKey, primaryEventId, now)
        this.deliveryIds.set(
            primaryEventId,
            this.deliveryOutbox.recipientEvents(logicalKey),
        )
        return { eventId: primaryEventId }
    }

    private async sendToDevice(
        room: MatrixGatewayRoomConfig,
        deviceId: string,
        extension: Record<string, unknown>,
        transactionId: string,
        transport: MatrixTransport,
        body = 'Encrypted Codever command status',
    ): Promise<MatrixSendEventResult> {
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
                body,
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
            result = await this.deliverDurable(
                delivery,
                room,
                recipient,
                transport,
                'control',
            )
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
        const pending = [
            ...this.deliveryOutbox.listPendingBundles(room.roomId)
                .map(delivery => ({ kind: 'bundle' as const, delivery })),
            ...this.deliveryOutbox.listPending(room.roomId)
                .filter(delivery => byId.has(delivery.recipientDeviceId))
                .map(delivery => ({ kind: 'recipient' as const, delivery })),
        ]
            .filter(delivery =>
                commandId === undefined || deliveryBelongsToCommand(delivery.delivery, commandId),
            )
            .sort((left, right) => left.delivery.createdAt - right.delivery.createdAt)
        for (const pendingDelivery of pending) {
            if (pendingDelivery.kind === 'bundle') {
                const { delivery } = pendingDelivery
                const matched: Array<{
                    recipient: MatrixGatewayTrustedDevice
                    identity: DurableMatrixBundleRecipient
                }> = []
                for (const stagedIdentity of delivery.recipients) {
                    const recipient = byId.get(stagedIdentity.recipientDeviceId)
                    if (!recipient) continue
                    const identity = await bundleRecipientIdentity(recipient)
                    if (sameBundleRecipientIdentities([stagedIdentity], [identity])) {
                        matched.push({ recipient, identity })
                    }
                }
                let recoveryDelivery = delivery
                if (matched.length !== delivery.recipients.length) {
                    await this.deliveryOutbox.markAbandoned(
                        delivery.deliveryId,
                        'recipient_identity_changed',
                    )
                    if (matched.length === 0) continue
                    recoveryDelivery = durableBundleDelivery(
                        delivery.logicalKey,
                        matched.map(entry => entry.identity),
                        delivery.request,
                        delivery.createdAt,
                    )
                    await this.deliveryOutbox.stageBundle(recoveryDelivery)
                }
                const result = await this.deliverBundleDurable(
                    recoveryDelivery,
                    room,
                    matched.map(entry => entry.recipient),
                    transport,
                    'recovery',
                )
                await this.recordRecoveredDelivery(delivery.logicalKey, result.eventId)
                continue
            }
            const { delivery } = pendingDelivery
            const recipient = byId.get(delivery.recipientDeviceId)!
            const identity = await recipientIdentity(recipient)
            if (!sameRecipientIdentity(delivery, identity)) {
                await this.deliveryOutbox.markAbandoned(
                    delivery.deliveryId,
                    'recipient_identity_changed',
                )
                continue
            }
            const result = await this.deliverDurable(
                delivery,
                room,
                recipient,
                transport,
                'recovery',
            )
            await this.recordRecoveredDelivery(delivery.logicalKey, result.eventId)
        }
    }

    private async recordRecoveredDelivery(logicalKey: string, eventId: string): Promise<void> {
        const logicalEventId = this.deliveryOutbox.logicalEventId(logicalKey)
        if (logicalEventId) {
            this.deliveryIds.set(
                logicalEventId,
                this.deliveryOutbox.recipientEvents(logicalKey),
            )
            return
        }
        await this.deliveryOutbox.recordLogicalEvent(logicalKey, eventId)
        this.deliveryIds.set(
            eventId,
            this.deliveryOutbox.recipientEvents(logicalKey),
        )
    }

    private async deliverBundleDurable(
        delivery: DurableMatrixBundleDelivery,
        room: MatrixGatewayRoomConfig,
        recipients: readonly MatrixGatewayTrustedDevice[],
        transport: MatrixTransport,
        priority: MatrixDeliveryPriority = 'normal',
    ): Promise<MatrixSendEventResult> {
        const deliveredEventId = this.deliveryOutbox.deliveredEventId(delivery.deliveryId)
        if (deliveredEventId) return { eventId: deliveredEventId }
        const inFlight = this.inFlightDeliveries.get(delivery.deliveryId)
        if (inFlight) return this.observeDeliveryAttempt(inFlight)

        const lateCompletion = (async () => {
            const result = await this.sealOutgoingBundle(
                delivery.request,
                room,
                recipients,
                transport,
                priority,
                bundleDeliveryCoalesceKey(delivery),
                async () => {
                    await this.deliveryOutbox.markAbandoned(
                        delivery.deliveryId,
                        'superseded',
                    )
                },
            )
            await this.deliveryOutbox.markDelivered(delivery.deliveryId, result.eventId)
            this.confirmDelivery(delivery.logicalKey, result.eventId)
            return result
        })()
        void lateCompletion.catch(async error => {
            if (error instanceof PermanentMatrixDeliveryError) {
                await this.deliveryOutbox.markFailed(
                    delivery.deliveryId,
                    formatError(error.deliveryCause),
                )
            }
        }).catch(() => undefined)
        this.inFlightDeliveries.set(delivery.deliveryId, lateCompletion)
        void lateCompletion.finally(() => {
            if (this.inFlightDeliveries.get(delivery.deliveryId) === lateCompletion) {
                this.inFlightDeliveries.delete(delivery.deliveryId)
            }
        }).catch(() => undefined)
        return this.observeDeliveryAttempt(lateCompletion)
    }

    private async deliverDurable(
        delivery: DurableMatrixDelivery,
        room: MatrixGatewayRoomConfig,
        recipient: MatrixGatewayTrustedDevice,
        transport: MatrixTransport,
        priority: MatrixDeliveryPriority = 'normal',
    ): Promise<MatrixSendEventResult> {
        const deliveredEventId = this.deliveryOutbox.deliveredEventId(delivery.deliveryId)
        if (deliveredEventId) return { eventId: deliveredEventId }
        const inFlight = this.inFlightDeliveries.get(delivery.deliveryId)
        if (inFlight) return this.observeDeliveryAttempt(inFlight)

        const lateCompletion = (async () => {
            const result = await this.sealOutgoing(
                delivery.request,
                room,
                recipient,
                transport,
                priority,
                replacementDeliveryCoalesceKey(delivery),
                async () => {
                    await this.deliveryOutbox.markAbandoned(
                        delivery.deliveryId,
                        'superseded',
                    )
                },
            )
            await this.deliveryOutbox.markDelivered(delivery.deliveryId, result.eventId)
            this.confirmDelivery(delivery.logicalKey, result.eventId)
            return result
        })()
        void lateCompletion.catch(async error => {
            if (error instanceof PermanentMatrixDeliveryError) {
                await this.deliveryOutbox.markFailed(
                    delivery.deliveryId,
                    formatError(error.deliveryCause),
                )
            }
        }).catch(() => undefined)
        this.inFlightDeliveries.set(delivery.deliveryId, lateCompletion)
        void lateCompletion.finally(() => {
            if (this.inFlightDeliveries.get(delivery.deliveryId) === lateCompletion) {
                this.inFlightDeliveries.delete(delivery.deliveryId)
            }
        }).catch(() => undefined)
        return this.observeDeliveryAttempt(lateCompletion)
    }

    private observeDeliveryAttempt(
        inFlight: Promise<MatrixSendEventResult>,
    ): Promise<MatrixSendEventResult> {
        return withDeliveryAttemptTimeout(
            inFlight,
            this.config.deliveryAttemptTimeoutMs ?? DEFAULT_DELIVERY_ATTEMPT_TIMEOUT_MS,
        )
    }

    private waitForDeliveryConfirmation(logicalKey: string): Promise<ChannelSendResult> {
        const deliveredEventId = this.deliveryOutbox.recipientEvents(logicalKey)
            .values()
            .next().value as string | undefined
        if (deliveredEventId) {
            this.clearConfirmationCandidate(logicalKey)
            return Promise.resolve({ messageId: deliveredEventId })
        }
        const confirmed = this.confirmedDeliveries.get(logicalKey)
        if (confirmed) {
            this.clearConfirmationCandidate(logicalKey)
            return Promise.resolve(confirmed)
        }
        const existing = this.deliveryConfirmations.get(logicalKey)
        if (existing) return existing.promise

        let resolve!: (result: ChannelSendResult) => void
        const promise = new Promise<ChannelSendResult>(accept => {
            resolve = accept
        })
        this.deliveryConfirmations.set(logicalKey, { promise, resolve })
        return promise
    }

    private confirmDelivery(logicalKey: string, eventId: string): void {
        const confirmation = this.deliveryConfirmations.get(logicalKey)
        const result = { messageId: eventId }
        if (confirmation) {
            this.deliveryConfirmations.delete(logicalKey)
            this.confirmationCandidates.delete(logicalKey)
            confirmation.resolve(result)
            return
        }
        if (this.confirmationCandidates.has(logicalKey)) {
            this.confirmedDeliveries.set(logicalKey, result)
        }
    }

    private clearConfirmationCandidate(logicalKey: string): void {
        this.confirmationCandidates.delete(logicalKey)
        this.confirmedDeliveries.delete(logicalKey)
    }

    private async sealOutgoingBundle(
        request: MatrixSendEventRequest,
        room: MatrixGatewayRoomConfig,
        recipients: readonly MatrixGatewayTrustedDevice[],
        transport: MatrixTransport,
        priority: MatrixDeliveryPriority = 'normal',
        coalesceKey?: string,
        onSuperseded?: () => Promise<void>,
    ): Promise<MatrixSendEventResult> {
        return this.sendScheduler.schedule(priority, async () => {
            let secureEnvelopeBundle: SignedSecureEnvelopeBundle
            try {
                const now = Date.now()
                const keys = this.requireGatewayKeys()
                const addressedRecipients = await Promise.all(recipients.map(async recipient => {
                    this.assertCertificateActive(recipient, now)
                    if (recipient.certificateExpiresAt === undefined) {
                        throw new Error(
                            `Trusted device ${recipient.deviceId} has no certificate expiry`,
                        )
                    }
                    return {
                        recipientDeviceId: recipient.deviceId,
                        recipientKeyId: await publicKeyId(recipient.publicKey),
                        recipientPublicKey: recipient.publicKey,
                        certificateExpiresAt: recipient.certificateExpiresAt,
                    }
                }))
                const expiresAt = Math.min(...addressedRecipients.map(
                    recipient => recipient.certificateExpiresAt,
                ))
                secureEnvelopeBundle = await sealSecureEnvelopeBundle({
                    plaintext: toJsonValue(request.content),
                    gatewayId: this.gatewayId,
                    conversationId: room.conversationId,
                    direction: 'gateway_to_device',
                    senderDeviceId: this.config.gatewayDeviceId,
                    senderKeyId: keys.keyId,
                    senderPrivateKey: keys.privateKey,
                    recipients: addressedRecipients.map(({ certificateExpiresAt: _, ...recipient }) =>
                        recipient,
                    ),
                    envelopeId: request.transactionId,
                    now,
                    lifetimeMs: Math.min(
                        expiresAt - now,
                        366 * 24 * 60 * 60_000,
                    ),
                })
            } catch (error) {
                throw new PermanentMatrixDeliveryError(error)
            }
            return transport.sendEncryptedRoomEvent({
                ...request,
                content: {
                    msgtype: 'm.notice',
                    body: 'Encrypted Codever message',
                    [CODEVER_MATRIX_EXTENSION]: {
                        version: CODEVER_MATRIX_PROTOCOL_VERSION,
                        kind: 'secure_envelope_bundle',
                        secure_envelope_bundle: secureEnvelopeBundle,
                    },
                },
            })
        }, {
            coalesceKey,
            onSuperseded,
            serializationKey: JSON.stringify([room.roomId, 'secure-envelope-bundle']),
        })
    }

    private async sealOutgoing(
        request: MatrixSendEventRequest,
        room: MatrixGatewayRoomConfig,
        recipient: MatrixGatewayTrustedDevice,
        transport: MatrixTransport,
        priority: MatrixDeliveryPriority = 'normal',
        coalesceKey?: string,
        onSuperseded?: () => Promise<void>,
    ): Promise<MatrixSendEventResult> {
        return this.sendScheduler.schedule(priority, async () => {
            let secureEnvelope: SignedSecureEnvelope
            try {
                const now = Date.now()
                this.assertCertificateActive(recipient, now)
                const keys = this.requireGatewayKeys()
                const certificateExpiresAt = recipient.certificateExpiresAt
                if (certificateExpiresAt === undefined) {
                    throw new Error(`Trusted device ${recipient.deviceId} has no certificate expiry`)
                }
                secureEnvelope = await sealSecureEnvelope({
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
            } catch (error) {
                throw new PermanentMatrixDeliveryError(error)
            }
            const content: MatrixRoomMessageContent = {
                msgtype: 'm.notice',
                body: 'Encrypted Codever message',
                [CODEVER_MATRIX_EXTENSION]: {
                    version: CODEVER_MATRIX_PROTOCOL_VERSION,
                    kind: 'secure_envelope',
                    secure_envelope: secureEnvelope,
                },
            }
            if (isApplicationControlRequest(request) && transport.sendApplicationControlEvent) {
                return transport.sendApplicationControlEvent({
                    roomId: request.roomId,
                    eventType: CODEVER_MATRIX_APPLICATION_CONTROL_EVENT_TYPE,
                    transactionId: request.transactionId,
                    content,
                })
            }
            return transport.sendEncryptedRoomEvent({
                ...request,
                content,
            })
        }, {
            coalesceKey,
            onSuperseded,
            serializationKey: JSON.stringify([room.roomId, recipient.deviceId]),
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

function gatewayStateExtension(state: GatewayStateSnapshot): Record<string, unknown> {
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
    return {
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
            ...(session.activityPhase ? { activity_phase: session.activityPhase } : {}),
            ...(session.archived ? { archived: true } : {}),
            project_id: session.projectId,
            project_name: session.projectName,
            cwd: session.cwd,
            provider: session.provider,
            ...(session.model ? { model: session.model } : {}),
            ...(session.reasoningEffort
                ? { reasoning_effort: session.reasoningEffort }
                : {}),
            extensions: session.extensions.map(extension => ({
                id: extension.id,
                name: extension.name,
                version: extension.version,
            })),
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
            can_archive_session: state.capabilities.canArchiveSession ?? false,
            can_delete_session: state.capabilities.canDeleteSession ?? false,
            session_extensions: state.capabilities.sessionExtensions.map(extension => ({
                id: extension.id,
                name: extension.name,
                description: extension.description,
                version: extension.version,
                settings: extension.settings.map(setting => ({
                    id: setting.id,
                    type: setting.type,
                    label: setting.label,
                    ...(setting.description ? { description: setting.description } : {}),
                    ...('required' in setting && setting.required ? { required: true } : {}),
                    ...('placeholder' in setting && setting.placeholder
                        ? { placeholder: setting.placeholder }
                        : {}),
                    ...('defaultValue' in setting && setting.defaultValue !== undefined
                        ? { default_value: setting.defaultValue }
                        : {}),
                })),
            })),
        },
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

function commandDeliveryTransactionId(
    kind: 'ack' | 'conflict' | 'result',
    commandId: string,
    outcome?: 'succeeded' | 'failed',
): string {
    const semanticIdentity = outcome
        ? `codever.command.${kind}.${commandId}.${outcome}`
        : `codever.command.${kind}.${commandId}`
    // A command ID identifies the idempotent application operation. Matrix
    // transaction IDs instead identify one physical delivery generation: a
    // duplicate command must be able to emit a fresh timeline event when the
    // original recipient copy was not consumed. Retries inside that generation
    // remain stable because the resulting request is persisted in the WAL.
    return `${semanticIdentity}.${randomUUID()}`
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

function durableBundleDelivery(
    logicalKey: string,
    recipients: readonly DurableMatrixBundleRecipient[],
    request: MatrixSendEventRequest,
    createdAt: number,
): DurableMatrixBundleDelivery {
    const identities = [...recipients]
        .map(recipient => ({ ...recipient }))
        .sort((left, right) => left.recipientDeviceId.localeCompare(right.recipientDeviceId))
    const deliveryId = createHash('sha256')
        .update('codever-matrix-delivery-bundle:v2\0')
        .update(logicalKey)
        .update('\0')
        .update(JSON.stringify(identities))
        .digest('hex')
    return {
        deliveryId,
        logicalKey,
        recipients: identities,
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

async function bundleRecipientIdentity(
    recipient: MatrixGatewayTrustedDevice,
): Promise<DurableMatrixBundleRecipient> {
    return {
        recipientDeviceId: recipient.deviceId,
        ...await recipientIdentity(recipient),
    }
}

function sameRecipientIdentity(
    delivery: Pick<DurableMatrixDelivery, 'recipientSequenceEpoch' | 'recipientPublicKeyId'>,
    identity: RecipientIdentity,
): boolean {
    return delivery.recipientSequenceEpoch === identity.recipientSequenceEpoch
        && delivery.recipientPublicKeyId === identity.recipientPublicKeyId
}

function sameBundleRecipientIdentities(
    left: readonly DurableMatrixBundleRecipient[],
    right: readonly DurableMatrixBundleRecipient[],
): boolean {
    if (left.length !== right.length) return false
    const byDeviceId = new Map(right.map(recipient => [recipient.recipientDeviceId, recipient]))
    return left.every(recipient => {
        const candidate = byDeviceId.get(recipient.recipientDeviceId)
        return candidate !== undefined
            && candidate.recipientSequenceEpoch === recipient.recipientSequenceEpoch
            && candidate.recipientPublicKeyId === recipient.recipientPublicKeyId
    })
}

function deliveryBelongsToCommand(
    delivery: Pick<DurableMatrixDelivery, 'request'>,
    commandId: string,
): boolean {
    const transactionId = delivery.request.transactionId
    return (
        transactionId.startsWith('codever.collaboration.')
        && (
            transactionId.includes(`.${commandId}.`)
            || transactionId.endsWith(`.${commandId}`)
        )
    ) || [
        'ack',
        'conflict',
        'result',
    ].some(kind => transactionId.startsWith(`codever.command.${kind}.${commandId}.`))
}

function bundleDeliveryCoalesceKey(
    delivery: DurableMatrixBundleDelivery,
): string | undefined {
    const target = replacementTargetId(delivery.request.content)
    if (target) {
        return JSON.stringify([
            'replacement_bundle',
            delivery.request.roomId,
            target,
        ])
    }
    const extension = matrixContentExtension(delivery.request.content)
    if (extension?.kind === 'gateway_state') {
        return JSON.stringify([
            'gateway_state_bundle',
            delivery.request.roomId,
        ])
    }
    if (extension?.kind === 'status') {
        return JSON.stringify([
            'status_bundle',
            delivery.request.roomId,
            extension.session_id ?? null,
        ])
    }
    return undefined
}

function replacementTargetId(content: Record<string, unknown>): string | undefined {
    const relation = asRecord(content['m.relates_to'])
    return relation?.rel_type === 'm.replace' && typeof relation.event_id === 'string'
        ? relation.event_id
        : undefined
}

function replacementDeliveryCoalesceKey(
    delivery: DurableMatrixDelivery,
): string | undefined {
    const target = replacementTargetId(delivery.request.content)
    if (target) {
        return JSON.stringify([
            'replacement',
            delivery.request.roomId,
            delivery.recipientDeviceId,
            target,
        ])
    }
    const extension = matrixContentExtension(delivery.request.content)
    if (extension?.kind === 'gateway_state') {
        return JSON.stringify([
            'gateway_state',
            delivery.request.roomId,
            delivery.recipientDeviceId,
        ])
    }
    if (extension?.kind === 'status') {
        return JSON.stringify([
            'status',
            delivery.request.roomId,
            delivery.recipientDeviceId,
            extension.session_id ?? null,
        ])
    }
    return undefined
}

function matrixContentExtension(
    content: Record<string, unknown>,
): Record<string, unknown> | null {
    const replacement = asRecord(content['m.new_content'])
    return asRecord(replacement?.[CODEVER_MATRIX_EXTENSION])
        ?? asRecord(content[CODEVER_MATRIX_EXTENSION])
}

function matrixDeliveryPriority(request: MatrixSendEventRequest): MatrixDeliveryPriority {
    const kind = matrixContentExtension(request.content)?.kind
    return kind === 'decision_request' ? 'control' : 'normal'
}

function isApplicationControlRequest(request: MatrixSendEventRequest): boolean {
    const kind = matrixContentExtension(request.content)?.kind
    return kind === 'command_ack'
        || kind === 'command_result'
        || kind === 'revision_conflict'
        || kind === 'gateway_state'
        || kind === 'history_page'
}

function isCoalescibleSnapshot(request: MatrixSendEventRequest): boolean {
    const kind = matrixContentExtension(request.content)?.kind
    return kind === 'gateway_state' || kind === 'status'
}

function supersededEventId(logicalKey: string): string {
    return `$codever-superseded-${createHash('sha256').update(logicalKey).digest('hex')}`
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

function withLogicalDeliveryIdentity(
    content: MatrixRoomMessageContent,
    logicalEventId: string,
    replacesLogicalEventId: string | undefined,
): MatrixRoomMessageContent {
    const copy = structuredClone(content)
    for (const extension of [
        asRecord(copy[CODEVER_MATRIX_EXTENSION]),
        asRecord(asRecord(copy['m.new_content'])?.[CODEVER_MATRIX_EXTENSION]),
    ]) {
        if (!extension) continue
        extension.logical_event_id = logicalEventId
        if (replacesLogicalEventId) {
            extension.replaces_logical_event_id = replacesLogicalEventId
        }
    }
    return copy
}

function stableLogicalEventId(logicalKey: string): string {
    return createHash('sha256')
        .update('codever-matrix-history:v1\0')
        .update(logicalKey)
        .digest('base64url')
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

class PermanentMatrixDeliveryError extends Error {
    constructor(readonly deliveryCause: unknown) {
        super(formatError(deliveryCause))
        this.name = 'PermanentMatrixDeliveryError'
    }
}

class MatrixDeliveryAttemptTimeoutError extends Error {
    constructor(timeoutMs: number) {
        super(`Matrix delivery attempt timed out after ${timeoutMs}ms`)
        this.name = 'MatrixDeliveryAttemptTimeoutError'
    }
}

class SupersededMatrixDeliveryError extends PermanentMatrixDeliveryError {
    constructor() {
        super(new Error('Matrix delivery was superseded before reaching the transport'))
        this.name = 'SupersededMatrixDeliveryError'
    }
}

interface MatrixSendTask {
    priority: MatrixDeliveryPriority
    run: () => Promise<MatrixSendEventResult>
    resolve: (result: MatrixSendEventResult) => void
    reject: (error: unknown) => void
    coalesceKey?: string
    serializationKey?: string
    onSuperseded?: () => Promise<void>
}

/**
 * Bounds the number of requests admitted to matrix-js-sdk. Control traffic has
 * a reserved lane, while normal broadcasts and startup recovery share a bounded
 * pool. This means a hung normal send cannot trap command acknowledgements or
 * history pages behind an SDK-sized FIFO.
 */
class MatrixSendScheduler {
    private readonly control: MatrixSendTask[] = []
    private readonly normal: MatrixSendTask[] = []
    private readonly recovery: MatrixSendTask[] = []
    private activeControl = 0
    private activeBulk = 0
    private activeRecovery = 0
    private readonly activeBulkKeys = new Set<string>()
    private drainScheduled = false

    schedule(
        priority: MatrixDeliveryPriority,
        run: () => Promise<MatrixSendEventResult>,
        options: {
            coalesceKey?: string
            serializationKey?: string
            onSuperseded?: () => Promise<void>
        } = {},
    ): Promise<MatrixSendEventResult> {
        return new Promise<MatrixSendEventResult>((resolve, reject) => {
            const superseded = options.coalesceKey
                ? this.supersedeQueued(options.coalesceKey)
                : Promise.resolve()
            const task: MatrixSendTask = {
                priority,
                run: async () => {
                    await superseded
                    return run()
                },
                resolve,
                reject,
                ...(options.coalesceKey ? { coalesceKey: options.coalesceKey } : {}),
                ...(options.serializationKey
                    ? { serializationKey: options.serializationKey }
                    : {}),
                ...(options.onSuperseded ? { onSuperseded: options.onSuperseded } : {}),
            }
            this.queue(priority).push(task)
            this.scheduleDrain()
        })
    }

    private queue(priority: MatrixDeliveryPriority): MatrixSendTask[] {
        if (priority === 'control') return this.control
        if (priority === 'recovery') return this.recovery
        return this.normal
    }

    private supersedeQueued(coalesceKey: string): Promise<void> {
        for (const queue of [this.normal, this.recovery]) {
            const index = queue.findIndex(task => task.coalesceKey === coalesceKey)
            if (index < 0) continue
            const [superseded] = queue.splice(index, 1)
            if (!superseded) return Promise.resolve()
            return Promise.resolve()
                .then(() => superseded.onSuperseded?.())
                .then(() => {
                    superseded.reject(new SupersededMatrixDeliveryError())
                })
                .catch(error => {
                    superseded.reject(error)
                    throw error
                })
        }
        return Promise.resolve()
    }

    private scheduleDrain(): void {
        if (this.drainScheduled) return
        this.drainScheduled = true
        queueMicrotask(() => {
            this.drainScheduled = false
            this.drain()
        })
    }

    private drain(): void {
        if (this.activeControl === 0) {
            const task = this.control.shift()
            if (task) this.start(task, 'control')
        }
        while (this.activeBulk < MAX_MATRIX_NORMAL_IN_FLIGHT) {
            const task = this.takeRunnableBulkTask()
            if (!task) break
            this.start(task, 'bulk')
        }
    }

    private takeRunnableBulkTask(): MatrixSendTask | undefined {
        const normalIndex = this.normal.findIndex(task =>
            !task.serializationKey || !this.activeBulkKeys.has(task.serializationKey),
        )
        if (normalIndex >= 0) return this.normal.splice(normalIndex, 1)[0]
        if (this.activeRecovery > 0) return undefined
        const recoveryIndex = this.recovery.findIndex(task =>
            !task.serializationKey || !this.activeBulkKeys.has(task.serializationKey),
        )
        if (recoveryIndex >= 0) return this.recovery.splice(recoveryIndex, 1)[0]
        return undefined
    }

    private start(task: MatrixSendTask, lane: 'control' | 'bulk'): void {
        if (lane === 'control') this.activeControl += 1
        else {
            this.activeBulk += 1
            if (task.priority === 'recovery') this.activeRecovery += 1
            if (task.serializationKey) this.activeBulkKeys.add(task.serializationKey)
        }
        void Promise.resolve()
            .then(task.run)
            .then(task.resolve, task.reject)
            .finally(() => {
                if (lane === 'control') this.activeControl -= 1
                else {
                    this.activeBulk -= 1
                    if (task.priority === 'recovery') this.activeRecovery -= 1
                    if (task.serializationKey) this.activeBulkKeys.delete(task.serializationKey)
                }
                this.scheduleDrain()
            })
    }
}

function withDeliveryAttemptTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(
            () => reject(new MatrixDeliveryAttemptTimeoutError(timeoutMs)),
            timeoutMs,
        )
    })
    return Promise.race([promise, deadline]).finally(() => {
        if (timeout) clearTimeout(timeout)
    })
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
