import { ExecutionAuthorizationError, type ExecutionReplayGuard, type ReplayDisposition, type ReplayRecord } from '@codever/execution-auth'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

interface ReplaySnapshot {
    formatVersion: 1
    records: ReplayRecord[]
}

export class FileExecutionReplayGuard implements ExecutionReplayGuard {
    private readonly records = new Map<string, ReplayRecord>()
    private writeQueue: Promise<void> = Promise.resolve()

    private constructor(private readonly path: string, private readonly now: () => number) {}

    static async open(path: string, options: { now?: () => number } = {}): Promise<FileExecutionReplayGuard> {
        const guard = new FileExecutionReplayGuard(resolve(path), options.now ?? Date.now)
        try {
            const snapshot = parseSnapshot(JSON.parse(await readFile(guard.path, 'utf8')))
            for (const record of snapshot.records) guard.records.set(record.tokenId, record)
        } catch (error) {
            if (!isNotFound(error)) throw error
        }
        return guard
    }

    async consume(record: ReplayRecord): Promise<ReplayDisposition> {
        return this.serialized(async () => {
            this.prune()
            const existing = this.records.get(record.tokenId)
            if (existing) {
                if (existing.requestHash !== record.requestHash) {
                    throw new ExecutionAuthorizationError('replay_conflict', 'The execution token was reused for another request')
                }
                return 'duplicate'
            }
            this.records.set(record.tokenId, { ...record })
            await this.persist()
            return 'first-seen'
        })
    }

    private prune(): void {
        const nowSeconds = Math.floor(this.now() / 1_000)
        for (const [tokenId, record] of this.records) {
            if (record.expiresAt < nowSeconds) this.records.delete(tokenId)
        }
    }

    private serialized<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.writeQueue.then(operation, operation)
        this.writeQueue = result.then(() => undefined, () => undefined)
        return result
    }

    private async persist(): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
        const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
        const handle = await open(temporary, 'w', 0o600)
        try {
            await handle.writeFile(`${JSON.stringify({ formatVersion: 1, records: [...this.records.values()] }, null, 2)}\n`)
            await handle.sync()
        } finally {
            await handle.close()
        }
        try {
            await rename(temporary, this.path)
        } catch (error) {
            await rm(temporary, { force: true })
            throw error
        }
    }
}

function parseSnapshot(value: unknown): ReplaySnapshot {
    if (!isRecord(value) || value.formatVersion !== 1 || !Array.isArray(value.records)) {
        throw new Error('Invalid Gateway execution replay repository')
    }
    const records = value.records.map(item => {
        if (!isRecord(item) || typeof item.tokenId !== 'string' || !item.tokenId
            || typeof item.requestHash !== 'string' || !item.requestHash
            || !Number.isSafeInteger(item.expiresAt)) {
            throw new Error('Invalid Gateway execution replay record')
        }
        return { tokenId: item.tokenId, requestHash: item.requestHash, expiresAt: item.expiresAt as number }
    })
    return { formatVersion: 1, records }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isNotFound(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
