import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
    migrateVersionedState,
    sessionExtensionBindingSchema,
    type SessionExtensionBinding,
    type VersionedState,
} from '@codever/protocol'
import type { MatrixGatewayRoomConfig } from './config'
import { gatewayProjectIdentity } from './project'

export interface PersistedAppSession {
    id: string
    title: string
    createdAt: number
    updatedAt: number
    matrixThreadRootEventId: string | null
    projectId: string
    projectName: string
    cwd: string
    provider: string
    model: string | null
    reasoningEffort: string | null
    permissionMode: string
    providerSessionId: string | null
    archivedAt: number | null
    extensions: SessionExtensionBinding[]
}

export interface PersistedRoomRuntimeState {
    revisionEpoch: string
    revisionEpochGeneration: number
    replayGeneration: string
    stateVersion: number
    currentSessionId: string | null
    appSessions: PersistedAppSession[]
    deletedSessionIds: string[]
    workspace: {
        projectId: string
        projectName: string
        cwd: string
        provider: string
        model: string | null
        reasoningEffort: string | null
        permissionMode: string
    }
}

interface RuntimeStateFile {
    version: 2
    rooms: Record<string, PersistedRoomRuntimeState>
}

export const GATEWAY_RUNTIME_STATE_SCHEMA_VERSION = 2
export const GATEWAY_RUNTIME_STATE_MIGRATIONS: Readonly<
    Record<number, ((value: VersionedState) => VersionedState) | undefined>
> = Object.freeze({
    1: migrateRuntimeStateV1,
})

export class FileGatewayRuntimeStateStore {
    private state: RuntimeStateFile = { version: 2, rooms: {} }
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
            const migrated = migrateVersionedState({
                label: 'Gateway runtime state',
                value: requireVersionedRecord(parsed),
                currentVersion: GATEWAY_RUNTIME_STATE_SCHEMA_VERSION,
                migrations: GATEWAY_RUNTIME_STATE_MIGRATIONS,
            })
            this.migrationPending = migrated.migratedFrom !== null
            this.state = validateStateFile(migrated.value)
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

/**
 * Schema 1 existed across several pre-release builds. Normalize every field
 * those builds could omit before the strict schema-2 validator runs. The
 * resulting file is committed atomically during initialize(), before the
 * Gateway starts serving commands.
 */
function migrateRuntimeStateV1(value: VersionedState): VersionedState {
    const rooms = asRecord(value.rooms)
    if (!rooms) throw new Error('Invalid Gateway runtime state rooms')
    return {
        version: 2,
        rooms: Object.fromEntries(Object.entries(rooms).map(([roomId, roomValue]) => {
            const room = asRecord(roomValue)
            const workspace = asRecord(room?.workspace)
            if (!room || !workspace || typeof workspace.cwd !== 'string') {
                throw new Error(`Invalid Gateway runtime state for room ${roomId}`)
            }
            const workspaceProject = gatewayProjectIdentity(
                workspace.cwd,
                typeof workspace.projectName === 'string' ? workspace.projectName : undefined,
            )
            const reasoningEffort = typeof workspace.reasoningEffort === 'string'
                ? workspace.reasoningEffort
                : null
            const permissionMode = typeof workspace.permissionMode === 'string'
                ? workspace.permissionMode
                : 'default'
            if (!Array.isArray(room.appSessions)) {
                throw new Error(`Invalid Gateway runtime state for room ${roomId}`)
            }
            const appSessions = room.appSessions.map((entry, index) => {
                const session = asRecord(entry)
                if (
                    !session
                    || typeof session.id !== 'string'
                    || !session.id
                    || typeof session.title !== 'string'
                    || !Number.isSafeInteger(session.updatedAt)
                    || typeof session.provider !== 'string'
                ) {
                    throw new Error(`Invalid Gateway app session ${index} for room ${roomId}`)
                }
                const project = typeof session.cwd === 'string'
                    ? gatewayProjectIdentity(
                        session.cwd,
                        typeof session.projectName === 'string' ? session.projectName : undefined,
                    )
                    : workspaceProject
                return {
                    ...session,
                    createdAt: Number.isSafeInteger(session.createdAt)
                        ? session.createdAt
                        : session.updatedAt,
                    matrixThreadRootEventId: typeof session.matrixThreadRootEventId === 'string'
                        ? session.matrixThreadRootEventId
                        : null,
                    projectId: project.id,
                    projectName: project.name,
                    cwd: project.cwd,
                    model: typeof session.model === 'string' ? session.model : null,
                    reasoningEffort: typeof session.reasoningEffort === 'string'
                        ? session.reasoningEffort
                        : reasoningEffort,
                    permissionMode: typeof session.permissionMode === 'string'
                        ? session.permissionMode
                        : permissionMode,
                    providerSessionId: typeof session.providerSessionId === 'string'
                        ? session.providerSessionId
                        : null,
                    archivedAt: Number.isSafeInteger(session.archivedAt)
                        ? session.archivedAt
                        : null,
                    extensions: Array.isArray(session.extensions) ? session.extensions : [],
                }
            })
            return [roomId, {
                ...room,
                revisionEpochGeneration: Number.isSafeInteger(room.revisionEpochGeneration)
                    ? room.revisionEpochGeneration
                    : 1,
                replayGeneration: typeof room.replayGeneration === 'string'
                    && room.replayGeneration
                    ? room.replayGeneration
                    : 'migration:missing-replay-generation',
                appSessions,
                deletedSessionIds: [],
                workspace: {
                    ...workspace,
                    projectId: workspaceProject.id,
                    projectName: workspaceProject.name,
                    cwd: workspaceProject.cwd,
                    model: typeof workspace.model === 'string' ? workspace.model : null,
                    reasoningEffort,
                    permissionMode,
                },
            }]
        })),
    }
}

function defaultRoomState(
    room: MatrixGatewayRoomConfig,
    replayGeneration: string,
): PersistedRoomRuntimeState {
    const project = gatewayProjectIdentity(room.cwd)
    return {
        revisionEpoch: randomUUID(),
        revisionEpochGeneration: 1,
        replayGeneration,
        stateVersion: 0,
        currentSessionId: null,
        appSessions: [],
        deletedSessionIds: [],
        workspace: {
            projectId: project.id,
            projectName: project.name,
            cwd: project.cwd,
            provider: room.providerName,
            model: room.model ?? null,
            reasoningEffort: typeof room.providerSettings?.reasoningEffort === 'string'
                ? room.providerSettings.reasoningEffort
                : null,
            permissionMode: 'default',
        },
    }
}

function validateStateFile(value: unknown): RuntimeStateFile {
    const record = asRecord(value)
    if (record?.version !== 2) throw new Error('Invalid Gateway runtime state version')
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
            || !Number.isSafeInteger(room.revisionEpochGeneration)
            || (room.revisionEpochGeneration as number) < 1
            || typeof room.replayGeneration !== 'string'
            || !room.replayGeneration
            || !Number.isSafeInteger(room.stateVersion)
            || (room.stateVersion as number) < 0
            || !(room.currentSessionId === null || typeof room.currentSessionId === 'string')
            || !Array.isArray(room.appSessions)
            || !Array.isArray(room.deletedSessionIds)
            || !workspace
            || typeof workspace.cwd !== 'string'
            || typeof workspace.provider !== 'string'
            || !(workspace.model === null || typeof workspace.model === 'string')
            || typeof workspace.projectId !== 'string'
            || !workspace.projectId
            || typeof workspace.projectName !== 'string'
            || !workspace.projectName
            || !(workspace.reasoningEffort === null || typeof workspace.reasoningEffort === 'string')
            || typeof workspace.permissionMode !== 'string'
        ) {
            throw new Error(`Invalid Gateway runtime state for room ${roomId}`)
        }
        const workspaceProject = gatewayProjectIdentity(
            workspace.cwd,
            typeof workspace.projectName === 'string' ? workspace.projectName : undefined,
        )
        if (workspace.projectId !== workspaceProject.id) {
            throw new Error(`Invalid Gateway workspace project for room ${roomId}`)
        }
        const appSessions = room.appSessions.map((entry, index) =>
            validateAppSession(entry, roomId, index),
        )
        const deletedSessionIds = [...new Set(room.deletedSessionIds.map((entry, index) => {
                if (typeof entry !== 'string' || !entry) {
                    throw new Error(`Invalid deleted session ${index} for room ${roomId}`)
                }
                return entry
        }))]
        if (appSessions.some(session => deletedSessionIds.includes(session.id))) {
            throw new Error(`Gateway runtime contains both a session and tombstone for room ${roomId}`)
        }
        if (
            room.currentSessionId !== null
            && !appSessions.some(session => session.id === room.currentSessionId)
        ) {
            throw new Error(`Gateway runtime current session is missing for room ${roomId}`)
        }
        parsed[roomId] = {
            revisionEpoch: room.revisionEpoch,
            revisionEpochGeneration: room.revisionEpochGeneration as number,
            replayGeneration: room.replayGeneration,
            stateVersion: room.stateVersion as number,
            currentSessionId: room.currentSessionId as string | null,
            appSessions,
            deletedSessionIds,
            workspace: {
                projectId: workspace.projectId,
                projectName: workspaceProject.name,
                cwd: workspaceProject.cwd,
                provider: workspace.provider,
                model: workspace.model as string | null,
                reasoningEffort: workspace.reasoningEffort as string | null,
                permissionMode: workspace.permissionMode,
            },
        }
    }
    return { version: 2, rooms: parsed }
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
        || !Number.isSafeInteger(session.createdAt)
        || (session.createdAt as number) < 0
        || !Number.isSafeInteger(session.updatedAt)
        || typeof session.provider !== 'string'
        || !(session.model === null || typeof session.model === 'string')
        || !(session.providerSessionId === null || typeof session.providerSessionId === 'string')
        || !(session.matrixThreadRootEventId === null || typeof session.matrixThreadRootEventId === 'string')
    ) {
        throw new Error(`Invalid Gateway app session ${index} for room ${roomId}`)
    }
    if (
        !(
            session.reasoningEffort === null
            || typeof session.reasoningEffort === 'string'
        )
        || typeof session.permissionMode !== 'string'
        || typeof session.cwd !== 'string'
        || typeof session.projectId !== 'string'
        || !session.projectId
        || typeof session.projectName !== 'string'
        || !session.projectName
        || !(
            session.archivedAt === null
            || (Number.isSafeInteger(session.archivedAt) && (session.archivedAt as number) >= 0)
        )
        || !Array.isArray(session.extensions)
    ) {
        throw new Error(`Invalid Gateway app session ${index} for room ${roomId}`)
    }
    const generatedProject = gatewayProjectIdentity(session.cwd, session.projectName)
    if (session.projectId !== generatedProject.id) {
        throw new Error(`Invalid Gateway app session project ${index} for room ${roomId}`)
    }
    return {
        id: session.id,
        title: session.title,
        createdAt: session.createdAt as number,
        updatedAt: session.updatedAt as number,
        matrixThreadRootEventId: typeof session.matrixThreadRootEventId === 'string'
            ? session.matrixThreadRootEventId
            : null,
        projectId: session.projectId,
        projectName: generatedProject.name,
        cwd: generatedProject.cwd,
        provider: session.provider,
        model: session.model as string | null,
        reasoningEffort: session.reasoningEffort as string | null,
        permissionMode: session.permissionMode,
        providerSessionId: session.providerSessionId as string | null,
        archivedAt: session.archivedAt as number | null,
        extensions: parseExtensionBindings(session.extensions, roomId, index),
    }
}

function parseExtensionBindings(
    value: unknown,
    roomId: string,
    sessionIndex: number,
): SessionExtensionBinding[] {
    if (!Array.isArray(value)) {
        throw new Error(`Invalid Gateway app session extensions ${sessionIndex} for room ${roomId}`)
    }
    const seen = new Set<string>()
    return value.map((entry, extensionIndex) => {
        const parsed = sessionExtensionBindingSchema.safeParse(entry)
        if (!parsed.success || seen.has(parsed.data.id)) {
            throw new Error(
                `Invalid Gateway app session extension ${extensionIndex} in session ${sessionIndex} for room ${roomId}`,
            )
        }
        seen.add(parsed.data.id)
        return structuredClone(parsed.data)
    })
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function requireVersionedRecord(value: unknown): VersionedState {
    const record = asRecord(value)
    if (!record || !Number.isSafeInteger(record.version)) {
        throw new Error('Invalid Gateway runtime state version')
    }
    return record as VersionedState
}

function isMissingFile(error: unknown): boolean {
    return asRecord(error)?.code === 'ENOENT'
}
