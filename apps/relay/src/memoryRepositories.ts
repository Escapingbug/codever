import type { CodeverSession, Gateway, Project, SessionEventEnvelope } from '@codever/protocol'
import type {
    CommandRecord,
    CommandRepository,
    EventAppendResult,
    EventRepository,
    GatewayRepository,
    ProjectRepository,
    SessionRepository,
} from './repositories'

const clone = <T>(value: T): T => structuredClone(value)

export class InMemoryGatewayRepository implements GatewayRepository {
    private readonly values = new Map<string, Gateway>()

    async list(workspaceId: string): Promise<Gateway[]> {
        return [...this.values.values()].filter(value => value.workspaceId === workspaceId).map(clone)
    }

    async get(id: string): Promise<Gateway | undefined> {
        const value = this.values.get(id)
        return value && clone(value)
    }

    async upsert(gateway: Gateway): Promise<void> {
        this.values.set(gateway.id, clone(gateway))
    }

    async updateConnection(
        id: string,
        status: Gateway['status'],
        connectionEpoch?: string,
        lastSeenAt?: string,
    ): Promise<void> {
        const current = this.values.get(id)
        if (!current) return
        const next = { ...current, status, lastSeenAt: lastSeenAt ?? current.lastSeenAt }
        if (connectionEpoch === undefined) delete next.connectionEpoch
        else next.connectionEpoch = connectionEpoch
        this.values.set(id, next)
    }
}

export class InMemoryProjectRepository implements ProjectRepository {
    private readonly values = new Map<string, Project>()

    async listByGateway(gatewayId: string): Promise<Project[]> {
        return [...this.values.values()].filter(value => value.gatewayId === gatewayId).map(clone)
    }

    async get(id: string): Promise<Project | undefined> {
        const value = this.values.get(id)
        return value && clone(value)
    }

    async replaceForGateway(gatewayId: string, projects: Project[]): Promise<void> {
        for (const [id, value] of this.values) if (value.gatewayId === gatewayId) this.values.delete(id)
        for (const project of projects) this.values.set(project.id, clone(project))
    }
}

export class InMemorySessionRepository implements SessionRepository {
    private readonly values = new Map<string, CodeverSession>()

    async listByProject(projectId: string): Promise<CodeverSession[]> {
        return [...this.values.values()].filter(value => value.projectId === projectId).map(clone)
    }

    async get(id: string): Promise<CodeverSession | undefined> {
        const value = this.values.get(id)
        return value && clone(value)
    }

    async replaceForGateway(gatewayId: string, sessions: CodeverSession[]): Promise<void> {
        for (const [id, value] of this.values) if (value.gatewayId === gatewayId) this.values.delete(id)
        for (const session of sessions) this.values.set(session.id, clone(session))
    }
}

export class InMemoryEventRepository implements EventRepository {
    private readonly byId = new Map<string, SessionEventEnvelope>()
    private readonly bySession = new Map<string, Map<number, SessionEventEnvelope>>()

    async append(events: SessionEventEnvelope[]): Promise<EventAppendResult> {
        const pendingById = new Map(this.byId)
        const pendingByPosition = new Map<string, SessionEventEnvelope>()
        for (const [sessionId, session] of this.bySession) {
            for (const [seq, event] of session) pendingByPosition.set(`${sessionId}:${seq}`, event)
        }
        for (const event of events) {
            const existing = pendingById.get(event.eventId) ?? pendingByPosition.get(`${event.sessionId}:${event.seq}`)
            if (existing && JSON.stringify(existing) !== JSON.stringify(event)) {
                throw new Error(`Conflicting event ${event.eventId} at ${event.sessionId}:${event.seq}`)
            }
            pendingById.set(event.eventId, event)
            pendingByPosition.set(`${event.sessionId}:${event.seq}`, event)
        }

        let inserted = 0
        const cursors = new Map<string, number>()
        for (const event of events) {
            const existingById = this.byId.get(event.eventId)
            const session = this.bySession.get(event.sessionId) ?? new Map<number, SessionEventEnvelope>()
            const existingBySeq = session.get(event.seq)
            if (existingById || existingBySeq) {
                const existing = existingById ?? existingBySeq
                // Identical events are idempotent at both event-id and session-sequence keys.
            } else {
                const copy = clone(event)
                this.byId.set(copy.eventId, copy)
                session.set(copy.seq, copy)
                this.bySession.set(copy.sessionId, session)
                inserted += 1
            }
            cursors.set(event.sessionId, Math.max(cursors.get(event.sessionId) ?? 0, event.seq))
        }
        return { inserted, cursors: [...cursors].map(([sessionId, seq]) => ({ sessionId, seq })) }
    }

    async listAfter(sessionId: string, after: number, limit?: number): Promise<SessionEventEnvelope[]> {
        const events = [...(this.bySession.get(sessionId)?.values() ?? [])]
            .filter(event => event.seq > after)
            .sort((a, b) => a.seq - b.seq)
        return events.slice(0, limit).map(clone)
    }

    async highestSeq(sessionId: string): Promise<number> {
        const sequences = this.bySession.get(sessionId)?.keys()
        return sequences ? Math.max(0, ...sequences) : 0
    }
}

export class InMemoryCommandRepository implements CommandRepository {
    private readonly values = new Map<string, CommandRecord>()
    private readonly idempotency = new Map<string, string>()

    async create(command: CommandRecord): Promise<CommandRecord> {
        const key = `${command.gatewayId}:${command.idempotencyKey}`
        const existingId = this.idempotency.get(key)
        if (existingId) return clone(this.values.get(existingId)!)
        this.values.set(command.request.commandId, clone(command))
        this.idempotency.set(key, command.request.commandId)
        return clone(command)
    }

    async get(commandId: string): Promise<CommandRecord | undefined> {
        const value = this.values.get(commandId)
        return value && clone(value)
    }

    async getByIdempotencyKey(gatewayId: string, idempotencyKey: string): Promise<CommandRecord | undefined> {
        const id = this.idempotency.get(`${gatewayId}:${idempotencyKey}`)
        return id ? this.get(id) : undefined
    }

    async markAccepted(commandId: string, acceptedAt: string): Promise<void> {
        const value = this.require(commandId)
        value.status = 'gateway_accepted'
        value.gatewayAcceptedAt = acceptedAt
    }

    async markResult(result: import('@codever/protocol').CommandResult): Promise<void> {
        const value = this.require(result.commandId)
        value.status = 'completed'
        value.result = clone(result)
    }

    async markFailed(failure: import('@codever/protocol').CommandFailed): Promise<void> {
        const value = this.require(failure.commandId)
        value.status = failure.status
        value.failure = clone(failure)
    }

    private require(commandId: string): CommandRecord {
        const value = this.values.get(commandId)
        if (!value) throw new Error(`Unknown command ${commandId}`)
        return value
    }
}

export interface InMemoryRelayRepositories {
    gateways: InMemoryGatewayRepository
    projects: InMemoryProjectRepository
    sessions: InMemorySessionRepository
    events: InMemoryEventRepository
    commands: InMemoryCommandRepository
}

export function createInMemoryRelayRepositories(): InMemoryRelayRepositories {
    return {
        gateways: new InMemoryGatewayRepository(),
        projects: new InMemoryProjectRepository(),
        sessions: new InMemorySessionRepository(),
        events: new InMemoryEventRepository(),
        commands: new InMemoryCommandRepository(),
    }
}
