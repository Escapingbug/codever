import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { canonicalJson, type CodeverCommand } from '@codever/protocol'
import { SecurityError, type ReplayClaim, type ReplayStore } from '@codever/security'

interface PersistedClaimBatch {
    version: 1
    claims: ReplayClaim[]
    sequence?: {
        scope: string
        value: number
    }
}

/**
 * Durable, append-only nonce/command ledger for a single gateway process.
 *
 * Claims are serialized and a complete claim batch is appended before success
 * is returned. Corruption fails closed during initialization.
 */
export class FileCommandReplayStore implements ReplayStore {
    private readonly claims = new Map<string, number>()
    private readonly sequences = new Map<string, number>()
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

    claimCommandInOrder(
        command: CodeverCommand,
        now: number,
        sequenceEpoch = 'legacy-v1',
    ): Promise<'accepted' | 'duplicate'> {
        const operation = this.chain.then(async () => {
            if (!this.initialized) await this.load()
            await this.pruneInternal(now)
            if (command.expiresAt <= now) {
                throw new SecurityError('expired', 'Expired commands cannot enter the replay store')
            }

            const scope = canonicalJson([
                command.gatewayId,
                command.deviceId,
                command.conversationId,
                sequenceEpoch,
            ])
            const nextClaims: ReplayClaim[] = [
                { key: `${scope}:nonce:${command.nonce}`, expiresAt: command.expiresAt },
                { key: `${scope}:command:${command.commandId}`, expiresAt: command.expiresAt },
            ]
            const existingClaims = nextClaims.filter(claim => this.claims.has(claim.key)).length
            const lastSequence = this.sequences.get(scope) ?? 0
            if (existingClaims === nextClaims.length && command.sequence <= lastSequence) {
                return 'duplicate' as const
            }
            if (existingClaims > 0) {
                throw new SecurityError('replay', 'Command nonce or command id has already been used')
            }
            const expected = lastSequence + 1
            if (command.sequence !== expected) {
                throw new SecurityError(
                    'sequence',
                    `Expected command sequence ${expected}, received ${command.sequence}`,
                )
            }

            const record: PersistedClaimBatch = {
                version: 1,
                claims: nextClaims,
                sequence: { scope, value: command.sequence },
            }
            await this.append(record)
            for (const claim of nextClaims) this.claims.set(claim.key, claim.expiresAt)
            this.sequences.set(scope, command.sequence)
            return 'accepted' as const
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
            if (value.sequence) {
                const existing = this.sequences.get(value.sequence.scope) ?? 0
                if (value.sequence.value <= existing) {
                    throw new Error(`Non-monotonic command sequence at line ${index + 1}`)
                }
                this.sequences.set(value.sequence.scope, value.sequence.value)
            }
        }
        this.initialized = true
    }

    private async pruneInternal(now: number): Promise<void> {
        for (const [key, expiresAt] of this.claims) {
            if (expiresAt <= now) this.claims.delete(key)
        }
    }

    private async append(record: PersistedClaimBatch): Promise<void> {
        await mkdir(dirname(this.filePath), { recursive: true })
        await appendFile(this.filePath, `${JSON.stringify(record)}\n`, 'utf8')
    }
}

function isPersistedClaimBatch(value: unknown): value is PersistedClaimBatch {
    if (!value || typeof value !== 'object') return false
    const record = value as Record<string, unknown>
    if (record.version !== 1 || !Array.isArray(record.claims)) return false
    const validClaims = record.claims.every((claim) => {
        if (!claim || typeof claim !== 'object') return false
        const item = claim as Record<string, unknown>
        return typeof item.key === 'string'
            && item.key.length > 0
            && typeof item.expiresAt === 'number'
            && Number.isSafeInteger(item.expiresAt)
            && item.expiresAt >= 0
    })
    if (!validClaims) return false
    if (record.sequence === undefined) return true
    if (!record.sequence || typeof record.sequence !== 'object') return false
    const sequence = record.sequence as Record<string, unknown>
    return typeof sequence.scope === 'string'
        && sequence.scope.length > 0
        && typeof sequence.value === 'number'
        && Number.isSafeInteger(sequence.value)
        && sequence.value > 0
}

function isMissingFile(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
