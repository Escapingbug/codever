import { mkdir, open, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import type { MatrixSendEventRequest } from '@/channel/matrix'

interface PendingEntry {
    version: 1
    kind: 'pending'
    deliveryId: string
    logicalKey: string
    recipientDeviceId: string
    recipientSequenceEpoch: string
    recipientPublicKeyId: string
    request: MatrixSendEventRequest
    createdAt: number
}

interface PendingBundleEntry {
    version: 2
    kind: 'pending_bundle'
    deliveryId: string
    logicalKey: string
    recipients: DurableMatrixBundleRecipient[]
    request: MatrixSendEventRequest
    createdAt: number
}

interface DeliveredEntry {
    version: 1
    kind: 'delivered'
    deliveryId: string
    eventId: string
    deliveredAt: number
}

interface LogicalEventEntry {
    version: 1
    kind: 'logical_event'
    logicalKey: string
    eventId: string
    recordedAt: number
}

interface AbandonedEntry {
    version: 1
    kind: 'abandoned'
    deliveryId: string
    reason: 'recipient_identity_changed' | 'superseded'
    abandonedAt: number
}

interface FailedEntry {
    version: 1
    kind: 'failed'
    deliveryId: string
    error: string
    failedAt: number
}

type DeliveryEntry =
    | PendingEntry
    | PendingBundleEntry
    | DeliveredEntry
    | LogicalEventEntry
    | AbandonedEntry
    | FailedEntry

export interface DurableMatrixDelivery {
    deliveryId: string
    logicalKey: string
    recipientDeviceId: string
    recipientSequenceEpoch: string
    recipientPublicKeyId: string
    request: MatrixSendEventRequest
    createdAt: number
}

export interface DurableMatrixBundleRecipient {
    recipientDeviceId: string
    recipientSequenceEpoch: string
    recipientPublicKeyId: string
}

export interface DurableMatrixBundleDelivery {
    deliveryId: string
    logicalKey: string
    recipients: DurableMatrixBundleRecipient[]
    request: MatrixSendEventRequest
    createdAt: number
}

/**
 * Append-only Matrix delivery ledger for targeted recipient copies and shared
 * multi-recipient bundles.
 *
 * A pending record is fsynced through the filesystem API before the network
 * attempt starts. Completion records retain the physical Matrix event ID, so
 * stable transaction retries and logical edit mappings survive a
 * restart.
 */
export class FileMatrixDeliveryOutbox {
    private readonly deliveries = new Map<string, DurableMatrixDelivery>()
    private readonly bundleDeliveries = new Map<string, DurableMatrixBundleDelivery>()
    private readonly logicalBundleDeliveries = new Map<string, DurableMatrixBundleDelivery>()
    private readonly recipientDeliveries = new Map<string, DurableMatrixDelivery>()
    private readonly pending = new Map<string, DurableMatrixDelivery>()
    private readonly pendingBundles = new Map<string, DurableMatrixBundleDelivery>()
    private readonly delivered = new Map<string, string>()
    private readonly abandoned = new Set<string>()
    private readonly failed = new Set<string>()
    private readonly logicalEvents = new Map<string, string>()
    private readonly eventLogicalKeys = new Map<string, string>()
    private writeChain: Promise<void> = Promise.resolve()
    private readonly transitionChains = new Map<string, Promise<void>>()

    constructor(private readonly path: string) {}

    async initialize(): Promise<void> {
        let bytes: Buffer
        try {
            bytes = await readFile(this.path)
        } catch (error) {
            if (isMissingFile(error)) return
            throw error
        }
        if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
            const lastNewline = bytes.lastIndexOf(0x0a)
            const validLength = lastNewline < 0 ? 0 : lastNewline + 1
            await truncateAndSync(this.path, validLength)
            bytes = bytes.subarray(0, validLength)
        }
        const content = bytes.toString('utf8')
        for (const [index, line] of content.split(/\r?\n/u).entries()) {
            if (!line.trim()) continue
            let entry: DeliveryEntry
            try {
                entry = validateEntry(JSON.parse(line))
            } catch (error) {
                throw new Error(
                    `Invalid Matrix delivery outbox record at line ${index + 1}: ${formatError(error)}`,
                )
            }
            if (entry.kind === 'pending') {
                this.deliveries.set(entry.deliveryId, entry)
                const recipientKey = recipientDeliveryKey(
                    entry.logicalKey,
                    entry.recipientDeviceId,
                )
                if (!this.recipientDeliveries.has(recipientKey)) {
                    this.recipientDeliveries.set(recipientKey, entry)
                }
                if (
                    !this.delivered.has(entry.deliveryId)
                    && !this.abandoned.has(entry.deliveryId)
                    && !this.failed.has(entry.deliveryId)
                ) {
                    this.pending.set(entry.deliveryId, entry)
                }
            } else if (entry.kind === 'pending_bundle') {
                this.bundleDeliveries.set(entry.deliveryId, entry)
                this.logicalBundleDeliveries.set(entry.logicalKey, entry)
                if (
                    !this.delivered.has(entry.deliveryId)
                    && !this.abandoned.has(entry.deliveryId)
                    && !this.failed.has(entry.deliveryId)
                ) {
                    this.pendingBundles.set(entry.deliveryId, entry)
                }
            } else if (entry.kind === 'delivered') {
                this.pending.delete(entry.deliveryId)
                this.pendingBundles.delete(entry.deliveryId)
                this.delivered.set(entry.deliveryId, entry.eventId)
                const delivery = this.deliveries.get(entry.deliveryId)
                    ?? this.bundleDeliveries.get(entry.deliveryId)
                if (delivery) this.eventLogicalKeys.set(entry.eventId, delivery.logicalKey)
            } else if (entry.kind === 'logical_event') {
                this.logicalEvents.set(entry.logicalKey, entry.eventId)
                this.eventLogicalKeys.set(entry.eventId, entry.logicalKey)
            } else if (entry.kind === 'abandoned') {
                this.pending.delete(entry.deliveryId)
                this.pendingBundles.delete(entry.deliveryId)
                this.abandoned.add(entry.deliveryId)
            } else {
                this.pending.delete(entry.deliveryId)
                this.pendingBundles.delete(entry.deliveryId)
                this.failed.add(entry.deliveryId)
            }
        }
    }

    async stage(delivery: DurableMatrixDelivery): Promise<void> {
        await this.serializeTransition(`delivery:${delivery.deliveryId}`, async () => {
            if (
                this.pending.has(delivery.deliveryId)
                || this.delivered.has(delivery.deliveryId)
                || this.abandoned.has(delivery.deliveryId)
                || this.failed.has(delivery.deliveryId)
            ) return
            const entry: PendingEntry = {
                version: 1,
                kind: 'pending',
                ...delivery,
            }
            await this.append(entry)
            this.deliveries.set(delivery.deliveryId, delivery)
            const recipientKey = recipientDeliveryKey(
                delivery.logicalKey,
                delivery.recipientDeviceId,
            )
            if (!this.recipientDeliveries.has(recipientKey)) {
                this.recipientDeliveries.set(recipientKey, delivery)
            }
            this.pending.set(delivery.deliveryId, delivery)
        })
    }

    async stageBundle(delivery: DurableMatrixBundleDelivery): Promise<void> {
        await this.serializeTransition(`delivery:${delivery.deliveryId}`, async () => {
            if (
                this.pendingBundles.has(delivery.deliveryId)
                || this.delivered.has(delivery.deliveryId)
                || this.abandoned.has(delivery.deliveryId)
                || this.failed.has(delivery.deliveryId)
            ) return
            const entry: PendingBundleEntry = {
                version: 2,
                kind: 'pending_bundle',
                ...delivery,
            }
            await this.append(entry)
            this.bundleDeliveries.set(delivery.deliveryId, delivery)
            this.logicalBundleDeliveries.set(delivery.logicalKey, delivery)
            this.pendingBundles.set(delivery.deliveryId, delivery)
        })
    }

    async markDelivered(deliveryId: string, eventId: string, deliveredAt = Date.now()): Promise<void> {
        await this.serializeTransition(`delivery:${deliveryId}`, async () => {
            if (
                this.delivered.has(deliveryId)
                || this.abandoned.has(deliveryId)
                || this.failed.has(deliveryId)
            ) return
            await this.append({
                version: 1,
                kind: 'delivered',
                deliveryId,
                eventId,
                deliveredAt,
            })
            this.pending.delete(deliveryId)
            this.pendingBundles.delete(deliveryId)
            this.delivered.set(deliveryId, eventId)
            const delivery = this.deliveries.get(deliveryId)
                ?? this.bundleDeliveries.get(deliveryId)
            if (delivery) this.eventLogicalKeys.set(eventId, delivery.logicalKey)
        })
    }

    async markAbandoned(
        deliveryId: string,
        reason: AbandonedEntry['reason'],
        abandonedAt = Date.now(),
    ): Promise<void> {
        await this.serializeTransition(`delivery:${deliveryId}`, async () => {
            if (
                this.delivered.has(deliveryId)
                || this.abandoned.has(deliveryId)
                || this.failed.has(deliveryId)
            ) return
            await this.append({
                version: 1,
                kind: 'abandoned',
                deliveryId,
                reason,
                abandonedAt,
            })
            this.pending.delete(deliveryId)
            this.pendingBundles.delete(deliveryId)
            this.abandoned.add(deliveryId)
        })
    }

    async markFailed(deliveryId: string, error: string, failedAt = Date.now()): Promise<void> {
        await this.serializeTransition(`delivery:${deliveryId}`, async () => {
            if (
                this.delivered.has(deliveryId)
                || this.abandoned.has(deliveryId)
                || this.failed.has(deliveryId)
            ) return
            await this.append({
                version: 1,
                kind: 'failed',
                deliveryId,
                error,
                failedAt,
            })
            this.pending.delete(deliveryId)
            this.pendingBundles.delete(deliveryId)
            this.failed.add(deliveryId)
        })
    }

    async recordLogicalEvent(logicalKey: string, eventId: string, recordedAt = Date.now()): Promise<void> {
        await this.serializeTransition(`logical:${logicalKey}`, async () => {
            if (this.logicalEvents.has(logicalKey)) return
            await this.append({
                version: 1,
                kind: 'logical_event',
                logicalKey,
                eventId,
                recordedAt,
            })
            this.logicalEvents.set(logicalKey, eventId)
            this.eventLogicalKeys.set(eventId, logicalKey)
        })
    }

    listPending(roomId?: string): DurableMatrixDelivery[] {
        return [...this.pending.values()]
            .filter(delivery => roomId === undefined || delivery.request.roomId === roomId)
    }

    listPendingBundles(roomId?: string): DurableMatrixBundleDelivery[] {
        return [...this.pendingBundles.values()]
            .filter(delivery => roomId === undefined || delivery.request.roomId === roomId)
    }

    deliveredEventId(deliveryId: string): string | undefined {
        return this.delivered.get(deliveryId)
    }

    recipientIdentity(
        logicalKey: string,
        recipientDeviceId: string,
    ): Pick<DurableMatrixDelivery, 'recipientSequenceEpoch' | 'recipientPublicKeyId'> | undefined {
        const delivery = this.recipientDeliveries.get(
            recipientDeliveryKey(logicalKey, recipientDeviceId),
        )
        return delivery && {
            recipientSequenceEpoch: delivery.recipientSequenceEpoch,
            recipientPublicKeyId: delivery.recipientPublicKeyId,
        }
    }

    recipientDelivery(
        logicalKey: string,
        recipientDeviceId: string,
    ): DurableMatrixDelivery | undefined {
        return this.recipientDeliveries.get(
            recipientDeliveryKey(logicalKey, recipientDeviceId),
        )
    }

    bundleDelivery(logicalKey: string): DurableMatrixBundleDelivery | undefined {
        return this.logicalBundleDeliveries.get(logicalKey)
    }

    logicalEventId(logicalKey: string): string | undefined {
        return this.logicalEvents.get(logicalKey)
    }

    stableLogicalEventIdForEvent(eventId: string): string | undefined {
        const logicalKey = this.eventLogicalKeys.get(eventId)
        return logicalKey ? stableLogicalEventId(logicalKey) : undefined
    }

    logicalEventMappings(): Array<{
        logicalKey: string
        eventId: string
        recipientEvents: Map<string, string>
    }> {
        return [...this.logicalEvents].map(([logicalKey, eventId]) => ({
            logicalKey,
            eventId,
            recipientEvents: this.recipientEvents(logicalKey),
        }))
    }

    recipientEvents(logicalKey: string): Map<string, string> {
        const result = new Map<string, string>()
        for (const delivery of this.deliveries.values()) {
            if (delivery.logicalKey !== logicalKey) continue
            const eventId = this.delivered.get(delivery.deliveryId)
            if (eventId) result.set(delivery.recipientDeviceId, eventId)
        }
        for (const delivery of this.bundleDeliveries.values()) {
            if (delivery.logicalKey !== logicalKey) continue
            const eventId = this.delivered.get(delivery.deliveryId)
            if (!eventId) continue
            for (const recipient of delivery.recipients) {
                result.set(recipient.recipientDeviceId, eventId)
            }
        }
        return result
    }

    private async append(entry: DeliveryEntry): Promise<void> {
        const line = `${JSON.stringify(entry)}\n`
        this.writeChain = this.writeChain.then(async () => {
            await mkdir(dirname(this.path), { recursive: true })
            const handle = await open(this.path, 'a')
            try {
                await handle.writeFile(line, 'utf8')
                await handle.sync()
            } finally {
                await handle.close()
            }
        })
        return this.writeChain
    }

    private async serializeTransition(key: string, transition: () => Promise<void>): Promise<void> {
        const previous = this.transitionChains.get(key) ?? Promise.resolve()
        const current = previous.catch(() => undefined).then(transition)
        this.transitionChains.set(key, current)
        try {
            await current
        } finally {
            if (this.transitionChains.get(key) === current) {
                this.transitionChains.delete(key)
            }
        }
    }
}

function stableLogicalEventId(logicalKey: string): string {
    return createHash('sha256')
        .update('codever-matrix-timeline:v2\0')
        .update(logicalKey)
        .digest('base64url')
}

function recipientDeliveryKey(logicalKey: string, recipientDeviceId: string): string {
    return JSON.stringify([logicalKey, recipientDeviceId])
}

function validateEntry(value: unknown): DeliveryEntry {
    const entry = asRecord(value)
    if (
        !entry
        || typeof entry.kind !== 'string'
        || (entry.version !== 1 && entry.version !== 2)
    ) {
        throw new TypeError('unsupported record')
    }
    if (entry.kind === 'pending') {
        if (entry.version !== 1) throw new TypeError('unsupported pending record version')
        const request = asRecord(entry.request)
        if (
            typeof entry.deliveryId !== 'string'
            || typeof entry.logicalKey !== 'string'
            || typeof entry.recipientDeviceId !== 'string'
            || typeof entry.recipientSequenceEpoch !== 'string'
            || typeof entry.recipientPublicKeyId !== 'string'
            || typeof entry.createdAt !== 'number'
            || typeof request?.roomId !== 'string'
            || request.eventType !== 'm.room.message'
            || typeof request.transactionId !== 'string'
            || !asRecord(request.content)
        ) {
            throw new TypeError('invalid pending record')
        }
        return entry as unknown as PendingEntry
    }
    if (entry.kind === 'pending_bundle') {
        if (entry.version !== 2) throw new TypeError('unsupported pending bundle record version')
        const request = asRecord(entry.request)
        if (
            typeof entry.deliveryId !== 'string'
            || typeof entry.logicalKey !== 'string'
            || !Array.isArray(entry.recipients)
            || entry.recipients.length === 0
            || entry.recipients.length > 256
            || typeof entry.createdAt !== 'number'
            || typeof request?.roomId !== 'string'
            || request.eventType !== 'm.room.message'
            || typeof request.transactionId !== 'string'
            || !asRecord(request.content)
        ) {
            throw new TypeError('invalid pending bundle record')
        }
        const deviceIds = new Set<string>()
        for (const value of entry.recipients) {
            const recipient = asRecord(value)
            if (
                typeof recipient?.recipientDeviceId !== 'string'
                || typeof recipient.recipientSequenceEpoch !== 'string'
                || typeof recipient.recipientPublicKeyId !== 'string'
                || deviceIds.has(recipient.recipientDeviceId)
            ) {
                throw new TypeError('invalid pending bundle recipient')
            }
            deviceIds.add(recipient.recipientDeviceId)
        }
        return entry as unknown as PendingBundleEntry
    }
    if (entry.version !== 1) throw new TypeError('unsupported transition record version')
    if (entry.kind === 'delivered') {
        if (
            typeof entry.deliveryId !== 'string'
            || typeof entry.eventId !== 'string'
            || typeof entry.deliveredAt !== 'number'
        ) {
            throw new TypeError('invalid delivered record')
        }
        return entry as unknown as DeliveredEntry
    }
    if (entry.kind === 'logical_event') {
        if (
            typeof entry.logicalKey !== 'string'
            || typeof entry.eventId !== 'string'
            || typeof entry.recordedAt !== 'number'
        ) {
            throw new TypeError('invalid logical event record')
        }
        return entry as unknown as LogicalEventEntry
    }
    if (entry.kind === 'abandoned') {
        if (
            typeof entry.deliveryId !== 'string'
            || (
                entry.reason !== 'recipient_identity_changed'
                && entry.reason !== 'superseded'
            )
            || typeof entry.abandonedAt !== 'number'
        ) {
            throw new TypeError('invalid abandoned record')
        }
        return entry as unknown as AbandonedEntry
    }
    if (entry.kind === 'failed') {
        if (
            typeof entry.deliveryId !== 'string'
            || typeof entry.error !== 'string'
            || typeof entry.failedAt !== 'number'
        ) {
            throw new TypeError('invalid failed record')
        }
        return entry as unknown as FailedEntry
    }
    throw new TypeError('unknown record kind')
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function isMissingFile(error: unknown): boolean {
    return asRecord(error)?.code === 'ENOENT'
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

async function truncateAndSync(path: string, length: number): Promise<void> {
    const handle = await open(path, 'r+')
    try {
        await handle.truncate(length)
        await handle.sync()
    } finally {
        await handle.close()
    }
}
