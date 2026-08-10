import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
    base64UrlDecode,
    base64UrlEncode,
    generateMatrixTimelineKey,
} from '@codever/security'

export interface TimelineKeyEpoch {
    epochId: string
    key: Uint8Array
    createdAt: number
}

export interface TimelineKeyRing {
    activeEpochId: string
    epochs: TimelineKeyEpoch[]
}

export const MAX_MATRIX_TIMELINE_KEY_EPOCHS = 64

interface PersistedTimelineKeyEpoch {
    epochId: string
    key: string
    createdAt: number
    recipientDeviceIds: string[]
}

interface PersistedTimelineKeyRoom {
    activeEpochId: string
    epochs: PersistedTimelineKeyEpoch[]
}

interface TimelineKeyFile {
    version: 1
    rooms: Record<string, PersistedTimelineKeyRoom>
}

/**
 * Durable application-layer group keys for Matrix timeline history. Keys are
 * intentionally retained across rotations: a newly paired, authorized device
 * receives the key ring once and then reads history from Matrix itself.
 */
export class FileTimelineKeyStore {
    private state: TimelineKeyFile = { version: 1, rooms: {} }
    private chain: Promise<unknown> = Promise.resolve()
    private initialized = false

    constructor(private readonly path: string) {}

    initialize(): Promise<void> {
        return this.serial(async () => {
            if (this.initialized) return
            try {
                this.state = validateTimelineKeyFile(
                    JSON.parse(await readFile(this.path, 'utf8')),
                )
            } catch (error) {
                if (!isMissingFile(error)) throw error
            }
            this.initialized = true
        })
    }

    ensureRoom(
        roomId: string,
        activeDeviceIds: readonly string[],
        now = Date.now(),
    ): Promise<TimelineKeyRing> {
        return this.serial(async () => {
            this.assertInitialized()
            const recipients = uniqueSorted(activeDeviceIds)
            if (recipients.length === 0) {
                throw new Error(`Timeline key room ${roomId} requires an active recipient`)
            }
            let room = this.state.rooms[roomId]
            let changed = false
            if (!room) {
                const epoch = createEpoch(recipients, now)
                room = { activeEpochId: epoch.epochId, epochs: [epoch] }
                this.state.rooms[roomId] = room
                changed = true
            } else {
                const active = room.epochs.find(epoch => epoch.epochId === room.activeEpochId)
                if (!active) throw new Error(`Timeline key room ${roomId} has no active epoch`)
                const current = new Set(recipients)
                const recipientRemoved = active.recipientDeviceIds.some(id => !current.has(id))
                if (recipientRemoved) {
                    if (room.epochs.length >= MAX_MATRIX_TIMELINE_KEY_EPOCHS) {
                        throw new Error(
                            `Timeline key room ${roomId} exceeded ${MAX_MATRIX_TIMELINE_KEY_EPOCHS} retained epochs`,
                        )
                    }
                    const epoch = createEpoch(recipients, now)
                    room.epochs.push(epoch)
                    room.activeEpochId = epoch.epochId
                    changed = true
                } else if (!sameStrings(active.recipientDeviceIds, recipients)) {
                    // Addition grants old history and joins the new device to
                    // this epoch. A later removal of that device rotates it.
                    active.recipientDeviceIds = recipients
                    changed = true
                }
            }
            if (changed) await this.writeAtomic()
            return publicKeyRing(room)
        })
    }

    private serial<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.chain.then(operation)
        this.chain = result.then(() => undefined, () => undefined)
        return result
    }

    private assertInitialized(): void {
        if (!this.initialized) throw new Error('Timeline key store is not initialized')
    }

    private async writeAtomic(): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true })
        const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`
        const handle = await open(temporaryPath, 'wx', 0o600)
        try {
            await handle.writeFile(`${JSON.stringify(this.state)}\n`, 'utf8')
            await handle.sync()
        } finally {
            await handle.close()
        }
        await chmod(temporaryPath, 0o600)
        await rename(temporaryPath, this.path)
        await chmod(this.path, 0o600)
    }
}

function createEpoch(
    recipientDeviceIds: string[],
    createdAt: number,
): PersistedTimelineKeyEpoch {
    return {
        epochId: randomUUID(),
        key: base64UrlEncode(generateMatrixTimelineKey()),
        createdAt,
        recipientDeviceIds,
    }
}

function publicKeyRing(room: PersistedTimelineKeyRoom): TimelineKeyRing {
    return {
        activeEpochId: room.activeEpochId,
        epochs: room.epochs.map(epoch => ({
            epochId: epoch.epochId,
            key: base64UrlDecode(epoch.key),
            createdAt: epoch.createdAt,
        })),
    }
}

function validateTimelineKeyFile(value: unknown): TimelineKeyFile {
    const record = asRecord(value)
    const rooms = asRecord(record?.rooms)
    if (record?.version !== 1 || !rooms) {
        throw new Error('Invalid Matrix timeline key file')
    }
    const parsed: Record<string, PersistedTimelineKeyRoom> = {}
    for (const [roomId, candidate] of Object.entries(rooms)) {
        const room = asRecord(candidate)
        if (!room || typeof room.activeEpochId !== 'string' || !Array.isArray(room.epochs)) {
            throw new Error(`Invalid Matrix timeline key room ${roomId}`)
        }
        if (
            room.epochs.length === 0
            || room.epochs.length > MAX_MATRIX_TIMELINE_KEY_EPOCHS
        ) {
            throw new Error(`Invalid Matrix timeline key epoch count for ${roomId}`)
        }
        const epochIds = new Set<string>()
        const epochs = room.epochs.map((entry, index) => {
            const epoch = asRecord(entry)
            if (
                !epoch
                || typeof epoch.epochId !== 'string'
                || !epoch.epochId
                || typeof epoch.key !== 'string'
                || !Number.isSafeInteger(epoch.createdAt)
                || (epoch.createdAt as number) < 0
                || !Array.isArray(epoch.recipientDeviceIds)
                || epoch.recipientDeviceIds.some(id => typeof id !== 'string' || !id)
                || epochIds.has(epoch.epochId)
            ) {
                throw new Error(`Invalid Matrix timeline key epoch ${index} for ${roomId}`)
            }
            if (base64UrlDecode(epoch.key).byteLength !== 32) {
                throw new Error(`Invalid Matrix timeline key bytes for ${roomId}`)
            }
            epochIds.add(epoch.epochId)
            return {
                epochId: epoch.epochId,
                key: epoch.key,
                createdAt: epoch.createdAt as number,
                recipientDeviceIds: uniqueSorted(epoch.recipientDeviceIds as string[]),
            }
        })
        if (!epochIds.has(room.activeEpochId)) {
            throw new Error(`Matrix timeline key room ${roomId} has no active epoch`)
        }
        parsed[roomId] = { activeEpochId: room.activeEpochId, epochs }
    }
    return { version: 1, rooms: parsed }
}

function uniqueSorted(values: readonly string[]): string[] {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index])
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function isMissingFile(error: unknown): boolean {
    return asRecord(error)?.code === 'ENOENT'
}
