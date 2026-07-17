import { createOpaqueServerSetup } from '@codever/secure-channel'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ClientCredentialRecord, ClientCredentialStore } from './secureClientAuth'

interface StoredClientCredential extends ClientCredentialRecord {
    createdAt: string
    revokedAt?: string
}

interface Snapshot {
    formatVersion: 1
    serverSetup: string
    clients: StoredClientCredential[]
}

export class ClientCredentialRepository implements ClientCredentialStore {
    private constructor(private readonly path: string, private snapshot: Snapshot) {}

    static async open(path: string): Promise<ClientCredentialRepository> {
        let snapshot: Snapshot
        try {
            snapshot = parseSnapshot(JSON.parse(await readFile(path, 'utf8')))
            await chmod(path, 0o600)
        } catch (error) {
            if (!isNotFound(error)) throw error
            snapshot = { formatVersion: 1, serverSetup: await createOpaqueServerSetup(), clients: [] }
            const repository = new ClientCredentialRepository(path, snapshot)
            await repository.persist()
            return repository
        }
        return new ClientCredentialRepository(path, snapshot)
    }

    get serverSetup(): string { return this.snapshot.serverSetup }

    async get(clientId: string): Promise<ClientCredentialRecord | undefined> {
        const record = this.snapshot.clients.find(value => value.clientId === clientId)
        return record && { clientId: record.clientId, registrationRecord: record.registrationRecord, enabled: record.enabled }
    }

    async put(clientId: string, registrationRecord: string): Promise<ClientCredentialRecord> {
        if (!clientId.trim() || !registrationRecord.trim()) throw new Error('Client credential fields are required')
        const current = this.snapshot.clients.find(value => value.clientId === clientId)
        const next: StoredClientCredential = {
            clientId, registrationRecord, enabled: true, createdAt: new Date().toISOString(),
        }
        if (current) Object.assign(current, next, { revokedAt: undefined })
        else this.snapshot.clients.push(next)
        await this.persist()
        return { clientId, registrationRecord, enabled: true }
    }

    async revoke(clientId: string): Promise<boolean> {
        const current = this.snapshot.clients.find(value => value.clientId === clientId)
        if (!current?.enabled) return false
        current.enabled = false
        current.revokedAt = new Date().toISOString()
        await this.persist()
        return true
    }

    private async persist(): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
        const temporary = `${this.path}.${process.pid}.tmp`
        await writeFile(temporary, `${JSON.stringify(this.snapshot, null, 2)}\n`, { mode: 0o600 })
        await rename(temporary, this.path)
        await chmod(this.path, 0o600)
    }
}

function parseSnapshot(value: unknown): Snapshot {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Client credential repository')
    const input = value as Record<string, unknown>
    if (input.formatVersion !== 1 || typeof input.serverSetup !== 'string' || !Array.isArray(input.clients)) {
        throw new Error('Invalid Client credential repository')
    }
    const clients = input.clients.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid Client credential')
        const record = item as Record<string, unknown>
        if (typeof record.clientId !== 'string' || typeof record.registrationRecord !== 'string'
            || typeof record.enabled !== 'boolean' || typeof record.createdAt !== 'string') {
            throw new Error('Invalid Client credential')
        }
        return {
            clientId: record.clientId,
            registrationRecord: record.registrationRecord,
            enabled: record.enabled,
            createdAt: record.createdAt,
            ...(typeof record.revokedAt === 'string' ? { revokedAt: record.revokedAt } : {}),
        }
    })
    return { formatVersion: 1, serverSetup: input.serverSetup, clients }
}

function isNotFound(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
