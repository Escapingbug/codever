import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { matrixStateContentSchema, type MatrixStateContent } from '@codever/protocol'

interface StatePendingEntry {
    version: 1
    kind: 'pending'
    deliveryId: string
    roomId: string
    eventType: string
    stateKey: string
    stateVersion: number
    content: MatrixStateContent
    createdAt: number
}

interface StateDeliveredEntry {
    version: 1
    kind: 'delivered'
    deliveryId: string
    eventId: string
    deliveredAt: number
}

interface StateSupersededEntry {
    version: 1
    kind: 'superseded'
    deliveryId: string
    supersededAt: number
}

type StateOutboxEntry = StatePendingEntry | StateDeliveredEntry | StateSupersededEntry
export type DurableMatrixStateDelivery = Omit<StatePendingEntry, 'version' | 'kind'>

interface DecodedStateOutboxEntry {
    entry: StateOutboxEntry
    /**
     * Gateway state written before per-device command cursors existed cannot
     * be retried: a current native client would be unable to reconcile its
     * durable command sequence from that state. Delivered values remain a
     * useful semantic cache, while pending values are retired during load and
     * replaced by the authoritative state published during Gateway startup.
     */
    legacyGatewayStateWithoutCommandSequences: boolean
    legacyGatewayStateWithoutDirectory: boolean
}

export class FileMatrixStateOutbox {
    private readonly pending = new Map<string, DurableMatrixStateDelivery>()
    private readonly deliveries = new Map<string, DurableMatrixStateDelivery>()
    private readonly terminal = new Set<string>()
    private writeChain: Promise<void> = Promise.resolve()
    private readonly entityChains = new Map<string, Promise<void>>()
    private recordCount = 0
    private compactionPromise: Promise<void> | null = null

    constructor(private readonly path: string) {}

    async initialize(): Promise<void> {
        let bytes: Buffer
        try {
            bytes = await readFile(this.path)
        } catch (error) {
            if (asRecord(error)?.code === 'ENOENT') return
            throw error
        }
        if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
            const lastNewline = bytes.lastIndexOf(0x0a)
            const validLength = lastNewline < 0 ? 0 : lastNewline + 1
            await truncateAndSync(this.path, validLength)
            bytes = bytes.subarray(0, validLength)
        }
        const legacyGatewayDeliveries = new Set<string>()
        for (const [index, line] of bytes.toString('utf8').split(/\r?\n/u).entries()) {
            if (!line.trim()) continue
            this.recordCount += 1
            let decoded: DecodedStateOutboxEntry
            try {
                decoded = validateEntry(JSON.parse(line))
            } catch (error) {
                throw new Error(`Invalid Matrix state outbox record at line ${index + 1}: ${formatError(error)}`)
            }
            const { entry } = decoded
            if (entry.kind === 'pending') {
                const { version: _version, kind: _kind, ...delivery } = entry
                this.deliveries.set(entry.deliveryId, delivery)
                if (
                    decoded.legacyGatewayStateWithoutCommandSequences
                    || decoded.legacyGatewayStateWithoutDirectory
                ) {
                    legacyGatewayDeliveries.add(entry.deliveryId)
                }
                if (!this.terminal.has(entry.deliveryId)) {
                    this.pending.set(entry.deliveryId, delivery)
                }
            } else {
                this.pending.delete(entry.deliveryId)
                this.terminal.add(entry.deliveryId)
            }
        }
        const unsafeLegacyPending = [...legacyGatewayDeliveries]
            .filter(deliveryId => this.pending.has(deliveryId))
        if (unsafeLegacyPending.length > 0) {
            const supersededAt = Date.now()
            await this.appendMany(unsafeLegacyPending.map(deliveryId => ({
                version: 1 as const,
                kind: 'superseded' as const,
                deliveryId,
                supersededAt,
            })))
            for (const deliveryId of unsafeLegacyPending) {
                this.pending.delete(deliveryId)
                this.terminal.add(deliveryId)
            }
        }
    }

    createDelivery(input: Omit<DurableMatrixStateDelivery, 'deliveryId'>): DurableMatrixStateDelivery {
        return {
            ...input,
            deliveryId: createHash('sha256')
                .update('codever-matrix-state:v2\0')
                .update(JSON.stringify([input.roomId, input.eventType, input.stateKey]))
                .update('\0')
                .update(String(input.stateVersion))
                .update('\0')
                .update(JSON.stringify(input.content))
                .digest('hex'),
        }
    }

    async stage(delivery: DurableMatrixStateDelivery): Promise<void> {
        await this.stageBatch([delivery])
    }

    async stageBatch(deliveries: readonly DurableMatrixStateDelivery[]): Promise<void> {
        const fresh = deliveries.filter(delivery =>
            !this.pending.has(delivery.deliveryId) && !this.terminal.has(delivery.deliveryId)
        )
        if (fresh.length === 0) return
        await this.appendMany(fresh.map(delivery => ({
            version: 1 as const,
            kind: 'pending' as const,
            ...delivery,
        })))
        for (const delivery of fresh) {
            this.deliveries.set(delivery.deliveryId, delivery)
            this.pending.set(delivery.deliveryId, delivery)
        }
    }

    pendingForRoom(roomId: string): DurableMatrixStateDelivery[] {
        return [...this.pending.values()]
            .filter(delivery => delivery.roomId === roomId)
            .sort((left, right) => left.createdAt - right.createdAt)
    }

    latestPendingForRoom(roomId: string): DurableMatrixStateDelivery[] {
        return latestByEntity(
            [...this.pending.values()].filter(delivery => delivery.roomId === roomId),
        ).sort((left, right) => left.createdAt - right.createdAt)
    }

    latestForRoom(roomId: string): DurableMatrixStateDelivery[] {
        return latestByEntity(
            [...this.deliveries.values()].filter(delivery => delivery.roomId === roomId),
        ).sort((left, right) => left.createdAt - right.createdAt)
    }

    latestForEntity(delivery: DurableMatrixStateDelivery): DurableMatrixStateDelivery {
        const matching = [...this.deliveries.values()].filter(candidate =>
            entityKey(candidate) === entityKey(delivery),
        )
        return matching.reduce((latest, candidate) =>
            candidate.stateVersion > latest.stateVersion
            || (
                candidate.stateVersion === latest.stateVersion
                && candidate.createdAt > latest.createdAt
            ) ? candidate : latest,
        delivery)
    }

    isPending(deliveryId: string): boolean {
        return this.pending.has(deliveryId)
    }

    async markDelivered(deliveryId: string, eventId: string): Promise<void> {
        if (this.terminal.has(deliveryId)) return
        await this.append({
            version: 1,
            kind: 'delivered',
            deliveryId,
            eventId,
            deliveredAt: Date.now(),
        })
        this.pending.delete(deliveryId)
        this.terminal.add(deliveryId)
    }

    async supersedeOlder(latest: DurableMatrixStateDelivery): Promise<void> {
        const older = [...this.pending.values()].filter(candidate =>
            candidate.deliveryId !== latest.deliveryId
            && entityKey(candidate) === entityKey(latest)
            && candidate.stateVersion <= latest.stateVersion,
        )
        for (const delivery of older) {
            await this.append({
                version: 1,
                kind: 'superseded',
                deliveryId: delivery.deliveryId,
                supersededAt: Date.now(),
            })
            this.pending.delete(delivery.deliveryId)
            this.terminal.add(delivery.deliveryId)
        }
    }

    /**
     * Rewrites the append log to one latest value per Matrix state key. The
     * latest delivered values remain as durable semantic cache; latest pending
     * values remain retryable. Atomic rename means a crash leaves either the
     * old valid WAL or the fully fsynced compacted WAL.
     */
    compact(): Promise<void> {
        if (this.compactionPromise) return this.compactionPromise
        const compaction = this.writeChain.then(async () => {
            const latest = latestByEntity([...this.deliveries.values()])
                .sort((left, right) => left.createdAt - right.createdAt)
            const lines: string[] = []
            for (const delivery of latest) {
                lines.push(JSON.stringify({ version: 1, kind: 'pending', ...delivery }))
                if (!this.pending.has(delivery.deliveryId)) {
                    lines.push(JSON.stringify({
                        version: 1,
                        kind: 'delivered',
                        deliveryId: delivery.deliveryId,
                        eventId: `$codever-compacted-${delivery.deliveryId}`,
                        deliveredAt: Date.now(),
                    }))
                }
            }
            await mkdir(dirname(this.path), { recursive: true })
            const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`
            const handle = await open(temporaryPath, 'wx')
            try {
                await handle.writeFile(lines.length ? `${lines.join('\n')}\n` : '', 'utf8')
                await handle.sync()
            } finally {
                await handle.close()
            }
            await rename(temporaryPath, this.path)
            this.deliveries.clear()
            this.terminal.clear()
            for (const delivery of latest) {
                this.deliveries.set(delivery.deliveryId, delivery)
                if (!this.pending.has(delivery.deliveryId)) this.terminal.add(delivery.deliveryId)
            }
            this.recordCount = lines.length
        })
        this.writeChain = compaction
        const settled = compaction.finally(() => {
            if (this.compactionPromise === settled) this.compactionPromise = null
        })
        this.compactionPromise = settled
        return settled
    }

    compactIfNeeded(): Promise<void> {
        return this.recordCount >= COMPACTION_RECORD_THRESHOLD
            ? this.compact()
            : Promise.resolve()
    }

    serializeEntity<T>(
        delivery: DurableMatrixStateDelivery,
        operation: () => Promise<T>,
    ): Promise<T> {
        const key = entityKey(delivery)
        const previous = this.entityChains.get(key) ?? Promise.resolve()
        const current = previous.catch(() => undefined).then(operation)
        const settled = current.then(() => undefined, () => undefined)
        this.entityChains.set(key, settled)
        void settled.then(() => {
            if (this.entityChains.get(key) === settled) this.entityChains.delete(key)
        })
        return current
    }

    private async append(entry: StateOutboxEntry): Promise<void> {
        await this.appendMany([entry])
    }

    private async appendMany(entries: readonly StateOutboxEntry[]): Promise<void> {
        if (entries.length === 0) return
        const value = `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`
        this.writeChain = this.writeChain.then(async () => {
            await mkdir(dirname(this.path), { recursive: true })
            const handle = await open(this.path, 'a')
            try {
                await handle.writeFile(value, 'utf8')
                await handle.sync()
            } finally {
                await handle.close()
            }
        })
        await this.writeChain
        this.recordCount += entries.length
    }
}

const COMPACTION_RECORD_THRESHOLD = 4_096

async function truncateAndSync(path: string, length: number): Promise<void> {
    const handle = await open(path, 'r+')
    try {
        await handle.truncate(length)
        await handle.sync()
    } finally {
        await handle.close()
    }
}

function entityKey(delivery: Pick<DurableMatrixStateDelivery, 'roomId' | 'eventType' | 'stateKey'>): string {
    return JSON.stringify([delivery.roomId, delivery.eventType, delivery.stateKey])
}

function latestByEntity(
    deliveries: readonly DurableMatrixStateDelivery[],
): DurableMatrixStateDelivery[] {
    const latest = new Map<string, DurableMatrixStateDelivery>()
    for (const delivery of deliveries) {
        const key = entityKey(delivery)
        const current = latest.get(key)
        if (
            !current
            || delivery.stateVersion > current.stateVersion
            || (
                delivery.stateVersion === current.stateVersion
                && delivery.createdAt > current.createdAt
            )
        ) latest.set(key, delivery)
    }
    return [...latest.values()]
}

function validateEntry(value: unknown): DecodedStateOutboxEntry {
    const entry = asRecord(value)
    if (!entry || entry.version !== 1 || typeof entry.kind !== 'string') {
        throw new TypeError('unsupported record')
    }
    if (entry.kind === 'pending') {
        if (
            typeof entry.deliveryId !== 'string'
            || typeof entry.roomId !== 'string'
            || typeof entry.eventType !== 'string'
            || typeof entry.stateKey !== 'string'
            || typeof entry.stateVersion !== 'number'
            || typeof entry.createdAt !== 'number'
        ) throw new TypeError('invalid pending record')
        const content = asRecord(entry.content)
        const legacyGatewayStateWithoutCommandSequences =
            content?.kind === 'gateway_state'
            && !Object.prototype.hasOwnProperty.call(content, 'command_sequences')
        const legacyGatewayStateWithoutDirectory =
            content?.kind === 'gateway_state'
            && !Object.prototype.hasOwnProperty.call(content, 'session_directory')
        const migratedContent = content?.kind === 'gateway_state'
            ? {
                ...content,
                ...(legacyGatewayStateWithoutCommandSequences ? { command_sequences: [] } : {}),
                ...(legacyGatewayStateWithoutDirectory
                    ? {
                        session_directory: {
                            generation: 0,
                            state_version: 0,
                            slot: 0,
                            page_count: 0,
                            state_key_prefix: 'legacy-rebuild-required',
                            digest: createHash('sha256').update('[]').digest('base64url'),
                        },
                    }
                    : {}),
            }
            : entry.content
        return {
            entry: {
                ...entry,
                content: matrixStateContentSchema.parse(migratedContent),
            } as unknown as StatePendingEntry,
            legacyGatewayStateWithoutCommandSequences,
            legacyGatewayStateWithoutDirectory,
        }
    }
    if (entry.kind === 'delivered') {
        if (
            typeof entry.deliveryId !== 'string'
            || typeof entry.eventId !== 'string'
            || typeof entry.deliveredAt !== 'number'
        ) throw new TypeError('invalid delivered record')
        return {
            entry: entry as unknown as StateDeliveredEntry,
            legacyGatewayStateWithoutCommandSequences: false,
            legacyGatewayStateWithoutDirectory: false,
        }
    }
    if (entry.kind === 'superseded') {
        if (typeof entry.deliveryId !== 'string' || typeof entry.supersededAt !== 'number') {
            throw new TypeError('invalid superseded record')
        }
        return {
            entry: entry as unknown as StateSupersededEntry,
            legacyGatewayStateWithoutCommandSequences: false,
            legacyGatewayStateWithoutDirectory: false,
        }
    }
    throw new TypeError('unknown record kind')
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
