import type {
    CodeverSession,
    CommandFailed,
    CommandRequest,
    CommandResult,
    Gateway,
    Project,
    SessionEventEnvelope,
} from '@codever/protocol'

export interface GatewayRepository {
    list(workspaceId: string): Promise<Gateway[]>
    get(id: string): Promise<Gateway | undefined>
    upsert(gateway: Gateway): Promise<void>
    updateConnection(id: string, status: Gateway['status'], connectionEpoch?: string, lastSeenAt?: string): Promise<void>
}

export interface ProjectRepository {
    listByGateway(gatewayId: string): Promise<Project[]>
    get(id: string): Promise<Project | undefined>
    replaceForGateway(gatewayId: string, projects: Project[]): Promise<void>
}

export interface SessionRepository {
    listByProject(projectId: string): Promise<CodeverSession[]>
    get(id: string): Promise<CodeverSession | undefined>
    replaceForGateway(gatewayId: string, sessions: CodeverSession[]): Promise<void>
}

export interface EventAppendResult {
    inserted: number
    cursors: Array<{ sessionId: string; seq: number }>
}

export interface EventRepository {
    append(events: SessionEventEnvelope[]): Promise<EventAppendResult>
    listAfter(sessionId: string, after: number, limit?: number): Promise<SessionEventEnvelope[]>
    highestSeq(sessionId: string): Promise<number>
}

export type RelayCommandStatus = 'relay_accepted' | 'gateway_accepted' | 'completed' | 'rejected' | 'expired' | 'unknown'

export interface CommandRecord {
    gatewayId: string
    connectionEpoch: string
    idempotencyKey: string
    request: CommandRequest
    status: RelayCommandStatus
    relayAcceptedAt: string
    gatewayAcceptedAt?: string
    result?: CommandResult
    failure?: CommandFailed
}

export interface CommandRepository {
    create(command: CommandRecord): Promise<CommandRecord>
    get(commandId: string): Promise<CommandRecord | undefined>
    getByIdempotencyKey(gatewayId: string, idempotencyKey: string): Promise<CommandRecord | undefined>
    markAccepted(commandId: string, acceptedAt: string): Promise<void>
    markResult(result: CommandResult): Promise<void>
    markFailed(failure: CommandFailed): Promise<void>
}
