import { createOpaqueServerSetup } from '@codever/secure-channel'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { GatewayCredentialRecord, GatewayCredentialStore } from './secureGatewayAuth'

interface Snapshot {
    formatVersion: 1
    serverSetup: string
    gateways: Array<GatewayCredentialRecord & { createdAt: string; revokedAt?: string }>
}

export class SecureCredentialRepository implements GatewayCredentialStore {
    private constructor(private readonly path: string, private snapshot: Snapshot) {}

    static async open(path: string): Promise<SecureCredentialRepository> {
        let snapshot: Snapshot
        try {
            snapshot = parseSnapshot(JSON.parse(await readFile(path, 'utf8')))
            await chmod(path, 0o600)
        } catch (error) {
            if (!isNotFound(error)) throw error
            snapshot = { formatVersion: 1, serverSetup: await createOpaqueServerSetup(), gateways: [] }
            const repository = new SecureCredentialRepository(path, snapshot)
            await repository.persist()
            return repository
        }
        return new SecureCredentialRepository(path, snapshot)
    }

    get serverSetup(): string {
        return this.snapshot.serverSetup
    }

    async get(gatewayId: string): Promise<GatewayCredentialRecord | undefined> {
        const record = this.snapshot.gateways.find(value => value.gatewayId === gatewayId)
        return record && { gatewayId: record.gatewayId, registrationRecord: record.registrationRecord, enabled: record.enabled }
    }

    async put(gatewayId: string, registrationRecord: string): Promise<GatewayCredentialRecord> {
        if (!gatewayId.trim() || !registrationRecord.trim()) throw new Error('Gateway credential fields are required')
        const current = this.snapshot.gateways.find(value => value.gatewayId === gatewayId)
        const next = { gatewayId, registrationRecord, enabled: true, createdAt: new Date().toISOString() }
        if (current) Object.assign(current, next, { revokedAt: undefined })
        else this.snapshot.gateways.push(next)
        await this.persist()
        return { gatewayId, registrationRecord, enabled: true }
    }

    async revoke(gatewayId: string): Promise<boolean> {
        const current = this.snapshot.gateways.find(value => value.gatewayId === gatewayId)
        if (!current || !current.enabled) return false
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
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid secure credential repository')
    const input = value as Record<string, unknown>
    if (input.formatVersion !== 1 || typeof input.serverSetup !== 'string' || !Array.isArray(input.gateways)) {
        throw new Error('Invalid secure credential repository')
    }
    const gateways = input.gateways.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid Gateway secure credential')
        const record = item as Record<string, unknown>
        if (typeof record.gatewayId !== 'string' || typeof record.registrationRecord !== 'string'
            || typeof record.enabled !== 'boolean' || typeof record.createdAt !== 'string') {
            throw new Error('Invalid Gateway secure credential')
        }
        return {
            gatewayId: record.gatewayId,
            registrationRecord: record.registrationRecord,
            enabled: record.enabled,
            createdAt: record.createdAt,
            ...(typeof record.revokedAt === 'string' ? { revokedAt: record.revokedAt } : {}),
        }
    })
    return { formatVersion: 1, serverSetup: input.serverSetup, gateways }
}

function isNotFound(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
