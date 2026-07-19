import { executionKeyId, type JWK } from '@codever/execution-auth'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface ExecutionTrustRecord {
    keyId: string
    ownerId: string
    label: string
    publicKey: JWK
    enabled: boolean
    createdAt: string
    revokedAt?: string
}

interface TrustSnapshot {
    formatVersion: 1
    roots: ExecutionTrustRecord[]
}

/** Gateway-local trust anchors. Matrix account/device state cannot modify this file. */
export class ExecutionTrustRepository {
    private writeQueue: Promise<void> = Promise.resolve()

    private constructor(
        private readonly path: string,
        private snapshot: TrustSnapshot,
        private readonly now: () => number,
    ) {}

    static async open(path: string, options: { now?: () => number } = {}): Promise<ExecutionTrustRepository> {
        let snapshot: TrustSnapshot = { formatVersion: 1, roots: [] }
        try {
            snapshot = parseSnapshot(JSON.parse(await readFile(path, 'utf8')))
            await chmod(path, 0o600)
        } catch (error) {
            if (!isNotFound(error)) throw error
        }
        return new ExecutionTrustRepository(path, snapshot, options.now ?? Date.now)
    }

    async resolve(keyId: string): Promise<JWK | undefined> {
        const record = this.snapshot.roots.find(value => value.keyId === keyId && value.enabled)
        return record ? structuredClone(record.publicKey) : undefined
    }

    async list(): Promise<ExecutionTrustRecord[]> {
        return structuredClone(this.snapshot.roots)
    }

    async trust(ownerId: string, publicKey: JWK, label = ownerId): Promise<ExecutionTrustRecord> {
        assertRequired(ownerId, 'ownerId')
        assertRequired(label, 'label')
        const keyId = await executionKeyId(publicKey)
        if (publicKey.kty !== 'EC' || publicKey.crv !== 'P-256' || publicKey.alg !== 'ES256' || publicKey.d !== undefined) {
            throw new Error('Gateway execution trust anchor must be a public ES256 P-256 key')
        }
        const existing = this.snapshot.roots.find(value => value.keyId === keyId)
        if (existing) {
            if (existing.enabled) return structuredClone(existing)
            throw new Error('Gateway execution trust anchor was revoked and cannot be silently re-enabled')
        }
        const record: ExecutionTrustRecord = {
            keyId,
            ownerId,
            label,
            publicKey: structuredClone(publicKey),
            enabled: true,
            createdAt: new Date(this.now()).toISOString(),
        }
        this.snapshot.roots.push(record)
        await this.persist()
        return structuredClone(record)
    }

    async revoke(keyId: string): Promise<boolean> {
        const record = this.snapshot.roots.find(value => value.keyId === keyId)
        if (!record?.enabled) return false
        record.enabled = false
        record.revokedAt = new Date(this.now()).toISOString()
        await this.persist()
        return true
    }

    private async persist(): Promise<void> {
        const content = `${JSON.stringify(this.snapshot, null, 2)}\n`
        const write = async () => writeAtomically(this.path, content)
        const pending = this.writeQueue.then(write, write)
        this.writeQueue = pending.catch(() => undefined)
        await pending
    }
}

function parseSnapshot(value: unknown): TrustSnapshot {
    if (!isRecord(value) || value.formatVersion !== 1 || !Array.isArray(value.roots)) {
        throw new Error('Invalid Gateway execution trust repository')
    }
    const ids = new Set<string>()
    const roots = value.roots.map(item => {
        if (!isRecord(item) || typeof item.keyId !== 'string' || !item.keyId
            || typeof item.ownerId !== 'string' || !item.ownerId || typeof item.label !== 'string' || !item.label
            || !isRecord(item.publicKey) || item.publicKey.kty !== 'EC' || item.publicKey.crv !== 'P-256'
            || item.publicKey.alg !== 'ES256' || item.publicKey.d !== undefined
            || typeof item.enabled !== 'boolean' || typeof item.createdAt !== 'string'
            || !Number.isFinite(Date.parse(item.createdAt))
            || (item.revokedAt !== undefined && (typeof item.revokedAt !== 'string' || !Number.isFinite(Date.parse(item.revokedAt))))) {
            throw new Error('Invalid Gateway execution trust anchor')
        }
        if (ids.has(item.keyId)) throw new Error('Duplicate Gateway execution trust anchor')
        ids.add(item.keyId)
        return structuredClone(item) as unknown as ExecutionTrustRecord
    })
    return { formatVersion: 1, roots }
}

async function writeAtomically(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    try {
        await writeFile(temporary, content, { mode: 0o600 })
        await chmod(temporary, 0o600)
        await rename(temporary, path)
        await chmod(path, 0o600)
    } catch (error) {
        await unlink(temporary).catch(() => undefined)
        throw error
    }
}

function assertRequired(value: string, name: string): void {
    if (!value.trim()) throw new Error(`Gateway execution trust ${name} is required`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isNotFound(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
