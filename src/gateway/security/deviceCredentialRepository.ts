import { createOpaqueServerSetup, generateHpkeKeyPair, hpkeKeyId, type HpkeKeyPair } from '@codever/secure-channel'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface DeviceCredentialRecord {
    credentialId: string
    hpkePublicKey: string
    hpkeKeyId: string
    enabled: boolean
    label: string
    createdAt: string
    revokedAt?: string
}

export interface DeviceCredentialStore {
    get(credentialId: string): Promise<DeviceCredentialRecord | undefined>
    put(credentialId: string, hpkeKeyId: string, hpkePublicKey: string, label?: string): Promise<DeviceCredentialRecord>
    revoke(credentialId: string): Promise<boolean>
}

interface DeviceCredentialSnapshot {
    formatVersion: 2
    serverSetup: string
    hpkeKeyPair: HpkeKeyPair
    credentials: DeviceCredentialRecord[]
}

/** Durable Gateway pairing setup, HPKE identity, and authorized device public keys. */
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
            if (await hpkeKeyId(snapshot.hpkeKeyPair.publicKey) !== snapshot.hpkeKeyPair.keyId) {
                throw new Error('Gateway HPKE key ID does not match its public key')
            }
            await chmod(path, 0o600)
        } catch (error) {
            if (!isNotFound(error)) throw error
            snapshot = {
                formatVersion: 2,
                serverSetup: await createOpaqueServerSetup(),
                hpkeKeyPair: await generateHpkeKeyPair(),
                credentials: [],
            }
            const repository = new DeviceCredentialRepository(path, snapshot, options.now ?? Date.now)
            await repository.persist()
            return repository
        }
        return new DeviceCredentialRepository(path, snapshot, options.now ?? Date.now)
    }

    get serverSetup(): string {
        return this.snapshot.serverSetup
    }

    get hpkeKeyPair(): HpkeKeyPair {
        return { ...this.snapshot.hpkeKeyPair }
    }

    async get(credentialId: string): Promise<DeviceCredentialRecord | undefined> {
        const record = this.snapshot.credentials.find(value => value.credentialId === credentialId)
        return record && { ...record }
    }

    async list(): Promise<DeviceCredentialRecord[]> {
        return this.snapshot.credentials.map(record => ({ ...record }))
    }

    async put(credentialId: string, hpkeKeyId: string, hpkePublicKey: string, label = credentialId): Promise<DeviceCredentialRecord> {
        assertRequired(credentialId, 'credentialId')
        assertRequired(hpkeKeyId, 'hpkeKeyId')
        assertHpkePublicKey(hpkePublicKey)
        assertRequired(label, 'label')

        const next: DeviceCredentialRecord = {
            credentialId,
            hpkePublicKey,
            hpkeKeyId,
            enabled: true,
            label,
            createdAt: new Date(this.now()).toISOString(),
        }
        const existing = this.snapshot.credentials.find(value => value.credentialId === credentialId)
        if (existing) throw new Error('Gateway device credential ID is already registered')
        this.snapshot.credentials.push(next)
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
    if (!isRecord(value) || value.formatVersion !== 2 || typeof value.serverSetup !== 'string'
        || !value.serverSetup.trim() || !isHpkeKeyPair(value.hpkeKeyPair) || !Array.isArray(value.credentials)) {
        throw new Error('Invalid Gateway device credential repository')
    }

    const credentialIds = new Set<string>()
    const credentials = value.credentials.map(item => {
        if (!isRecord(item) || typeof item.credentialId !== 'string' || !item.credentialId.trim()
            || typeof item.hpkePublicKey !== 'string' || !isHpkePublicKey(item.hpkePublicKey)
            || typeof item.hpkeKeyId !== 'string' || !item.hpkeKeyId.trim()
            || typeof item.enabled !== 'boolean' || typeof item.label !== 'string' || !item.label.trim()
            || typeof item.createdAt !== 'string' || !isTimestamp(item.createdAt)
            || (item.revokedAt !== undefined && (typeof item.revokedAt !== 'string' || !isTimestamp(item.revokedAt)))) {
            throw new Error('Invalid Gateway device credential')
        }
        if (credentialIds.has(item.credentialId)) throw new Error('Duplicate Gateway device credential')
        credentialIds.add(item.credentialId)
        return {
            credentialId: item.credentialId,
            hpkePublicKey: item.hpkePublicKey,
            hpkeKeyId: item.hpkeKeyId,
            enabled: item.enabled,
            label: item.label,
            createdAt: item.createdAt,
            ...(typeof item.revokedAt === 'string' ? { revokedAt: item.revokedAt } : {}),
        }
    })
    return { formatVersion: 2, serverSetup: value.serverSetup, hpkeKeyPair: value.hpkeKeyPair, credentials }
}

function isHpkeKeyPair(value: unknown): value is HpkeKeyPair {
    return isRecord(value) && typeof value.keyId === 'string' && !!value.keyId.trim()
        && typeof value.publicKey === 'string' && isHpkePublicKey(value.publicKey)
        && typeof value.privateKey === 'string' && isHpkePublicKey(value.privateKey)
}

function isHpkePublicKey(value: string): boolean {
    return /^[A-Za-z0-9_-]{43}$/.test(value)
}

function assertHpkePublicKey(value: string): void {
    if (!isHpkePublicKey(value)) throw new Error('Gateway device credential HPKE public key is invalid')
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
