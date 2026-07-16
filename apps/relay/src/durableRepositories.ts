import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, truncate } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
    parseCodeverSession,
    parseCommandFailed,
    parseCommandRequest,
    parseCommandResult,
    parseGateway,
    parseProject,
    parseSessionEventEnvelope,
    type CodeverSession,
    type Gateway,
    type Project,
    type SessionEventEnvelope,
} from '@codever/protocol'
import type {
    CommandRecord,
    CommandRepository,
    EventAppendResult,
    EventRepository,
    GatewayRepository,
    ProjectRepository,
    RelayCommandStatus,
    SessionRepository,
} from './repositories'
import type { RelayRepositories } from './server'

const FORMAT_VERSION = 1
const clone = <T>(value: T): T => structuredClone(value)

interface MetadataSnapshot {
    formatVersion: 1
    gateways: Gateway[]
    projects: Project[]
    sessions: CodeverSession[]
}

interface CommandSnapshot {
    formatVersion: 1
    commands: CommandRecord[]
}

interface EventLogRecord {
    formatVersion: 1
    checksum: string
    event: SessionEventEnvelope
}

class SerialExecutor {
    private tail: Promise<void> = Promise.resolve()

    run<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.tail.then(operation, operation)
        this.tail = result.then(() => undefined, () => undefined)
        return result
    }
}

class DurableMetadataState {
    private snapshot: MetadataSnapshot
    private readonly serial = new SerialExecutor()

    private constructor(private readonly path: string, snapshot: MetadataSnapshot) {
        this.snapshot = snapshot
    }

    static async open(path: string): Promise<DurableMetadataState> {
        const value = await readJsonIfPresent(path, 'Relay metadata')
        return new DurableMetadataState(path, value === undefined ? emptyMetadata() : parseMetadata(value, path))
    }

    read(): MetadataSnapshot {
        return clone(this.snapshot)
    }

    mutate(operation: (draft: MetadataSnapshot) => void): Promise<void> {
        return this.serial.run(async () => {
            const draft = clone(this.snapshot)
            operation(draft)
            validateNoPrivateKeys(draft, 'Relay metadata')
            parseMetadata(draft, this.path)
            await atomicWriteJson(this.path, draft)
            this.snapshot = draft
        })
    }

    async markGatewaysDisconnected(): Promise<void> {
        if (!this.snapshot.gateways.some(gateway => gateway.status === 'online' || gateway.connectionEpoch)) return
        await this.mutate(draft => {
            for (const gateway of draft.gateways) {
                if (gateway.status === 'online') gateway.status = 'offline'
                delete gateway.connectionEpoch
            }
        })
    }
}

export class DurableGatewayRepository implements GatewayRepository {
    constructor(private readonly state: DurableMetadataState) {}

    async list(workspaceId: string): Promise<Gateway[]> {
        return this.state.read().gateways.filter(value => value.workspaceId === workspaceId)
    }

    async get(id: string): Promise<Gateway | undefined> {
        return this.state.read().gateways.find(value => value.id === id)
    }

    async upsert(gateway: Gateway): Promise<void> {
        const value = parseGateway(gateway)
        await this.state.mutate(draft => {
            const index = draft.gateways.findIndex(item => item.id === value.id)
            if (index < 0) draft.gateways.push(clone(value))
            else draft.gateways[index] = clone(value)
        })
    }

    async updateConnection(id: string, status: Gateway['status'], connectionEpoch?: string, lastSeenAt?: string): Promise<void> {
        await this.state.mutate(draft => {
            const current = draft.gateways.find(value => value.id === id)
            if (!current) return
            current.status = status
            current.lastSeenAt = lastSeenAt ?? current.lastSeenAt
            if (connectionEpoch === undefined) delete current.connectionEpoch
            else current.connectionEpoch = connectionEpoch
        })
    }
}

export class DurableProjectRepository implements ProjectRepository {
    constructor(private readonly state: DurableMetadataState) {}

    async listByGateway(gatewayId: string): Promise<Project[]> {
        return this.state.read().projects.filter(value => value.gatewayId === gatewayId)
    }

    async get(id: string): Promise<Project | undefined> {
        return this.state.read().projects.find(value => value.id === id)
    }

    async replaceForGateway(gatewayId: string, projects: Project[]): Promise<void> {
        const values = projects.map(parseProject)
        if (values.some(value => value.gatewayId !== gatewayId)) throw new Error(`Project snapshot does not belong to Gateway ${gatewayId}`)
        ensureUnique(values.map(value => value.id), 'project id')
        await this.state.mutate(draft => {
            draft.projects = [...draft.projects.filter(value => value.gatewayId !== gatewayId), ...clone(values)]
        })
    }
}

export class DurableSessionRepository implements SessionRepository {
    constructor(private readonly state: DurableMetadataState) {}

    async listByProject(projectId: string): Promise<CodeverSession[]> {
        return this.state.read().sessions.filter(value => value.projectId === projectId)
    }

    async get(id: string): Promise<CodeverSession | undefined> {
        return this.state.read().sessions.find(value => value.id === id)
    }

    async replaceForGateway(gatewayId: string, sessions: CodeverSession[]): Promise<void> {
        const values = sessions.map(parseCodeverSession)
        if (values.some(value => value.gatewayId !== gatewayId)) throw new Error(`Session snapshot does not belong to Gateway ${gatewayId}`)
        ensureUnique(values.map(value => value.id), 'session id')
        await this.state.mutate(draft => {
            draft.sessions = [...draft.sessions.filter(value => value.gatewayId !== gatewayId), ...clone(values)]
        })
    }
}

export class DurableCommandRepository implements CommandRepository {
    private readonly values = new Map<string, CommandRecord>()
    private readonly idempotency = new Map<string, string>()
    private readonly serial = new SerialExecutor()

    private constructor(private readonly path: string, commands: CommandRecord[]) {
        for (const command of commands) this.index(command)
    }

    static async open(path: string): Promise<DurableCommandRepository> {
        const value = await readJsonIfPresent(path, 'Relay commands')
        const commands = value === undefined ? [] : parseCommands(value, path).commands
        return new DurableCommandRepository(path, commands)
    }

    async create(command: CommandRecord): Promise<CommandRecord> {
        const value = parseCommandRecord(command, 'command')
        return this.serial.run(async () => {
            const key = idempotencyKey(value.gatewayId, value.idempotencyKey)
            const existingId = this.idempotency.get(key)
            if (existingId) return clone(this.values.get(existingId)!)
            const existing = this.values.get(value.request.commandId)
            if (existing) {
                if (!equal(existing, value)) throw new Error(`Conflicting command id ${value.request.commandId}`)
                return clone(existing)
            }
            const commands = [...this.values.values(), value]
            await this.persist(commands)
            this.index(value)
            return clone(value)
        })
    }

    async get(commandId: string): Promise<CommandRecord | undefined> {
        const value = this.values.get(commandId)
        return value && clone(value)
    }

    async getByIdempotencyKey(gatewayId: string, key: string): Promise<CommandRecord | undefined> {
        const id = this.idempotency.get(idempotencyKey(gatewayId, key))
        return id ? this.get(id) : undefined
    }

    async markAccepted(commandId: string, acceptedAt: string): Promise<void> {
        await this.update(commandId, value => {
            value.status = 'gateway_accepted'
            value.gatewayAcceptedAt = acceptedAt
        })
    }

    async markResult(result: ReturnType<typeof parseCommandResult>): Promise<void> {
        const parsed = parseCommandResult(result)
        await this.update(parsed.commandId, value => {
            value.status = 'completed'
            value.result = clone(parsed)
        })
    }

    async markFailed(failure: ReturnType<typeof parseCommandFailed>): Promise<void> {
        const parsed = parseCommandFailed(failure)
        await this.update(parsed.commandId, value => {
            value.status = parsed.status
            value.failure = clone(parsed)
        })
    }

    private update(commandId: string, operation: (value: CommandRecord) => void): Promise<void> {
        return this.serial.run(async () => {
            const current = this.values.get(commandId)
            if (!current) throw new Error(`Unknown command ${commandId}`)
            const next = clone(current)
            operation(next)
            parseCommandRecord(next, `command ${commandId}`)
            const commands = [...this.values.values()].map(value => value.request.commandId === commandId ? next : value)
            await this.persist(commands)
            this.values.set(commandId, next)
        })
    }

    private async persist(commands: CommandRecord[]): Promise<void> {
        const snapshot: CommandSnapshot = { formatVersion: FORMAT_VERSION, commands }
        validateNoPrivateKeys(snapshot, 'Relay commands')
        await atomicWriteJson(this.path, snapshot)
    }

    private index(command: CommandRecord): void {
        const id = command.request.commandId
        if (this.values.has(id)) throw new Error(`Corrupt Relay commands: duplicate command id ${id}`)
        const key = idempotencyKey(command.gatewayId, command.idempotencyKey)
        if (this.idempotency.has(key)) throw new Error(`Corrupt Relay commands: duplicate idempotency key for ${command.gatewayId}`)
        this.values.set(id, clone(command))
        this.idempotency.set(key, id)
    }
}

export class DurableEventRepository implements EventRepository {
    private readonly byId = new Map<string, SessionEventEnvelope>()
    private readonly bySession = new Map<string, Map<number, SessionEventEnvelope>>()
    private readonly serial = new SerialExecutor()

    private constructor(private readonly path: string) {}

    static async open(path: string): Promise<DurableEventRepository> {
        const repository = new DurableEventRepository(path)
        await repository.recover()
        return repository
    }

    append(events: SessionEventEnvelope[]): Promise<EventAppendResult> {
        return this.serial.run(async () => {
            const parsed = events.map(parseSessionEventEnvelope)
            const pendingById = new Map(this.byId)
            const pendingByPosition = positionIndex(this.bySession)
            const additions: SessionEventEnvelope[] = []
            for (const event of parsed) {
                const byId = pendingById.get(event.eventId)
                const byPosition = pendingByPosition.get(positionKey(event))
                if ((byId && !equal(byId, event)) || (byPosition && !equal(byPosition, event))) {
                    throw new Error(`Conflicting event ${event.eventId} at ${event.sessionId}:${event.seq}`)
                }
                if (!byId && !byPosition) additions.push(event)
                pendingById.set(event.eventId, event)
                pendingByPosition.set(positionKey(event), event)
            }
            if (additions.length) await appendEventRecords(this.path, additions)
            for (const event of additions) this.index(event)
            const cursors = new Map<string, number>()
            for (const event of parsed) cursors.set(event.sessionId, Math.max(cursors.get(event.sessionId) ?? 0, event.seq))
            return { inserted: additions.length, cursors: [...cursors].map(([sessionId, seq]) => ({ sessionId, seq })) }
        })
    }

    async listAfter(sessionId: string, after: number, limit?: number): Promise<SessionEventEnvelope[]> {
        const values = [...(this.bySession.get(sessionId)?.values() ?? [])]
            .filter(event => event.seq > after)
            .sort((a, b) => a.seq - b.seq)
        return clone(limit === undefined ? values : values.slice(0, limit))
    }

    async highestSeq(sessionId: string): Promise<number> {
        return Math.max(0, ...(this.bySession.get(sessionId)?.keys() ?? []))
    }

    private async recover(): Promise<void> {
        let content: Buffer
        try {
            content = await readFile(this.path)
        } catch (error) {
            if (isNotFound(error)) return
            throw new Error(`Unable to read Relay event log at ${this.path}`, { cause: error })
        }
        let completeLength = content.length
        if (content.length && content[content.length - 1] !== 0x0a) {
            const lastNewline = content.lastIndexOf(0x0a)
            completeLength = lastNewline < 0 ? 0 : lastNewline + 1
            await truncate(this.path, completeLength)
        }
        const text = content.subarray(0, completeLength).toString('utf8')
        for (const [index, line] of text.split('\n').entries()) {
            if (!line) continue
            let record: EventLogRecord
            try {
                record = parseEventRecord(JSON.parse(line), this.path, index + 1)
            } catch (error) {
                throw new Error(`Corrupt Relay event log at ${this.path}:${index + 1}`, { cause: error })
            }
            this.index(record.event)
        }
    }

    private index(event: SessionEventEnvelope): void {
        const existingId = this.byId.get(event.eventId)
        const session = this.bySession.get(event.sessionId) ?? new Map<number, SessionEventEnvelope>()
        const existingPosition = session.get(event.seq)
        if ((existingId && !equal(existingId, event)) || (existingPosition && !equal(existingPosition, event))) {
            throw new Error(`Corrupt Relay event log: conflicting event ${event.eventId} at ${event.sessionId}:${event.seq}`)
        }
        if (existingId || existingPosition) return
        const copy = clone(event)
        this.byId.set(copy.eventId, copy)
        session.set(copy.seq, copy)
        this.bySession.set(copy.sessionId, session)
    }
}

export interface DurableRelayRepositories extends RelayRepositories {
    gateways: DurableGatewayRepository
    projects: DurableProjectRepository
    sessions: DurableSessionRepository
    events: DurableEventRepository
    commands: DurableCommandRepository
}

export async function createDurableRelayRepositories(dataDirectory: string): Promise<DurableRelayRepositories> {
    const directory = resolve(dataDirectory)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const metadata = await DurableMetadataState.open(join(directory, 'metadata.json'))
    await metadata.markGatewaysDisconnected()
    const [commands, events] = await Promise.all([
        DurableCommandRepository.open(join(directory, 'commands.json')),
        DurableEventRepository.open(join(directory, 'session-events.jsonl')),
    ])
    return {
        gateways: new DurableGatewayRepository(metadata),
        projects: new DurableProjectRepository(metadata),
        sessions: new DurableSessionRepository(metadata),
        commands,
        events,
    }
}

function emptyMetadata(): MetadataSnapshot {
    return { formatVersion: FORMAT_VERSION, gateways: [], projects: [], sessions: [] }
}

function parseMetadata(value: unknown, path: string): MetadataSnapshot {
    const object = requireRecord(value, `Relay metadata at ${path}`)
    exactKeys(object, ['formatVersion', 'gateways', 'projects', 'sessions'], `Relay metadata at ${path}`)
    if (object.formatVersion !== FORMAT_VERSION) throw new Error(`Unsupported Relay metadata format at ${path}`)
    if (!Array.isArray(object.gateways) || !Array.isArray(object.projects) || !Array.isArray(object.sessions)) {
        throw new Error(`Relay metadata collections at ${path} must be arrays`)
    }
    const snapshot: MetadataSnapshot = {
        formatVersion: FORMAT_VERSION,
        gateways: object.gateways.map(parseGateway),
        projects: object.projects.map(parseProject),
        sessions: object.sessions.map(parseCodeverSession),
    }
    ensureUnique(snapshot.gateways.map(value => value.id), 'Gateway id')
    ensureUnique(snapshot.projects.map(value => value.id), 'project id')
    ensureUnique(snapshot.sessions.map(value => value.id), 'session id')
    validateNoPrivateKeys(snapshot, 'Relay metadata')
    return snapshot
}

function parseCommands(value: unknown, path: string): CommandSnapshot {
    const object = requireRecord(value, `Relay commands at ${path}`)
    exactKeys(object, ['formatVersion', 'commands'], `Relay commands at ${path}`)
    if (object.formatVersion !== FORMAT_VERSION || !Array.isArray(object.commands)) throw new Error(`Corrupt Relay commands at ${path}`)
    const snapshot: CommandSnapshot = { formatVersion: FORMAT_VERSION, commands: object.commands.map((item, i) => parseCommandRecord(item, `command[${i}]`)) }
    validateNoPrivateKeys(snapshot, 'Relay commands')
    return snapshot
}

function parseCommandRecord(value: unknown, label: string): CommandRecord {
    const object = requireRecord(value, label)
    exactKeys(object, ['gatewayId', 'connectionEpoch', 'idempotencyKey', 'request', 'status', 'relayAcceptedAt', 'gatewayAcceptedAt', 'result', 'failure'], label, true)
    const statuses: RelayCommandStatus[] = ['relay_accepted', 'gateway_accepted', 'completed', 'rejected', 'expired', 'unknown']
    if (!statuses.includes(object.status as RelayCommandStatus)) throw new Error(`${label}.status is invalid`)
    const gatewayId = requiredString(object.gatewayId, `${label}.gatewayId`)
    const connectionEpoch = requiredString(object.connectionEpoch, `${label}.connectionEpoch`)
    const idempotency = requiredString(object.idempotencyKey, `${label}.idempotencyKey`)
    const relayAcceptedAt = requiredString(object.relayAcceptedAt, `${label}.relayAcceptedAt`)
    if (object.gatewayAcceptedAt !== undefined && typeof object.gatewayAcceptedAt !== 'string') throw new Error(`${label}.gatewayAcceptedAt is invalid`)
    const result: CommandRecord = {
        gatewayId,
        connectionEpoch,
        idempotencyKey: idempotency,
        request: parseCommandRequest(object.request),
        status: object.status as RelayCommandStatus,
        relayAcceptedAt,
        ...(object.gatewayAcceptedAt !== undefined && { gatewayAcceptedAt: object.gatewayAcceptedAt }),
        ...(object.result !== undefined && { result: parseCommandResult(object.result) }),
        ...(object.failure !== undefined && { failure: parseCommandFailed(object.failure) }),
    }
    return result
}

function parseEventRecord(value: unknown, path: string, line: number): EventLogRecord {
    const object = requireRecord(value, `event record ${path}:${line}`)
    exactKeys(object, ['formatVersion', 'checksum', 'event'], `event record ${path}:${line}`)
    if (object.formatVersion !== FORMAT_VERSION || typeof object.checksum !== 'string') throw new Error('Invalid event record header')
    const event = parseSessionEventEnvelope(object.event)
    if (object.checksum !== eventChecksum(event)) throw new Error('Event record checksum mismatch')
    validateNoPrivateKeys(event, 'Relay event')
    return { formatVersion: FORMAT_VERSION, checksum: object.checksum, event }
}

async function appendEventRecords(path: string, events: SessionEventEnvelope[]): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const lines = events.map(event => {
        validateNoPrivateKeys(event, 'Relay event')
        const record: EventLogRecord = { formatVersion: FORMAT_VERSION, checksum: eventChecksum(event), event }
        return `${JSON.stringify(record)}\n`
    }).join('')
    const file = await open(path, 'a', 0o600)
    try {
        await file.writeFile(lines, 'utf8')
        await file.sync()
    } finally {
        await file.close()
    }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try {
        await file.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
        await file.sync()
    } finally {
        await file.close()
    }
    try {
        await rename(temporary, path)
    } catch (error) {
        await rm(temporary, { force: true })
        throw error
    }
}

async function readJsonIfPresent(path: string, label: string): Promise<unknown | undefined> {
    try {
        const value = await readFile(path, 'utf8')
        return JSON.parse(value)
    } catch (error) {
        if (isNotFound(error)) return undefined
        if (error instanceof SyntaxError) throw new Error(`Corrupt ${label} at ${path}: invalid JSON`, { cause: error })
        throw new Error(`Unable to read ${label} at ${path}`, { cause: error })
    }
}

function eventChecksum(event: SessionEventEnvelope): string {
    return createHash('sha256').update(JSON.stringify(event)).digest('hex')
}

function validateNoPrivateKeys(value: unknown, label: string, path = ''): void {
    if (typeof value === 'string' && /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(value)) {
        throw new Error(`${label} must not persist private key material at ${path || '<root>'}`)
    }
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
        value.forEach((item, index) => validateNoPrivateKeys(item, label, `${path}[${index}]`))
        return
    }
    for (const [key, item] of Object.entries(value)) {
        const next = path ? `${path}.${key}` : key
        if (/private.?key/i.test(key)) throw new Error(`${label} must not persist private key field ${next}`)
        validateNoPrivateKeys(item, label, next)
    }
}

function positionIndex(bySession: Map<string, Map<number, SessionEventEnvelope>>): Map<string, SessionEventEnvelope> {
    const result = new Map<string, SessionEventEnvelope>()
    for (const events of bySession.values()) for (const event of events.values()) result.set(positionKey(event), event)
    return result
}

function positionKey(event: SessionEventEnvelope): string {
    return `${event.sessionId}\0${event.seq}`
}

function idempotencyKey(gatewayId: string, key: string): string {
    return `${gatewayId}\0${key}`
}

function ensureUnique(values: string[], label: string): void {
    if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`)
}

function equal(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right)
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
    return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value) throw new Error(`${label} is required`)
    return value
}

function exactKeys(object: Record<string, unknown>, keys: string[], label: string, optional = false): void {
    const allowed = new Set(keys)
    const unknown = Object.keys(object).filter(key => !allowed.has(key))
    if (unknown.length) throw new Error(`${label} contains unknown fields: ${unknown.join(', ')}`)
    if (!optional) {
        const missing = keys.filter(key => !(key in object))
        if (missing.length) throw new Error(`${label} is missing fields: ${missing.join(', ')}`)
    }
}

function isNotFound(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
