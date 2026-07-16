import { open, mkdir, readFile, rename, rm, type FileHandle } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseCodeverSession, type CodeverSession } from '@codever/protocol'
import type { SessionMetadataRepository } from './types'

interface PersistedSessions {
    schemaVersion: 1
    sessions: CodeverSession[]
}

export class MemorySessionMetadataRepository implements SessionMetadataRepository {
    private readonly sessions = new Map<string, CodeverSession>()
    private queue: Promise<void> = Promise.resolve()

    constructor(initial: readonly CodeverSession[] = []) {
        for (const session of initial) this.sessions.set(session.id, cloneSession(parseCodeverSession(session)))
    }

    async list(projectId?: string): Promise<CodeverSession[]> {
        await this.queue
        return [...this.sessions.values()]
            .filter((session) => projectId === undefined || session.projectId === projectId)
            .map(cloneSession)
    }

    async get(sessionId: string): Promise<CodeverSession | undefined> {
        await this.queue
        const session = this.sessions.get(sessionId)
        return session ? cloneSession(session) : undefined
    }

    save(session: CodeverSession): Promise<CodeverSession> {
        return this.mutate(() => {
            const copy = cloneSession(parseCodeverSession(session))
            this.sessions.set(copy.id, copy)
            return cloneSession(copy)
        })
    }

    delete(sessionId: string): Promise<boolean> {
        return this.mutate(() => this.sessions.delete(sessionId))
    }

    async close(): Promise<void> {
        await this.queue
    }

    private mutate<T>(operation: () => T | Promise<T>): Promise<T> {
        const result = this.queue.then(operation)
        this.queue = result.then(() => undefined, () => undefined)
        return result
    }
}

/** Atomic JSON metadata repository with recovery from a completely-written temp file. */
export class FileSessionMetadataRepository implements SessionMetadataRepository {
    private sessions = new Map<string, CodeverSession>()
    private queue: Promise<void> = Promise.resolve()
    private initialization?: Promise<void>
    private closed = false
    private readonly filePath: string
    private readonly temporaryPath: string

    constructor(filePath: string) {
        this.filePath = resolve(filePath)
        this.temporaryPath = `${this.filePath}.tmp`
    }

    static async open(filePath: string): Promise<FileSessionMetadataRepository> {
        const repository = new FileSessionMetadataRepository(filePath)
        await repository.initialize()
        return repository
    }

    async list(projectId?: string): Promise<CodeverSession[]> {
        await this.queue
        await this.initialize()
        return [...this.sessions.values()]
            .filter((session) => projectId === undefined || session.projectId === projectId)
            .map(cloneSession)
    }

    async get(sessionId: string): Promise<CodeverSession | undefined> {
        await this.queue
        await this.initialize()
        const session = this.sessions.get(sessionId)
        return session ? cloneSession(session) : undefined
    }

    save(session: CodeverSession): Promise<CodeverSession> {
        return this.mutate(async () => {
            await this.initialize()
            const copy = cloneSession(parseCodeverSession(session))
            const next = new Map(this.sessions)
            next.set(copy.id, copy)
            await this.persist(next)
            this.sessions = next
            return cloneSession(copy)
        })
    }

    delete(sessionId: string): Promise<boolean> {
        return this.mutate(async () => {
            await this.initialize()
            if (!this.sessions.has(sessionId)) return false
            const next = new Map(this.sessions)
            next.delete(sessionId)
            await this.persist(next)
            this.sessions = next
            return true
        })
    }

    async close(): Promise<void> {
        await this.queue
        this.closed = true
    }

    private async initialize(): Promise<void> {
        if (this.closed) throw new Error('Session metadata repository is closed')
        this.initialization ??= this.load()
        await this.initialization
    }

    private async load(): Promise<void> {
        let recoveredTemporary = false
        const persisted = await readPersisted(this.filePath).catch(async (error: unknown) => {
            if (!isMissing(error)) throw error
            const recovered = await readPersisted(this.temporaryPath).catch((temporaryError: unknown) => {
                if (isMissing(temporaryError)) return undefined
                throw temporaryError
            })
            recoveredTemporary = recovered !== undefined
            return recovered
        })
        if (!persisted) return

        if (recoveredTemporary) {
            await mkdir(dirname(this.filePath), { recursive: true })
            await rename(this.temporaryPath, this.filePath)
            await syncDirectory(dirname(this.filePath))
        }
        this.sessions = new Map(persisted.sessions.map((session) => [session.id, cloneSession(session)]))
        await rm(this.temporaryPath, { force: true })
    }

    private async persist(sessions: ReadonlyMap<string, CodeverSession>): Promise<void> {
        await mkdir(dirname(this.filePath), { recursive: true })
        const value: PersistedSessions = { schemaVersion: 1, sessions: [...sessions.values()] }
        const body = `${JSON.stringify(value, null, 2)}\n`
        const handle = await open(this.temporaryPath, 'w')
        try {
            await handle.writeFile(body, 'utf8')
            await handle.sync()
        } finally {
            await handle.close()
        }
        await rename(this.temporaryPath, this.filePath)
        await syncDirectory(dirname(this.filePath))
    }

    private mutate<T>(operation: () => T | Promise<T>): Promise<T> {
        const result = this.queue.then(operation)
        this.queue = result.then(() => undefined, () => undefined)
        return result
    }
}

export { MemorySessionMetadataRepository as MemorySessionRepository }
export { FileSessionMetadataRepository as FileSessionRepository }

async function readPersisted(path: string): Promise<PersistedSessions> {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.sessions)) {
        throw new Error(`Invalid session metadata at ${path}`)
    }
    const sessions = value.sessions.map(parseCodeverSession)
    if (new Set(sessions.map((session) => session.id)).size !== sessions.length) {
        throw new Error(`Duplicate session IDs in metadata at ${path}`)
    }
    return { schemaVersion: 1, sessions }
}

function cloneSession(session: CodeverSession): CodeverSession {
    return structuredClone(session)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function isMissing(error: unknown): boolean {
    return isRecord(error) && error.code === 'ENOENT'
}

async function syncDirectory(directory: string): Promise<void> {
    let handle: FileHandle | undefined
    try {
        handle = await open(directory, 'r')
        await handle.sync()
    } catch (error) {
        if (process.platform !== 'win32') throw error
    } finally {
        await handle?.close()
    }
}
