import {
    createCipheriv,
    createDecipheriv,
    createHash,
    createHmac,
    randomBytes,
    randomUUID,
} from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { canonicalMapping, mergeMappings } from './mapping.js'
import type { HasEngineIdentity, HasMapping } from './types.js'

interface EncryptedMappingVersion {
    contextHash: string
    mappingId: string
    version: number
    parentVersion: number | null
    keyId: string
    mappingDigest: string
    createdAt: string
    actorId: string
    engine: HasEngineIdentity
    iv: string
    ciphertext: string
    authTag: string
}

interface VaultState {
    formatVersion: 1
    versions: EncryptedMappingVersion[]
}

export class EncryptedMappingVault {
    private tail: Promise<void> = Promise.resolve()

    private constructor(
        private readonly path: string,
        private readonly key: Buffer,
        private readonly keyId: string,
        private state: VaultState,
    ) {}

    static async open(path: string, key: Uint8Array): Promise<EncryptedMappingVault> {
        if (key.byteLength !== 32) throw new Error('Mapping vault key must contain exactly 32 bytes')
        const target = resolve(path)
        let state: VaultState = { formatVersion: 1, versions: [] }
        try {
            const parsed = JSON.parse(await readFile(target, 'utf8')) as Partial<VaultState>
            if (parsed.formatVersion !== 1 || !Array.isArray(parsed.versions)) {
                throw new Error('unsupported vault format')
            }
            state = parsed as VaultState
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw new Error('Mapping vault cannot be loaded or authenticated')
            }
        }
        const bytes = Buffer.from(key)
        return new EncryptedMappingVault(
            target,
            bytes,
            sha256(bytes).slice(0, 24),
            state,
        )
    }

    async current(contextId: string): Promise<{ version: number; mapping: HasMapping }> {
        await this.tail
        const latest = this.versions(contextId).at(-1)
        return latest
            ? { version: latest.version, mapping: this.decrypt(latest) }
            : { version: 0, mapping: {} }
    }

    async get(contextId: string, version: number): Promise<HasMapping> {
        await this.tail
        if (version === 0) return {}
        const stored = this.versions(contextId).find(candidate => candidate.version === version)
        if (!stored) throw new Error('Mapping version does not exist in this privacy context')
        return this.decrypt(stored)
    }

    async commit(input: {
        contextId: string
        expectedVersion: number
        delta: HasMapping
        actorId: string
        engine: HasEngineIdentity
    }): Promise<number> {
        return await this.exclusive(async () => {
            const latest = this.versions(input.contextId).at(-1)
            const actualVersion = latest?.version ?? 0
            if (actualVersion !== input.expectedVersion) {
                throw new Error('Privacy preview is stale because the mapping changed')
            }
            if (Object.keys(canonicalMapping(input.delta)).length === 0) return actualVersion

            const parent = latest ? this.decrypt(latest) : {}
            const merged = mergeMappings(parent, input.delta)
            const plaintext = stableJson(merged)
            const contextHash = hashContext(input.contextId)
            const mappingId = latest?.mappingId ?? randomUUID()
            const version = actualVersion + 1
            const iv = randomBytes(12)
            const cipher = createCipheriv('aes-256-gcm', this.key, iv)
            cipher.setAAD(Buffer.from(aad(contextHash, mappingId, version), 'utf8'))
            const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
            const stored: EncryptedMappingVersion = {
                contextHash,
                mappingId,
                version,
                parentVersion: actualVersion || null,
                keyId: this.keyId,
                mappingDigest: mappingDigest(this.key, plaintext),
                createdAt: new Date().toISOString(),
                actorId: input.actorId,
                engine: structuredClone(input.engine),
                iv: iv.toString('base64'),
                ciphertext: ciphertext.toString('base64'),
                authTag: cipher.getAuthTag().toString('base64'),
            }
            const previous = this.state
            this.state = { ...this.state, versions: [...this.state.versions, stored] }
            try {
                await this.persist()
            } catch (error) {
                this.state = previous
                throw error
            }
            return version
        })
    }

    private versions(contextId: string): EncryptedMappingVersion[] {
        const contextHash = hashContext(contextId)
        return this.state.versions
            .filter(version => version.contextHash === contextHash)
            .sort((left, right) => left.version - right.version)
    }

    private decrypt(stored: EncryptedMappingVersion): HasMapping {
        try {
            if (stored.keyId !== this.keyId) throw new Error('vault key unavailable')
            const decipher = createDecipheriv(
                'aes-256-gcm',
                this.key,
                Buffer.from(stored.iv, 'base64'),
            )
            decipher.setAAD(Buffer.from(aad(
                stored.contextHash,
                stored.mappingId,
                stored.version,
            ), 'utf8'))
            decipher.setAuthTag(Buffer.from(stored.authTag, 'base64'))
            const plaintext = Buffer.concat([
                decipher.update(Buffer.from(stored.ciphertext, 'base64')),
                decipher.final(),
            ]).toString('utf8')
            const mapping = canonicalMapping(JSON.parse(plaintext) as HasMapping)
            if (mappingDigest(this.key, stableJson(mapping)) !== stored.mappingDigest) {
                throw new Error('mapping digest mismatch')
            }
            return mapping
        } catch {
            throw new Error('Mapping vault authentication failed')
        }
    }

    private async persist(): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
        const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`
        await writeFile(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 })
        await rename(temporary, this.path)
    }

    private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const predecessor = this.tail
        let release!: () => void
        this.tail = new Promise(resolve => { release = resolve })
        await predecessor
        try {
            return await operation()
        } finally {
            release()
        }
    }
}

function hashContext(contextId: string): string {
    return sha256(`codever-has-context-v1\0${contextId}`)
}

function aad(contextHash: string, mappingId: string, version: number): string {
    return `codever-has-vault-v1/${contextHash}/${mappingId}/${version}`
}

function stableJson(value: HasMapping): string {
    return JSON.stringify(canonicalMapping(value))
}

function sha256(value: string | Uint8Array): string {
    return createHash('sha256').update(value).digest('hex')
}

function mappingDigest(key: Uint8Array, value: string): string {
    return createHmac('sha256', key)
        .update(`codever-has-mapping-digest-v1\0${value}`)
        .digest('hex')
}
