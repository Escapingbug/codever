import { mkdir, open, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import type { MatrixRoomMessageContent, MatrixSendEventRequest } from '@/channel/matrix'

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
    reason: 'recipient_identity_changed'
    abandonedAt: number
}

type DeliveryEntry = PendingEntry | DeliveredEntry | LogicalEventEntry | AbandonedEntry

export interface DurableMatrixDelivery {
    deliveryId: string
    logicalKey: string
    recipientDeviceId: string
    recipientSequenceEpoch: string
    recipientPublicKeyId: string
    request: MatrixSendEventRequest
    createdAt: number
}

export interface MatrixHistoryDelivery {
    logicalKey: string
    cursor: string
    createdAt: number
    content: MatrixRoomMessageContent
    replacementLogicalKey?: string
}

export interface MatrixHistoryDeliveryPage {
    deliveries: MatrixHistoryDelivery[]
    nextBefore?: string
    hasMore: boolean
}

/**
 * Append-only per-recipient Matrix delivery ledger.
 *
 * A pending record is fsynced through the filesystem API before the network
 * attempt starts. Completion records retain the physical Matrix event ID, so
 * stable transaction retries and per-device edit targets survive a restart.
 */
export class FileMatrixDeliveryOutbox {
    private readonly deliveries = new Map<string, DurableMatrixDelivery>()
    private readonly pending = new Map<string, DurableMatrixDelivery>()
    private readonly delivered = new Map<string, string>()
    private readonly abandoned = new Set<string>()
    private readonly logicalEvents = new Map<string, string>()
    private writeChain: Promise<void> = Promise.resolve()

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
                if (!this.delivered.has(entry.deliveryId) && !this.abandoned.has(entry.deliveryId)) {
                    this.pending.set(entry.deliveryId, entry)
                }
            } else if (entry.kind === 'delivered') {
                this.pending.delete(entry.deliveryId)
                this.delivered.set(entry.deliveryId, entry.eventId)
            } else if (entry.kind === 'logical_event') {
                this.logicalEvents.set(entry.logicalKey, entry.eventId)
            } else {
                this.pending.delete(entry.deliveryId)
                this.abandoned.add(entry.deliveryId)
            }
        }
    }

    async stage(delivery: DurableMatrixDelivery): Promise<void> {
        if (
            this.pending.has(delivery.deliveryId)
            || this.delivered.has(delivery.deliveryId)
            || this.abandoned.has(delivery.deliveryId)
        ) return
        const entry: PendingEntry = {
            version: 1,
            kind: 'pending',
            ...delivery,
        }
        await this.append(entry)
        this.deliveries.set(delivery.deliveryId, delivery)
        this.pending.set(delivery.deliveryId, delivery)
    }

    async markDelivered(deliveryId: string, eventId: string, deliveredAt = Date.now()): Promise<void> {
        if (this.delivered.has(deliveryId) || this.abandoned.has(deliveryId)) return
        await this.append({
            version: 1,
            kind: 'delivered',
            deliveryId,
            eventId,
            deliveredAt,
        })
        this.pending.delete(deliveryId)
        this.delivered.set(deliveryId, eventId)
    }

    async markAbandoned(
        deliveryId: string,
        reason: AbandonedEntry['reason'],
        abandonedAt = Date.now(),
    ): Promise<void> {
        if (this.delivered.has(deliveryId) || this.abandoned.has(deliveryId)) return
        await this.append({
            version: 1,
            kind: 'abandoned',
            deliveryId,
            reason,
            abandonedAt,
        })
        this.pending.delete(deliveryId)
        this.abandoned.add(deliveryId)
    }

    async recordLogicalEvent(logicalKey: string, eventId: string, recordedAt = Date.now()): Promise<void> {
        if (this.logicalEvents.has(logicalKey)) return
        await this.append({
            version: 1,
            kind: 'logical_event',
            logicalKey,
            eventId,
            recordedAt,
        })
        this.logicalEvents.set(logicalKey, eventId)
    }

    listPending(roomId?: string): DurableMatrixDelivery[] {
        return [...this.pending.values()]
            .filter(delivery => roomId === undefined || delivery.request.roomId === roomId)
    }

    deliveredEventId(deliveryId: string): string | undefined {
        return this.delivered.get(deliveryId)
    }

    recipientIdentity(
        logicalKey: string,
        recipientDeviceId: string,
    ): Pick<DurableMatrixDelivery, 'recipientSequenceEpoch' | 'recipientPublicKeyId'> | undefined {
        const delivery = [...this.deliveries.values()].find(candidate =>
            candidate.logicalKey === logicalKey
            && candidate.recipientDeviceId === recipientDeviceId,
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
        return [...this.deliveries.values()].find(candidate =>
            candidate.logicalKey === logicalKey
            && candidate.recipientDeviceId === recipientDeviceId,
        )
    }

    logicalEventId(logicalKey: string): string | undefined {
        return this.logicalEvents.get(logicalKey)
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
        return result
    }

    /**
     * Returns one canonical copy per logical Codever event. Recipient-specific
     * ciphertext and Matrix event IDs are deliberately not part of this view;
     * callers re-address every entry to the requesting application device.
     */
    historyPage(
        roomId: string,
        sessionId: string,
        before: string | undefined,
        limit: number,
    ): MatrixHistoryDeliveryPage {
        const eventToLogicalKey = new Map<string, string>()
        for (const [logicalKey, eventId] of this.logicalEvents) {
            eventToLogicalKey.set(eventId, logicalKey)
        }
        for (const delivery of this.deliveries.values()) {
            const eventId = this.delivered.get(delivery.deliveryId)
            if (eventId) eventToLogicalKey.set(eventId, delivery.logicalKey)
        }

        const canonical = new Map<string, DurableMatrixDelivery>()
        for (const delivery of this.deliveries.values()) {
            if (delivery.request.roomId !== roomId) continue
            const current = canonical.get(delivery.logicalKey)
            if (
                !current
                || delivery.createdAt < current.createdAt
                || (
                    delivery.createdAt === current.createdAt
                    && delivery.deliveryId.localeCompare(current.deliveryId) < 0
                )
            ) {
                canonical.set(delivery.logicalKey, delivery)
            }
        }

        const entries = [...canonical.values()]
            .filter(delivery => isDisplayHistoryContent(delivery.request.content, sessionId))
            .map((delivery): MatrixHistoryDelivery => {
                const target = replacementTargetId(delivery.request.content)
                const replacementLogicalKey = target
                    ? eventToLogicalKey.get(target)
                    : undefined
                return {
                    logicalKey: delivery.logicalKey,
                    cursor: historyCursor(delivery.logicalKey),
                    createdAt: delivery.createdAt,
                    content: structuredClone(delivery.request.content),
                    ...(replacementLogicalKey ? { replacementLogicalKey } : {}),
                }
            })
            .sort((left, right) =>
                left.createdAt - right.createdAt
                || left.logicalKey.localeCompare(right.logicalKey),
            )

        let eligible = entries
        if (before !== undefined) {
            const index = entries.findIndex(entry => entry.cursor === before)
            if (index < 0) throw new Error('Matrix history cursor is no longer available')
            eligible = entries.slice(0, index)
        }
        const pageLimit = Math.max(1, Math.min(limit, 100))
        const selected = eligible.slice(-pageLimit)
        const byLogicalKey = new Map(entries.map(entry => [entry.logicalKey, entry]))
        const expanded = new Map<string, MatrixHistoryDelivery>()
        const visiting = new Set<string>()
        const includeWithDependencies = (entry: MatrixHistoryDelivery): void => {
            if (expanded.has(entry.logicalKey)) return
            if (expanded.size + visiting.size >= 500) {
                throw new Error('Matrix history edit dependency limit exceeded')
            }
            if (visiting.has(entry.logicalKey)) {
                throw new Error('Matrix history contains a cyclic edit relationship')
            }
            visiting.add(entry.logicalKey)
            const target = entry.replacementLogicalKey
                ? byLogicalKey.get(entry.replacementLogicalKey)
                : undefined
            if (target) includeWithDependencies(target)
            visiting.delete(entry.logicalKey)
            expanded.set(entry.logicalKey, entry)
        }
        for (const entry of selected) includeWithDependencies(entry)
        const deliveries = [...expanded.values()].sort((left, right) =>
            left.createdAt - right.createdAt
            || left.logicalKey.localeCompare(right.logicalKey),
        )
        return {
            deliveries,
            ...(selected[0] ? { nextBefore: selected[0].cursor } : {}),
            hasMore: eligible.length > selected.length,
        }
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
}

function historyCursor(logicalKey: string): string {
    return createHash('sha256')
        .update('codever-matrix-history:v1\0')
        .update(logicalKey)
        .digest('base64url')
}

function replacementTargetId(content: MatrixRoomMessageContent): string | undefined {
    const relation = asRecord(content['m.relates_to'])
    return relation?.rel_type === 'm.replace' && typeof relation.event_id === 'string'
        ? relation.event_id
        : undefined
}

function isDisplayHistoryContent(
    content: MatrixRoomMessageContent,
    sessionId: string,
): boolean {
    const replacement = asRecord(content['m.new_content'])
    const extension = asRecord(
        replacement?.['io.codever'] ?? content['io.codever'],
    )
    return extension?.session_id === sessionId && (
        extension.kind === 'collaboration_command'
        || extension.kind === 'message'
        || extension.kind === 'decision_request'
        || (extension.kind === 'command_result' && extension.outcome === 'failed')
    )
}

function validateEntry(value: unknown): DeliveryEntry {
    const entry = asRecord(value)
    if (entry?.version !== 1 || typeof entry.kind !== 'string') {
        throw new TypeError('unsupported record')
    }
    if (entry.kind === 'pending') {
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
            || entry.reason !== 'recipient_identity_changed'
            || typeof entry.abandonedAt !== 'number'
        ) {
            throw new TypeError('invalid abandoned record')
        }
        return entry as unknown as AbandonedEntry
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
