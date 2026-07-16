import {
    createHash,
    randomBytes,
    scrypt as nodeScrypt,
    timingSafeEqual,
} from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { FastifyRequest } from 'fastify'
import type {
    AccountProfile,
    AccountRole,
    AuthSessionDto,
    LoginDto,
    LoginResultDto,
} from '@codever/protocol'
import { CLIENT_EVENT_PROTOCOL } from '@codever/protocol'
export { CLIENT_EVENT_PROTOCOL } from '@codever/protocol'
import type {
    ClientAction,
    ClientAuthenticator,
    ClientAuthorizationTarget,
    ClientIdentity,
} from './auth'
import type { GatewayRepository } from './repositories'

const PASSWORD_ALGORITHM = 'scrypt'
const PASSWORD_VERSION = 'v1'
const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEY_LENGTH = 32
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024
const TOKEN_BYTES = 32
const SESSION_FORMAT_VERSION = 1
export const CLIENT_BEARER_PROTOCOL_PREFIX = 'codever.bearer.'

export interface RelayUserAccount {
    id: string
    username: string
    passwordHash: string
    workspaceId: string
    roles: AccountRole[]
    enabled: boolean
}

interface PersistedSession {
    id: string
    tokenHash: string
    userId: string
    deviceName?: string
    createdAt: string
    expiresAt: string
    revokedAt?: string
}

interface SessionSnapshot {
    formatVersion: 1
    sessions: PersistedSession[]
}

export interface AuthenticatedAccountSession {
    identity: ClientIdentity
    dto: AuthSessionDto
}

export interface AccountSessionService {
    login(input: LoginDto): Promise<LoginResultDto | null>
    current(request: FastifyRequest): Promise<AuthSessionDto | null>
    logout(request: FastifyRequest): Promise<boolean>
}

export interface BearerAccountAuthenticatorOptions {
    users: RelayUserAccount[]
    sessions: AuthSessionRepository
    gateways: GatewayRepository
    sessionTtlSeconds: number
    now?: () => Date
}

export class AuthSessionRepository {
    private snapshot: SessionSnapshot
    private tail: Promise<void> = Promise.resolve()

    private constructor(private readonly path: string | undefined, snapshot: SessionSnapshot) {
        this.snapshot = snapshot
    }

    static async open(path: string): Promise<AuthSessionRepository> {
        let value: unknown
        try {
            value = JSON.parse(await readFile(path, 'utf8'))
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw new Error(`Unable to load Relay auth sessions at ${path}`, { cause: error })
            }
        }
        return new AuthSessionRepository(path, value === undefined ? emptySnapshot() : parseSnapshot(value, path))
    }

    static memory(): AuthSessionRepository {
        return new AuthSessionRepository(undefined, emptySnapshot())
    }

    async create(session: PersistedSession): Promise<void> {
        await this.mutate(snapshot => {
            snapshot.sessions.push(structuredClone(session))
        })
    }

    findByTokenHash(tokenHash: string): PersistedSession | undefined {
        const found = this.snapshot.sessions.find(session => constantTimeTextEqual(session.tokenHash, tokenHash))
        return found && structuredClone(found)
    }

    async revoke(tokenHash: string, revokedAt: string): Promise<boolean> {
        let changed = false
        await this.mutate(snapshot => {
            const session = snapshot.sessions.find(value => constantTimeTextEqual(value.tokenHash, tokenHash))
            if (session && !session.revokedAt) {
                session.revokedAt = revokedAt
                changed = true
            }
        })
        return changed
    }

    async pruneExpired(now: string): Promise<void> {
        if (!this.snapshot.sessions.some(session => session.expiresAt <= now)) return
        await this.mutate(snapshot => {
            snapshot.sessions = snapshot.sessions.filter(session => session.expiresAt > now)
        })
    }

    private async mutate(operation: (snapshot: SessionSnapshot) => void): Promise<void> {
        const run = async (): Promise<void> => {
            const next = structuredClone(this.snapshot)
            operation(next)
            parseSnapshot(next, this.path ?? 'memory')
            if (this.path) await atomicWriteJson(this.path, next)
            this.snapshot = next
        }
        const result = this.tail.then(run, run)
        this.tail = result.then(() => undefined, () => undefined)
        await result
    }
}

export class BearerAccountAuthenticator implements ClientAuthenticator, AccountSessionService {
    private readonly usersByName = new Map<string, RelayUserAccount>()
    private readonly usersById = new Map<string, RelayUserAccount>()
    private readonly now: () => Date

    constructor(private readonly options: BearerAccountAuthenticatorOptions) {
        if (!Number.isSafeInteger(options.sessionTtlSeconds) || options.sessionTtlSeconds < 60) {
            throw new Error('sessionTtlSeconds must be an integer of at least 60')
        }
        this.now = options.now ?? (() => new Date())
        for (const user of options.users) {
            this.usersByName.set(normalizeUsername(user.username), user)
            this.usersById.set(user.id, user)
        }
    }

    async login(input: LoginDto): Promise<LoginResultDto | null> {
        const user = this.usersByName.get(normalizeUsername(input.username))
        const valid = user ? await verifyPassword(input.password, user.passwordHash) : await consumeDummyPassword(input.password)
        if (!user || !user.enabled || !valid) return null

        const now = this.now()
        const accessToken = randomBytes(TOKEN_BYTES).toString('base64url')
        const expiresAt = new Date(now.getTime() + this.options.sessionTtlSeconds * 1_000).toISOString()
        await this.options.sessions.pruneExpired(now.toISOString())
        await this.options.sessions.create({
            id: randomBytes(16).toString('base64url'),
            tokenHash: hashAccessToken(accessToken),
            userId: user.id,
            ...(input.deviceName && { deviceName: input.deviceName }),
            createdAt: now.toISOString(),
            expiresAt,
        })
        return { accessToken, expiresAt, user: profile(user) }
    }

    async current(request: FastifyRequest): Promise<AuthSessionDto | null> {
        const authenticated = await this.resolveRequest(request)
        return authenticated?.dto ?? null
    }

    async logout(request: FastifyRequest): Promise<boolean> {
        const token = accessTokenFromRequest(request)
        if (!token) return false
        return this.options.sessions.revoke(hashAccessToken(token), this.now().toISOString())
    }

    async authenticate(request: FastifyRequest): Promise<ClientIdentity | null> {
        return (await this.resolveRequest(request))?.identity ?? null
    }

    async authorize(
        identity: ClientIdentity,
        action: ClientAction,
        target: ClientAuthorizationTarget,
    ): Promise<boolean> {
        const user = this.usersById.get(identity.id)
        if (!user?.enabled || user.workspaceId !== identity.workspaceId) return false
        if (!roleAllows(user.roles, action)) return false
        if (!target.gatewayId) return action === 'gateway:list'
        const gateway = await this.options.gateways.get(target.gatewayId)
        return gateway?.workspaceId === user.workspaceId
    }

    private async resolveRequest(request: FastifyRequest): Promise<AuthenticatedAccountSession | null> {
        const token = accessTokenFromRequest(request)
        if (!token) return null
        const session = this.options.sessions.findByTokenHash(hashAccessToken(token))
        if (!session || session.revokedAt || Date.parse(session.expiresAt) <= this.now().getTime()) return null
        const user = this.usersById.get(session.userId)
        if (!user?.enabled) return null
        return {
            identity: {
                id: user.id,
                workspaceId: user.workspaceId,
                roles: [...user.roles],
                ...(session.deviceName && { deviceId: session.deviceName }),
            },
            dto: { expiresAt: session.expiresAt, user: profile(user) },
        }
    }
}

export async function hashPassword(password: string): Promise<string> {
    if (!password) throw new Error('Password must not be empty')
    const salt = randomBytes(16)
    const derived = await derivePassword(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P)
    return [
        PASSWORD_ALGORITHM,
        PASSWORD_VERSION,
        SCRYPT_N,
        SCRYPT_R,
        SCRYPT_P,
        salt.toString('base64url'),
        derived.toString('base64url'),
    ].join('$')
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
    const parsed = parsePasswordHash(encoded)
    if (!parsed) return false
    const actual = await derivePassword(password, parsed.salt, parsed.n, parsed.r, parsed.p)
    return actual.length === parsed.hash.length && timingSafeEqual(actual, parsed.hash)
}

export function validatePasswordHash(encoded: string): void {
    if (!parsePasswordHash(encoded)) throw new Error('passwordHash must be a supported scrypt hash')
}

export function hashAccessToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('base64url')
}

export function accessTokenFromRequest(request: FastifyRequest): string | undefined {
    const authorization = request.headers.authorization
    if (authorization) {
        const match = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(authorization)
        if (match) return match[1]
    }
    const protocols = request.headers['sec-websocket-protocol']
    if (typeof protocols !== 'string') return undefined
    for (const value of protocols.split(',').map(item => item.trim())) {
        if (value.startsWith(CLIENT_BEARER_PROTOCOL_PREFIX)) {
            const token = value.slice(CLIENT_BEARER_PROTOCOL_PREFIX.length)
            if (/^[A-Za-z0-9_-]{20,}$/.test(token)) return token
        }
    }
    return undefined
}

export function selectWebSocketProtocol(protocols: Set<string>): string | false {
    if (protocols.has(CLIENT_EVENT_PROTOCOL)
        && [...protocols].some(protocol => protocol.startsWith(CLIENT_BEARER_PROTOCOL_PREFIX))) {
        return CLIENT_EVENT_PROTOCOL
    }
    return false
}

function roleAllows(roles: AccountRole[], action: ClientAction): boolean {
    if (roles.includes('admin')) return true
    const reads: ClientAction[] = ['gateway:list', 'project:list', 'session:list', 'session:read', 'event:list']
    if (reads.includes(action)) return roles.some(role => role === 'viewer' || role === 'operator' || role === 'gateway_admin')
    return roles.some(role => role === 'operator' || role === 'gateway_admin')
}

function profile(user: RelayUserAccount): AccountProfile {
    return { id: user.id, username: user.username, workspaceId: user.workspaceId, roles: [...user.roles] }
}

function normalizeUsername(username: string): string {
    return username.trim().toLocaleLowerCase('en-US')
}

async function consumeDummyPassword(password: string): Promise<boolean> {
    const salt = Buffer.alloc(16, 0x5a)
    await derivePassword(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P)
    return false
}

async function derivePassword(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
    return await new Promise<Buffer>((resolve, reject) => {
        nodeScrypt(password, salt, SCRYPT_KEY_LENGTH, { N: n, r, p, maxmem: SCRYPT_MAX_MEMORY }, (error, key) => {
            if (error) reject(error)
            else resolve(key)
        })
    })
}

function parsePasswordHash(encoded: string): { n: number; r: number; p: number; salt: Buffer; hash: Buffer } | undefined {
    const [algorithm, version, rawN, rawR, rawP, rawSalt, rawHash, extra] = encoded.split('$')
    if (extra !== undefined || algorithm !== PASSWORD_ALGORITHM || version !== PASSWORD_VERSION) return undefined
    const n = Number(rawN)
    const r = Number(rawR)
    const p = Number(rawP)
    if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return undefined
    if (!rawSalt || !rawHash || !/^[A-Za-z0-9_-]+$/.test(rawSalt) || !/^[A-Za-z0-9_-]+$/.test(rawHash)) return undefined
    const salt = Buffer.from(rawSalt, 'base64url')
    const hash = Buffer.from(rawHash, 'base64url')
    if (salt.length !== 16 || hash.length !== SCRYPT_KEY_LENGTH) return undefined
    return { n, r, p, salt, hash }
}

function emptySnapshot(): SessionSnapshot {
    return { formatVersion: SESSION_FORMAT_VERSION, sessions: [] }
}

function parseSnapshot(value: unknown, label: string): SessionSnapshot {
    if (!isObject(value) || value.formatVersion !== SESSION_FORMAT_VERSION || !Array.isArray(value.sessions)) {
        throw new Error(`Invalid Relay auth session store at ${label}`)
    }
    const ids = new Set<string>()
    const hashes = new Set<string>()
    const sessions = value.sessions.map((entry, index) => {
        if (!isObject(entry)) throw new Error(`Invalid auth session at ${label}[${index}]`)
        const allowed = new Set(['id', 'tokenHash', 'userId', 'deviceName', 'createdAt', 'expiresAt', 'revokedAt'])
        if (Object.keys(entry).some(key => !allowed.has(key))) throw new Error(`Unknown auth session field at ${label}[${index}]`)
        const session: PersistedSession = {
            id: requireText(entry.id, 'id'),
            tokenHash: requireText(entry.tokenHash, 'tokenHash'),
            userId: requireText(entry.userId, 'userId'),
            createdAt: requireDate(entry.createdAt, 'createdAt'),
            expiresAt: requireDate(entry.expiresAt, 'expiresAt'),
            ...(entry.deviceName !== undefined && { deviceName: requireText(entry.deviceName, 'deviceName') }),
            ...(entry.revokedAt !== undefined && { revokedAt: requireDate(entry.revokedAt, 'revokedAt') }),
        }
        if (!/^[A-Za-z0-9_-]{43}$/.test(session.tokenHash)) throw new Error(`Invalid token hash at ${label}[${index}]`)
        if (ids.has(session.id) || hashes.has(session.tokenHash)) throw new Error(`Duplicate auth session at ${label}[${index}]`)
        ids.add(session.id)
        hashes.add(session.tokenHash)
        return session
    })
    return { formatVersion: SESSION_FORMAT_VERSION, sessions }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    try {
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        await rename(temporary, path)
    } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined)
        throw error
    }
}

function constantTimeTextEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left)
    const rightBuffer = Buffer.from(right)
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireText(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value) throw new Error(`Auth session ${label} must be a non-empty string`)
    return value
}

function requireDate(value: unknown, label: string): string {
    const text = requireText(value, label)
    if (!Number.isFinite(Date.parse(text))) throw new Error(`Auth session ${label} must be an ISO date`)
    return text
}
