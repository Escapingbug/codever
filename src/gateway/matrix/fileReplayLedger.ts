import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ReplayClaim, ReplayStore } from '@codever/security'

interface PersistedClaimBatch {
    version: 1
    claims: ReplayClaim[]
}

/**
 * Durable, append-only nonce/command ledger for a single gateway process.
 *
 * Claims are serialized and a complete claim batch is appended before success
 * is returned. Corruption fails closed during initialization.
 */
export class FileCommandReplayStore implements ReplayStore {
    private readonly claims = new Map<string, number>()
    private initialized = false
    private chain: Promise<unknown> = Promise.resolve()

    constructor(private readonly filePath: string) {}

    initialize(now = Date.now()): Promise<void> {
        const operation = this.chain.then(async () => {
            if (!this.initialized) await this.load()
            await this.pruneInternal(now)
        })
        this.chain = operation.then(() => undefined, () => undefined)
        return operation
    }

    claimAll(nextClaims: readonly ReplayClaim[], now: number): Promise<boolean> {
        const operation = this.chain.then(async () => {
            if (!this.initialized) await this.load()
            await this.pruneInternal(now)
            if (nextClaims.some(claim => this.claims.has(claim.key))) return false

            const uniqueKeys = new Set(nextClaims.map(claim => claim.key))
            if (uniqueKeys.size !== nextClaims.length) return false
            const record: PersistedClaimBatch = {
                version: 1,
                claims: nextClaims.map(claim => ({ ...claim })),
            }
            await mkdir(dirname(this.filePath), { recursive: true })
            await appendFile(this.filePath, `${JSON.stringify(record)}\n`, 'utf8')
            for (const claim of nextClaims) this.claims.set(claim.key, claim.expiresAt)
            return true
        })
        this.chain = operation.then(() => undefined, () => undefined)
        return operation
    }

    prune(now: number): Promise<void> {
        const operation = this.chain.then(async () => {
            if (!this.initialized) await this.load()
            await this.pruneInternal(now)
        })
        this.chain = operation.then(() => undefined, () => undefined)
        return operation
    }

    private async load(): Promise<void> {
        let text: string
        try {
            text = await readFile(this.filePath, 'utf8')
        } catch (error) {
            if (isMissingFile(error)) {
                this.initialized = true
                return
            }
            throw error
        }

        const lines = text.split(/\r?\n/)
        for (let index = 0; index < lines.length; index++) {
            const line = lines[index]
            if (!line.trim()) continue
            let value: unknown
            try {
                value = JSON.parse(line)
            } catch {
                throw new Error(`Corrupt command replay ledger at line ${index + 1}`)
            }
            if (!isPersistedClaimBatch(value)) {
                throw new Error(`Invalid command replay ledger entry at line ${index + 1}`)
            }
            for (const claim of value.claims) {
                const existing = this.claims.get(claim.key)
                this.claims.set(claim.key, Math.max(existing ?? 0, claim.expiresAt))
            }
        }
        this.initialized = true
    }

    private async pruneInternal(now: number): Promise<void> {
        for (const [key, expiresAt] of this.claims) {
            if (expiresAt <= now) this.claims.delete(key)
        }
    }
}

function isPersistedClaimBatch(value: unknown): value is PersistedClaimBatch {
    if (!value || typeof value !== 'object') return false
    const record = value as Record<string, unknown>
    if (record.version !== 1 || !Array.isArray(record.claims)) return false
    return record.claims.every((claim) => {
        if (!claim || typeof claim !== 'object') return false
        const item = claim as Record<string, unknown>
        return typeof item.key === 'string'
            && item.key.length > 0
            && typeof item.expiresAt === 'number'
            && Number.isSafeInteger(item.expiresAt)
            && item.expiresAt >= 0
    })
}

function isMissingFile(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
