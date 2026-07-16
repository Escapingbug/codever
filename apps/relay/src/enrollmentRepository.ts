import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
    parseGatewayEnrollmentDto,
    serializeGatewayAuthPayload,
    type EnrolledGatewayKeyDto,
    type GatewayEnrollmentChallengeDto,
    type GatewayEnrollmentDto,
    type GatewayEnrollmentIdentity,
    type GatewayEnrollmentProofDto,
    type RelayAuthChallenge,
} from '@codever/protocol'
import type { EnrolledGatewayKey, EnrolledGatewayKeyRepository } from './auth'

const FORMAT_VERSION = 1
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

interface PendingRecord extends GatewayEnrollmentDto {
    publicKeySpkiPem: string
}

interface EnrolledRecord extends EnrolledGatewayKeyDto {
    publicKeySpkiPem: string
}

interface Snapshot {
    formatVersion: 1
    bootstrapComplete: boolean
    enrollments: PendingRecord[]
    gateways: EnrolledRecord[]
}

export interface EnrollmentRepositoryOptions {
    path?: string
    initialGateways?: EnrolledGatewayKey[]
    now?: () => Date
    code?: () => string
}

export class GatewayEnrollmentRepository implements EnrolledGatewayKeyRepository {
    private tail = Promise.resolve()

    private constructor(
        private snapshot: Snapshot,
        private readonly options: EnrollmentRepositoryOptions,
    ) {}

    static async open(options: EnrollmentRepositoryOptions = {}): Promise<GatewayEnrollmentRepository> {
        let snapshot = emptySnapshot()
        if (options.path) {
            try {
                snapshot = parseSnapshot(JSON.parse(await readFile(options.path, 'utf8')))
            } catch (error) {
                if (!isNotFound(error)) throw new Error(`Unable to read Gateway enrollment state at ${options.path}`, { cause: error })
            }
        }
        const repository = new GatewayEnrollmentRepository(snapshot, options)
        if (options.initialGateways?.length) await repository.importStatic(options.initialGateways)
        return repository
    }

    get bootstrapComplete(): boolean {
        return this.snapshot.bootstrapComplete
    }

    async get(gatewayId: string, fingerprint: string): Promise<EnrolledGatewayKey | undefined> {
        const value = this.snapshot.gateways.find(item => item.gatewayId === gatewayId && item.fingerprint === fingerprint)
        return value && { gatewayId, fingerprint, publicKey: value.publicKeySpkiPem, enabled: value.enabled && !value.revokedAt }
    }

    async findEnrolled(gatewayId: string, fingerprint: string): Promise<EnrolledGatewayKeyDto | undefined> {
        const value = this.snapshot.gateways.find(item => item.gatewayId === gatewayId && item.fingerprint === fingerprint)
        return value && publicGateway(value)
    }

    async listEnrolled(workspaceId?: string): Promise<EnrolledGatewayKeyDto[]> {
        return this.snapshot.gateways.filter(value => !workspaceId || value.workspaceId === workspaceId).map(publicGateway)
    }

    async createPending(identity: GatewayEnrollmentIdentity, ttlMs: number): Promise<GatewayEnrollmentDto> {
        validatePublicIdentity(identity)
        return this.mutate(draft => {
            expire(draft, this.now())
            const enrolled = draft.gateways.find(value => value.gatewayId === identity.gatewayId && value.fingerprint === identity.fingerprint && value.enabled && !value.revokedAt)
            if (enrolled) return approvedProjection(identity, enrolled)
            const conflicting = draft.gateways.find(value => value.gatewayId === identity.gatewayId && value.fingerprint !== identity.fingerprint && value.enabled && !value.revokedAt)
            if (conflicting) throw new EnrollmentConflictError('Gateway ID is already enrolled with a different key')
            const existing = draft.enrollments.find(value => value.gatewayId === identity.gatewayId && value.fingerprint === identity.fingerprint && value.status === 'pending')
            if (existing) return publicEnrollment(existing)
            const now = this.now()
            const record: PendingRecord = {
                enrollmentId: randomUUID(),
                code: uniqueCode(draft, this.options.code),
                gatewayId: identity.gatewayId,
                workspaceId: identity.workspaceId,
                name: identity.name,
                platform: identity.platform,
                fingerprint: identity.fingerprint,
                publicKeySpkiPem: identity.publicKeySpkiPem,
                status: 'pending',
                createdAt: now.toISOString(),
                expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
            }
            draft.enrollments.push(record)
            return publicEnrollment(record)
        })
    }

    async listPending(workspaceId?: string): Promise<GatewayEnrollmentDto[]> {
        await this.expirePending()
        return this.snapshot.enrollments
            .filter(value => value.status === 'pending' && (!workspaceId || value.workspaceId === workspaceId))
            .map(publicEnrollment)
    }

    async getByCode(code: string): Promise<GatewayEnrollmentDto | undefined> {
        await this.expirePending()
        const value = this.snapshot.enrollments.find(item => item.code === code)
        return value && publicEnrollment(value)
    }

    async approve(code: string, actor: 'local' | 'client', expected?: { workspaceId?: string; fingerprint?: string; name?: string; platform?: string }): Promise<GatewayEnrollmentDto> {
        return this.mutate(draft => {
            expire(draft, this.now())
            if (actor === 'client' && !draft.bootstrapComplete) throw new BootstrapRequiredError()
            const record = draft.enrollments.find(value => value.code === code)
            if (!record || record.status !== 'pending') throw new EnrollmentNotFoundError()
            if (expected?.workspaceId && record.workspaceId !== expected.workspaceId) throw new EnrollmentNotFoundError()
            if (expected?.fingerprint && record.fingerprint !== expected.fingerprint) throw new EnrollmentConflictError('Gateway fingerprint changed; approval refused')
            if (expected?.name && record.name !== expected.name) throw new EnrollmentConflictError('Gateway name changed; approval refused')
            if (expected?.platform && record.platform !== expected.platform) throw new EnrollmentConflictError('Gateway platform changed; approval refused')
            const now = this.now().toISOString()
            const enrolled: EnrolledRecord = {
                gatewayId: record.gatewayId,
                workspaceId: record.workspaceId,
                name: record.name,
                platform: record.platform,
                fingerprint: record.fingerprint,
                publicKeySpkiPem: record.publicKeySpkiPem,
                enabled: true,
                enrolledAt: now,
            }
            draft.gateways = draft.gateways.filter(value => !(value.gatewayId === enrolled.gatewayId && value.fingerprint === enrolled.fingerprint))
            draft.gateways.push(enrolled)
            record.status = 'approved'
            record.approvedAt = now
            delete record.code
            if (actor === 'local') draft.bootstrapComplete = true
            return publicEnrollment(record)
        })
    }

    async reject(code: string, reason?: string, workspaceId?: string): Promise<GatewayEnrollmentDto> {
        return this.mutate(draft => {
            expire(draft, this.now())
            const record = draft.enrollments.find(value => value.code === code && (!workspaceId || value.workspaceId === workspaceId))
            if (!record || record.status !== 'pending') throw new EnrollmentNotFoundError()
            record.status = 'rejected'
            record.rejectedAt = this.now().toISOString()
            record.rejectionReason = reason ?? 'Rejected by administrator'
            delete record.code
            return publicEnrollment(record)
        })
    }

    async revoke(gatewayId: string, workspaceId?: string): Promise<EnrolledGatewayKeyDto> {
        return this.mutate(draft => {
            const record = draft.gateways.find(value => value.gatewayId === gatewayId && (!workspaceId || value.workspaceId === workspaceId) && value.enabled && !value.revokedAt)
            if (!record) throw new EnrollmentNotFoundError('Enrolled Gateway not found')
            record.enabled = false
            record.revokedAt = this.now().toISOString()
            return publicGateway(record)
        })
    }

    async resetBootstrap(confirm: string): Promise<void> {
        if (confirm !== 'RESET-GATEWAY-BOOTSTRAP') throw new EnrollmentConflictError('Exact confirmation RESET-GATEWAY-BOOTSTRAP is required')
        await this.mutate(draft => { draft.bootstrapComplete = false })
    }

    private async importStatic(keys: EnrolledGatewayKey[]): Promise<void> {
        await this.mutate(draft => {
            for (const key of keys) {
                const publicKeySpkiPem = typeof key.publicKey === 'string'
                    ? key.publicKey
                    : key.publicKey.export({ type: 'spki', format: 'pem' }).toString()
                if (draft.gateways.some(value => value.gatewayId === key.gatewayId && value.fingerprint === key.fingerprint)) continue
                draft.gateways.push({
                    gatewayId: key.gatewayId,
                    workspaceId: 'default',
                    name: key.gatewayId,
                    platform: 'unknown',
                    fingerprint: key.fingerprint,
                    publicKeySpkiPem,
                    enabled: key.enabled,
                    enrolledAt: this.now().toISOString(),
                })
            }
            if (keys.some(key => key.enabled)) draft.bootstrapComplete = true
        })
    }

    private async expirePending(): Promise<void> {
        if (!this.snapshot.enrollments.some(value => value.status === 'pending' && Date.parse(value.expiresAt) <= this.now().getTime())) return
        await this.mutate(draft => { expire(draft, this.now()) })
    }

    private mutate<T>(operation: (draft: Snapshot) => T): Promise<T> {
        const run = this.tail.then(async () => {
            const draft = structuredClone(this.snapshot)
            const result = operation(draft)
            parseSnapshot(draft)
            if (this.options.path) await atomicWriteJson(this.options.path, draft)
            this.snapshot = draft
            return result
        })
        this.tail = run.then(() => undefined, () => undefined)
        return run
    }

    private now(): Date { return this.options.now?.() ?? new Date() }
}

export interface EnrollmentChallengeStoreOptions {
    relayId: string
    challengeTtlMs?: number
    maxAttemptsPerMinute?: number
    now?: () => Date
}

interface ChallengeRecord { identity: GatewayEnrollmentIdentity; challenge: RelayAuthChallenge; attempts: number }

export class EnrollmentChallengeStore {
    private readonly challenges = new Map<string, ChallengeRecord>()
    private readonly attemptWindows = new Map<string, number[]>()

    constructor(private readonly repository: GatewayEnrollmentRepository, private readonly options: EnrollmentChallengeStoreOptions) {}

    issue(identity: GatewayEnrollmentIdentity, remoteAddress: string): GatewayEnrollmentChallengeDto {
        this.rateLimit(remoteAddress)
        validatePublicIdentity(identity)
        const now = this.now()
        const enrollmentId = randomUUID()
        const challenge: RelayAuthChallenge = {
            relayId: this.options.relayId,
            challengeId: randomUUID(),
            nonce: randomBytes(32).toString('base64url'),
            issuedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + (this.options.challengeTtlMs ?? 30_000)).toISOString(),
        }
        this.challenges.set(enrollmentId, { identity, challenge, attempts: 0 })
        return { enrollmentId, challenge }
    }

    async prove(proof: GatewayEnrollmentProofDto, pendingTtlMs: number, remoteAddress: string): Promise<GatewayEnrollmentDto> {
        this.rateLimit(remoteAddress)
        const record = this.challenges.get(proof.enrollmentId)
        if (!record || record.attempts >= 3) throw new EnrollmentNotFoundError('Enrollment challenge not found or exhausted')
        record.attempts += 1
        if (Date.parse(record.challenge.expiresAt) <= this.now().getTime()) {
            this.challenges.delete(proof.enrollmentId)
            throw new EnrollmentExpiredError('Enrollment challenge expired')
        }
        if (proof.gatewayId !== record.identity.gatewayId || proof.fingerprint !== record.identity.fingerprint) {
            throw new EnrollmentConflictError('Enrollment proof identity mismatch')
        }
        const valid = verify('sha256', serializeGatewayAuthPayload(record.challenge, proof.gatewayId, proof.fingerprint), record.identity.publicKeySpkiPem, Buffer.from(proof.signature, 'base64url'))
        if (!valid) throw new EnrollmentConflictError('Enrollment signature is invalid')
        this.challenges.delete(proof.enrollmentId)
        return this.repository.createPending(record.identity, pendingTtlMs)
    }

    private rateLimit(key: string): void {
        const now = this.now().getTime()
        const values = (this.attemptWindows.get(key) ?? []).filter(value => value > now - 60_000)
        if (values.length >= (this.options.maxAttemptsPerMinute ?? 20)) throw new EnrollmentRateLimitError()
        values.push(now)
        this.attemptWindows.set(key, values)
    }

    private now(): Date { return this.options.now?.() ?? new Date() }
}

export class EnrollmentNotFoundError extends Error {}
export class EnrollmentConflictError extends Error {}
export class EnrollmentExpiredError extends Error {}
export class EnrollmentRateLimitError extends Error {}
export class BootstrapRequiredError extends Error {
    constructor() { super('First Gateway must be approved on the Relay host') }
}

function validatePublicIdentity(identity: GatewayEnrollmentIdentity): void {
    if (identity.publicKeySpkiPem.includes('PRIVATE KEY')) throw new EnrollmentConflictError('Private keys are forbidden')
    const key = createPublicKey(identity.publicKeySpkiPem)
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new EnrollmentConflictError('Gateway key must be P-256')
    const fingerprint = `sha256:${createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('base64url')}`
    if (fingerprint !== identity.fingerprint) throw new EnrollmentConflictError('Gateway fingerprint does not match public key')
}

function publicEnrollment(record: PendingRecord): GatewayEnrollmentDto {
    const { publicKeySpkiPem: _, ...value } = record
    return parseGatewayEnrollmentDto(value)
}

function publicGateway(record: EnrolledRecord): EnrolledGatewayKeyDto {
    const { publicKeySpkiPem: _, ...value } = record
    return structuredClone(value)
}

function approvedProjection(identity: GatewayEnrollmentIdentity, enrolled: EnrolledRecord): GatewayEnrollmentDto {
    return { enrollmentId: `enrolled:${identity.gatewayId}`, gatewayId: identity.gatewayId, workspaceId: identity.workspaceId, name: identity.name, platform: identity.platform, fingerprint: identity.fingerprint, status: 'approved', createdAt: enrolled.enrolledAt, expiresAt: enrolled.enrolledAt, approvedAt: enrolled.enrolledAt }
}

function uniqueCode(snapshot: Snapshot, factory?: () => string): string {
    for (let attempt = 0; attempt < 100; attempt++) {
        const code = factory?.() ?? Array.from(randomBytes(8), byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('')
        if (/^[A-HJ-NP-Z2-9]{8}$/.test(code) && !snapshot.enrollments.some(value => value.code === code)) return code
    }
    throw new Error('Unable to allocate a unique pairing code')
}

function expire(snapshot: Snapshot, now: Date): void {
    for (const value of snapshot.enrollments) {
        if (value.status === 'pending' && Date.parse(value.expiresAt) <= now.getTime()) {
            value.status = 'expired'
            delete value.code
        }
    }
}

function emptySnapshot(): Snapshot { return { formatVersion: FORMAT_VERSION, bootstrapComplete: false, enrollments: [], gateways: [] } }

function parseSnapshot(value: unknown): Snapshot {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Enrollment state must be an object')
    const input = value as Snapshot
    if (input.formatVersion !== FORMAT_VERSION || typeof input.bootstrapComplete !== 'boolean' || !Array.isArray(input.enrollments) || !Array.isArray(input.gateways)) throw new Error('Invalid enrollment state')
    if (JSON.stringify(value).match(/PRIVATE KEY/)) throw new Error('Enrollment state contains a private key')
    for (const enrollment of input.enrollments) {
        publicEnrollment(enrollment)
        validatePublicIdentity({ ...enrollment, algorithm: 'ECDSA-P256-SHA256' })
    }
    for (const gateway of input.gateways) validatePublicIdentity({ ...gateway, algorithm: 'ECDSA-P256-SHA256' })
    return structuredClone(input)
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
        await rename(temporary, path)
    } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined)
        throw error
    }
}

function isNotFound(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }
