import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MatrixGatewayRoomConfig } from './config'

export interface PersistedAppSession {
    id: string
    title: string
    updatedAt: number
    provider: string
    model: string | null
    providerSessionId: string | null
}

export interface PersistedRoomRuntimeState {
    revisionEpoch: string
    revisionEpochGeneration: number
    replayGeneration: string
    stateVersion: number
    currentSessionId: string | null
    appSessions: PersistedAppSession[]
    workspace: {
        cwd: string
        provider: string
        model: string | null
        permissionMode: string
    }
}

interface RuntimeStateFile {
    version: 1
    rooms: Record<string, PersistedRoomRuntimeState>
}

export class FileGatewayRuntimeStateStore {
    private state: RuntimeStateFile = { version: 1, rooms: {} }
    private chain: Promise<unknown> = Promise.resolve()
    private initialized = false
    private migrationPending = false

    constructor(private readonly path: string) {}

    initialize(
        rooms: readonly MatrixGatewayRoomConfig[],
        replayGeneration: string,
    ): Promise<void> {
        return this.serial(async () => {
            if (!replayGeneration) throw new Error('Replay ledger generation is required')
            if (!this.initialized) await this.load()
            let changed = this.migrationPending
            for (const room of rooms) {
                const current = this.state.rooms[room.roomId]
                if (!current) {
                    this.state.rooms[room.roomId] = defaultRoomState(room, replayGeneration)
                    changed = true
                    continue
                }
                if (current.replayGeneration !== replayGeneration) {
                    current.revisionEpoch = randomUUID()
                    current.revisionEpochGeneration += 1
                    current.replayGeneration = replayGeneration
                    changed = true
                }
            }
            if (changed) {
                await this.writeAtomic()
                this.migrationPending = false
            }
        })
    }

    getRoom(roomId: string): PersistedRoomRuntimeState {
        const room = this.state.rooms[roomId]
        if (!room) throw new Error(`Runtime state for room ${roomId} is not initialized`)
        return structuredClone(room)
    }

    saveRoom(roomId: string, room: PersistedRoomRuntimeState): Promise<void> {
        return this.serial(async () => {
            const current = this.state.rooms[roomId]
            if (!current) throw new Error(`Runtime state for room ${roomId} is not initialized`)
            this.state.rooms[roomId] = {
                ...structuredClone(room),
                // A concurrent explicit sync may already have advanced the
                // durable version before this state mutation reached the
                // serialized writer. State-only saves must never move it back.
                stateVersion: Math.max(current.stateVersion, room.stateVersion),
            }
            await this.writeAtomic()
        })
    }

    incrementStateVersion(
        roomId: string,
        room: Omit<PersistedRoomRuntimeState, 'stateVersion'>,
    ): Promise<number> {
        return this.serial(async () => {
            const current = this.state.rooms[roomId]
            if (!current) throw new Error(`Runtime state for room ${roomId} is not initialized`)
            const stateVersion = current.stateVersion + 1
            this.state.rooms[roomId] = {
                ...structuredClone(room),
                stateVersion,
            }
            await this.writeAtomic()
            return stateVersion
        })
    }

    private serial<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.chain.then(operation)
        this.chain = result.then(() => undefined, () => undefined)
        return result
    }

    private async load(): Promise<void> {
        try {
            const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown
            this.migrationPending = requiresEpochGenerationMigration(parsed)
            this.state = validateStateFile(parsed)
        } catch (error) {
            if (!isMissingFile(error)) throw error
        }
        this.initialized = true
    }

    private async writeAtomic(): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true })
        const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`
        const handle = await open(temporaryPath, 'wx')
        try {
            await handle.writeFile(`${JSON.stringify(this.state)}\n`, 'utf8')
            await handle.sync()
        } finally {
            await handle.close()
        }
        await rename(temporaryPath, this.path)
    }
}

function defaultRoomState(
    room: MatrixGatewayRoomConfig,
    replayGeneration: string,
): PersistedRoomRuntimeState {
    return {
        revisionEpoch: randomUUID(),
        revisionEpochGeneration: 1,
        replayGeneration,
        stateVersion: 0,
        currentSessionId: null,
        appSessions: [],
        workspace: {
            cwd: room.cwd,
            provider: room.providerName,
            model: room.model ?? null,
            permissionMode: 'default',
        },
    }
}

function validateStateFile(value: unknown): RuntimeStateFile {
    const record = asRecord(value)
    if (record?.version !== 1) throw new Error('Invalid Gateway runtime state version')
    const rooms = asRecord(record.rooms)
    if (!rooms) throw new Error('Invalid Gateway runtime state rooms')
    const parsed: Record<string, PersistedRoomRuntimeState> = {}
    for (const [roomId, roomValue] of Object.entries(rooms)) {
        const room = asRecord(roomValue)
        const workspace = asRecord(room?.workspace)
        if (
            !room
            || typeof room.revisionEpoch !== 'string'
            || !room.revisionEpoch
            || !(
                room.revisionEpochGeneration === undefined
                || (
                    Number.isSafeInteger(room.revisionEpochGeneration)
                    && (room.revisionEpochGeneration as number) >= 1
                )
            )
            || !(room.replayGeneration === undefined || typeof room.replayGeneration === 'string')
            || !Number.isSafeInteger(room.stateVersion)
            || (room.stateVersion as number) < 0
            || !(room.currentSessionId === null || typeof room.currentSessionId === 'string')
            || !Array.isArray(room.appSessions)
            || !workspace
            || typeof workspace.cwd !== 'string'
            || typeof workspace.provider !== 'string'
            || !(workspace.model === null || typeof workspace.model === 'string')
            || typeof workspace.permissionMode !== 'string'
        ) {
            throw new Error(`Invalid Gateway runtime state for room ${roomId}`)
        }
        const appSessions = room.appSessions.map((entry, index) =>
            validateAppSession(entry, roomId, index),
        )
        if (
            room.currentSessionId !== null
            && !appSessions.some(session => session.id === room.currentSessionId)
        ) {
            throw new Error(`Gateway runtime current session is missing for room ${roomId}`)
        }
        parsed[roomId] = {
            revisionEpoch: room.revisionEpoch,
            revisionEpochGeneration: typeof room.revisionEpochGeneration === 'number'
                ? room.revisionEpochGeneration
                : 1,
            // Runtime-state files created before ledger generations existed
            // intentionally mismatch on initialize and rotate the epoch once.
            replayGeneration: typeof room.replayGeneration === 'string'
                ? room.replayGeneration
                : '',
            stateVersion: room.stateVersion as number,
            currentSessionId: room.currentSessionId as string | null,
            appSessions,
            workspace: {
                cwd: workspace.cwd,
                provider: workspace.provider,
                model: workspace.model as string | null,
                permissionMode: workspace.permissionMode,
            },
        }
    }
    return { version: 1, rooms: parsed }
}

function validateAppSession(
    value: unknown,
    roomId: string,
    index: number,
): PersistedAppSession {
    const session = asRecord(value)
    if (
        !session
        || typeof session.id !== 'string'
        || !session.id
        || typeof session.title !== 'string'
        || !Number.isSafeInteger(session.updatedAt)
        || typeof session.provider !== 'string'
        || !(session.model === null || typeof session.model === 'string')
        || !(session.providerSessionId === null || typeof session.providerSessionId === 'string')
    ) {
        throw new Error(`Invalid Gateway app session ${index} for room ${roomId}`)
    }
    return session as unknown as PersistedAppSession
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function requiresEpochGenerationMigration(value: unknown): boolean {
    const rooms = asRecord(asRecord(value)?.rooms)
    return Boolean(
        rooms
        && Object.values(rooms).some(room =>
            asRecord(room)?.revisionEpochGeneration === undefined,
        ),
    )
}

function isMissingFile(error: unknown): boolean {
    return asRecord(error)?.code === 'ENOENT'
}
