import { createOpaqueServerSetup } from '@codever/secure-channel'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface DeviceCredentialRecord {
    credentialId: string
    registrationRecord: string
    enabled: boolean
    label: string
    createdAt: string
    revokedAt?: string
}

export interface DeviceCredentialStore {
    get(credentialId: string): Promise<DeviceCredentialRecord | undefined>
    put(credentialId: string, registrationRecord: string, label?: string): Promise<DeviceCredentialRecord>
    revoke(credentialId: string): Promise<boolean>
}

interface DeviceCredentialSnapshot {
    formatVersion: 1
    serverSetup: string
    credentials: DeviceCredentialRecord[]
}

/** Durable Gateway-owned OPAQUE setup and device credential records. */
export class DeviceCredentialRepository implements DeviceCredentialStore {
    private writeQueue: Promise<void> = Promise.resolve()

    private constructor(
        private readonly path: string,
        private snapshot: DeviceCredentialSnapshot,
        private readonly now: () => number,
    ) {}

    static async open(path: string, options: { now?: () => number } = {}): Promise<DeviceCredentialRepository> {
        let snapshot: DeviceCredentialSnapshot
        try {
            snapshot = parseSnapshot(JSON.parse(await readFile(path, 'utf8')))
            await chmod(path, 0o600)
        } catch (error) {
            if (!isNotFound(error)) throw error
            snapshot = { formatVersion: 1, serverSetup: await createOpaqueServerSetup(), credentials: [] }
            const repository = new DeviceCredentialRepository(path, snapshot, options.now ?? Date.now)
            await repository.persist()
            return repository
        }
        return new DeviceCredentialRepository(path, snapshot, options.now ?? Date.now)
    }

    get serverSetup(): string {
        return this.snapshot.serverSetup
    }

    async get(credentialId: string): Promise<DeviceCredentialRecord | undefined> {
        const record = this.snapshot.credentials.find(value => value.credentialId === credentialId)
        return record && { ...record }
    }

    async list(): Promise<DeviceCredentialRecord[]> {
        return this.snapshot.credentials.map(record => ({ ...record }))
    }

    async put(credentialId: string, registrationRecord: string, label = credentialId): Promise<DeviceCredentialRecord> {
        assertRequired(credentialId, 'credentialId')
        assertRequired(registrationRecord, 'registrationRecord')
        assertRequired(label, 'label')

        const next: DeviceCredentialRecord = {
            credentialId,
            registrationRecord,
            enabled: true,
            label,
            createdAt: new Date(this.now()).toISOString(),
        }
        const index = this.snapshot.credentials.findIndex(value => value.credentialId === credentialId)
        if (index === -1) this.snapshot.credentials.push(next)
        else this.snapshot.credentials[index] = next
        await this.persist()
        return { ...next }
    }

    async revoke(credentialId: string): Promise<boolean> {
        assertRequired(credentialId, 'credentialId')
        const current = this.snapshot.credentials.find(value => value.credentialId === credentialId)
        if (!current || !current.enabled) return false
        current.enabled = false
        current.revokedAt = new Date(this.now()).toISOString()
        await this.persist()
        return true
    }

    private async persist(): Promise<void> {
        const content = `${JSON.stringify(this.snapshot, null, 2)}\n`
        const write = async () => this.writeAtomically(content)
        const pending = this.writeQueue.then(write, write)
        this.writeQueue = pending.catch(() => undefined)
        await pending
    }

    private async writeAtomically(content: string): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
        const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
        try {
            await writeFile(temporary, content, { mode: 0o600 })
            await chmod(temporary, 0o600)
            await rename(temporary, this.path)
            await chmod(this.path, 0o600)
        } catch (error) {
            await unlink(temporary).catch(() => undefined)
            throw error
        }
    }
}

function parseSnapshot(value: unknown): DeviceCredentialSnapshot {
    if (!isRecord(value) || value.formatVersion !== 1 || typeof value.serverSetup !== 'string'
        || !value.serverSetup.trim() || !Array.isArray(value.credentials)) {
        throw new Error('Invalid Gateway device credential repository')
    }

    const credentialIds = new Set<string>()
    const credentials = value.credentials.map(item => {
        if (!isRecord(item) || typeof item.credentialId !== 'string' || !item.credentialId.trim()
            || typeof item.registrationRecord !== 'string' || !item.registrationRecord.trim()
            || typeof item.enabled !== 'boolean' || typeof item.label !== 'string' || !item.label.trim()
            || typeof item.createdAt !== 'string' || !isTimestamp(item.createdAt)
            || (item.revokedAt !== undefined && (typeof item.revokedAt !== 'string' || !isTimestamp(item.revokedAt)))) {
            throw new Error('Invalid Gateway device credential')
        }
        if (credentialIds.has(item.credentialId)) throw new Error('Duplicate Gateway device credential')
        credentialIds.add(item.credentialId)
        return {
            credentialId: item.credentialId,
            registrationRecord: item.registrationRecord,
            enabled: item.enabled,
            label: item.label,
            createdAt: item.createdAt,
            ...(typeof item.revokedAt === 'string' ? { revokedAt: item.revokedAt } : {}),
        }
    })
    return { formatVersion: 1, serverSetup: value.serverSetup, credentials }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isTimestamp(value: string): boolean {
    return Number.isFinite(Date.parse(value))
}

function assertRequired(value: string, field: string): void {
    if (!value.trim()) throw new Error(`Gateway device credential ${field} is required`)
}

function isNotFound(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
