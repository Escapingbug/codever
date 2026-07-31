import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson, type CodeverCommand } from '@codever/protocol'
import { SecurityError, type ReplayClaim, type ReplayStore } from '@codever/security'

interface PersistedClaimBatch {
    version: 1
    claims: ReplayClaim[]
    sequence?: {
        scope: string
        value: number
    }
    revision?: {
        scope: string
        value: number
        commandKey: string
        commandSequence?: number
        commandNonceKey?: string
        commandBaseRevision?: number
        commandFingerprint?: string
    }
}

interface PersistedCommandOutcome {
    revision: number
    sequence: number | undefined
    nonceKey: string | undefined
    baseRevision: number | undefined
    fingerprint: string | undefined
}

interface PersistedLedgerGeneration {
    version: 1
    kind: 'generation'
    generation: string
}

export interface CommandClaimResult {
    status: 'accepted' | 'duplicate'
    revision: number
}

export class RevisionConflictError extends SecurityError {
    constructor(
        readonly expectedRevision: number,
        readonly receivedBaseRevision: number,
    ) {
        super(
            'revision_conflict',
            `Expected base revision ${expectedRevision}, received ${receivedBaseRevision}`,
        )
        this.name = 'RevisionConflictError'
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
    private readonly revisions = new Map<string, number>()
    private readonly commandOutcomes = new Map<string, PersistedCommandOutcome>()
    private initialized = false
    private generation: string | null = null
    private chain: Promise<unknown> = Promise.resolve()

    constructor(private readonly filePath: string) {}

    initialize(now = Date.now()): Promise<void> {
        const operation = this.chain.then(async () => {
            if (!this.initialized) await this.load()
            await this.pruneInternal(now)
            if (!this.generation) throw new Error('Command replay ledger generation is unavailable')
        })
        this.chain = operation.then(() => undefined, () => undefined)
        return operation
    }

    getGeneration(): string {
        if (!this.initialized || !this.generation) {
            throw new Error('Command replay ledger is not initialized')
        }
        return this.generation
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
            await this.append(record)
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
    ): Promise<CommandClaimResult> {
        const operation = this.chain.then(async () => {
            if (!this.initialized) await this.load()
            await this.pruneInternal(now)

            const scope = canonicalJson([
                command.gatewayId,
                command.deviceId,
                command.conversationId,
                command.revisionEpoch,
                sequenceEpoch,
            ])
            const revisionScope = conversationRevisionScope(
                command.gatewayId,
                command.conversationId,
                command.revisionEpoch,
            )
            const nextClaims: ReplayClaim[] = [
                { key: `${scope}:nonce:${command.nonce}`, expiresAt: command.expiresAt },
                { key: `${scope}:command:${command.commandId}`, expiresAt: command.expiresAt },
            ]
            const nonceKey = nextClaims[0]?.key
            const commandKey = nextClaims[1]?.key
            if (!nonceKey || !commandKey) throw new Error('Command replay claim is missing')
            const fingerprint = commandFingerprint(command)
            const priorOutcome = this.commandOutcomes.get(commandKey)
            if (priorOutcome) {
                if (
                    priorOutcome.sequence === command.sequence
                    && priorOutcome.nonceKey === nonceKey
                    && priorOutcome.baseRevision === command.baseRevision
                    && (
                        priorOutcome.fingerprint === undefined
                        || priorOutcome.fingerprint === fingerprint
                    )
                ) {
                    return {
                        status: 'duplicate' as const,
                        revision: priorOutcome.revision,
                    }
                }
                throw new SecurityError(
                    'replay',
                    'Accepted command id does not match its durable execution record',
                )
            }
            if (command.expiresAt <= now) {
                throw new SecurityError(
                    'expired',
                    'Unknown expired commands cannot enter the replay store',
                )
            }
            const existingClaims = nextClaims.filter(claim => this.claims.has(claim.key)).length
            const lastSequence = this.sequences.get(scope) ?? 0
            if (existingClaims === nextClaims.length && command.sequence <= lastSequence) {
                throw new Error('Accepted command is missing its persisted execution outcome')
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
            const currentRevision = this.revisions.get(revisionScope) ?? 0
            if (command.baseRevision !== currentRevision) {
                throw new RevisionConflictError(currentRevision, command.baseRevision)
            }
            const revision = currentRevision + 1

            const record: PersistedClaimBatch = {
                version: 1,
                claims: nextClaims,
                sequence: { scope, value: command.sequence },
                revision: {
                    scope: revisionScope,
                    value: revision,
                    commandKey,
                    commandSequence: command.sequence,
                    commandNonceKey: nonceKey,
                    commandBaseRevision: command.baseRevision,
                    commandFingerprint: fingerprint,
                },
            }
            await this.append(record)
            for (const claim of nextClaims) this.claims.set(claim.key, claim.expiresAt)
            this.sequences.set(scope, command.sequence)
            this.revisions.set(revisionScope, revision)
            this.commandOutcomes.set(commandKey, {
                revision,
                sequence: command.sequence,
                nonceKey,
                baseRevision: command.baseRevision,
                fingerprint,
            })
            return { status: 'accepted' as const, revision }
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

    getConversationRevision(
        gatewayId: string,
        conversationId: string,
        revisionEpoch: string,
    ): Promise<number> {
        const operation = this.chain.then(async () => {
            if (!this.initialized) await this.load()
            return this.revisions.get(
                conversationRevisionScope(gatewayId, conversationId, revisionEpoch),
            ) ?? 0
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
                await this.createGeneration()
                this.initialized = true
                return
            }
            throw error
        }

        const lines = text.split(/\r?\n/)
        let generationEntries = 0
        for (let index = 0; index < lines.length; index++) {
            const line = lines[index]
            if (!line.trim()) continue
            let value: unknown
            try {
                value = JSON.parse(line)
            } catch {
                throw new Error(`Corrupt command replay ledger at line ${index + 1}`)
            }
            if (isPersistedLedgerGeneration(value)) {
                generationEntries += 1
                if (generationEntries > 1) {
                    throw new Error(`Duplicate command replay ledger generation at line ${index + 1}`)
                }
                this.generation = value.generation
                continue
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
            if (value.revision) {
                const existing = this.revisions.get(value.revision.scope) ?? 0
                if (value.revision.value !== existing + 1) {
                    throw new Error(`Non-contiguous conversation revision at line ${index + 1}`)
                }
                this.revisions.set(value.revision.scope, value.revision.value)
                const legacyNonceKey = value.claims.find(
                    claim => claim.key !== value.revision?.commandKey,
                )?.key
                this.commandOutcomes.set(value.revision.commandKey, {
                    revision: value.revision.value,
                    sequence:
                        value.revision.commandSequence
                        ?? value.sequence?.value,
                    nonceKey:
                        value.revision.commandNonceKey
                        ?? legacyNonceKey,
                    baseRevision:
                        value.revision.commandBaseRevision
                        ?? value.revision.value - 1,
                    fingerprint: value.revision.commandFingerprint,
                })
            }
        }
        if (!this.generation) await this.createGeneration()
        this.initialized = true
    }

    private async pruneInternal(now: number): Promise<void> {
        for (const [key, expiresAt] of this.claims) {
            if (expiresAt <= now) this.claims.delete(key)
        }
    }

    private async createGeneration(): Promise<void> {
        const generation = randomUUID()
        await this.append({
            version: 1,
            kind: 'generation',
            generation,
        })
        this.generation = generation
    }

    private async append(record: PersistedClaimBatch | PersistedLedgerGeneration): Promise<void> {
        await mkdir(dirname(this.filePath), { recursive: true })
        const handle = await open(this.filePath, 'a')
        try {
            await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
            await handle.sync()
        } finally {
            await handle.close()
        }
    }
}

function isPersistedLedgerGeneration(value: unknown): value is PersistedLedgerGeneration {
    if (!value || typeof value !== 'object') return false
    const record = value as Record<string, unknown>
    return record.version === 1
        && record.kind === 'generation'
        && typeof record.generation === 'string'
        && record.generation.length > 0
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
    if (record.sequence !== undefined) {
        if (!record.sequence || typeof record.sequence !== 'object') return false
        const sequence = record.sequence as Record<string, unknown>
        if (!(typeof sequence.scope === 'string'
        && sequence.scope.length > 0
        && typeof sequence.value === 'number'
        && Number.isSafeInteger(sequence.value)
        && sequence.value > 0)) return false
    }
    if (record.revision !== undefined) {
        if (!record.revision || typeof record.revision !== 'object') return false
        const revision = record.revision as Record<string, unknown>
        if (!(typeof revision.scope === 'string'
            && revision.scope.length > 0
            && typeof revision.value === 'number'
            && Number.isSafeInteger(revision.value)
            && revision.value > 0
            && typeof revision.commandKey === 'string'
            && revision.commandKey.length > 0)) return false
        if (
            revision.commandSequence !== undefined
            && !(
                typeof revision.commandSequence === 'number'
                && Number.isSafeInteger(revision.commandSequence)
                && revision.commandSequence > 0
            )
        ) return false
        if (
            revision.commandNonceKey !== undefined
            && !(
                typeof revision.commandNonceKey === 'string'
                && revision.commandNonceKey.length > 0
            )
        ) return false
        if (
            revision.commandBaseRevision !== undefined
            && !(
                typeof revision.commandBaseRevision === 'number'
                && Number.isSafeInteger(revision.commandBaseRevision)
                && revision.commandBaseRevision >= 0
            )
        ) return false
        if (
            revision.commandFingerprint !== undefined
            && !(
                typeof revision.commandFingerprint === 'string'
                && revision.commandFingerprint.length > 0
            )
        ) return false
    }
    return true
}

function isMissingFile(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function conversationRevisionScope(
    gatewayId: string,
    conversationId: string,
    revisionEpoch: string,
): string {
    return canonicalJson([gatewayId, conversationId, revisionEpoch])
}

function commandFingerprint(command: CodeverCommand): string {
    return createHash('sha256')
        .update('codever-command-recovery:v1\0')
        .update(canonicalJson(command))
        .digest('hex')
}
