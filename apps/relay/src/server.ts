import { randomBytes, randomUUID } from 'node:crypto'
import type { ServerOptions as HttpsServerOptions } from 'node:https'
import websocket from '@fastify/websocket'
import {
    parseCancelSessionDto,
    parseCreateSessionDto,
    parseGatewayFrame,
    parseGatewayHandshakeFrame,
    parsePatchSessionConfigDto,
    parseResolveDecisionDto,
    parseSendMessageDto,
    type CommandFailed,
    type CommandRequest,
    type GatewayCommand,
    type GatewayFrame,
    type GatewayHandshakeFrame,
    type MutationReceiptDto,
} from '@codever/protocol'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import type WebSocket from 'ws'
import {
    DenyAllClientAuthenticator,
    DenyAllGatewayAuthenticator,
    type ClientAction,
    type ClientAuthenticator,
    type ClientAuthorizationTarget,
    type ClientIdentity,
    type GatewayAuthenticator,
} from './auth'
import { GatewayConnectionRegistry } from './connectionRegistry'
import { createInMemoryRelayRepositories } from './memoryRepositories'
import type {
    CommandRecord,
    CommandRepository,
    EventRepository,
    GatewayRepository,
    ProjectRepository,
    SessionRepository,
} from './repositories'
import { SessionEventStreams, type SessionEventStreamOptions } from './sessionEventStreams'

export interface RelayRepositories {
    gateways: GatewayRepository
    projects: ProjectRepository
    sessions: SessionRepository
    events: EventRepository
    commands: CommandRepository
}

export interface CreateRelayServerOptions {
    repositories?: RelayRepositories
    clientAuthenticator?: ClientAuthenticator
    gatewayAuthenticator?: GatewayAuthenticator
    connectionRegistry?: GatewayConnectionRegistry
    relayId?: string
    challengeTtlMs?: number
    eventStreams?: Partial<SessionEventStreamOptions>
    createSessionTimeoutMs?: number
    logger?: boolean
    https?: HttpsServerOptions
}

export interface RelayServer extends FastifyInstance {
    relay: {
        repositories: RelayRepositories
        connections: GatewayConnectionRegistry
        eventStreams: SessionEventStreams
    }
}

interface IdParams {
    gatewayId?: string
    projectId?: string
    sessionId?: string
    decisionId?: string
}

class HttpError extends Error {
    constructor(readonly statusCode: number, message: string) {
        super(message)
    }
}

export async function createRelayServer(options: CreateRelayServerOptions = {}): Promise<RelayServer> {
    const memory = createInMemoryRelayRepositories()
    const repositories: RelayRepositories = options.repositories ?? memory
    const clientAuthenticator = options.clientAuthenticator ?? new DenyAllClientAuthenticator()
    const gatewayAuthenticator = options.gatewayAuthenticator ?? new DenyAllGatewayAuthenticator()
    const connections = options.connectionRegistry ?? new GatewayConnectionRegistry()
    const eventStreams = new SessionEventStreams(repositories.events, options.eventStreams)
    const createSessionTimeoutMs = options.createSessionTimeoutMs ?? 30_000
    if (!Number.isSafeInteger(createSessionTimeoutMs) || createSessionTimeoutMs < 1) {
        throw new Error('createSessionTimeoutMs must be a positive safe integer')
    }
    const app = Fastify({ logger: options.logger ?? false, ...(options.https && { https: options.https }) }) as unknown as RelayServer
    app.decorate('relay', { repositories, connections, eventStreams })

    app.setErrorHandler((error: unknown, _request, reply) => {
        const statusCode = error instanceof HttpError ? error.statusCode : 500
        if (statusCode === 500) app.log.error(error)
        const message = error instanceof Error ? error.message : 'Internal server error'
        void reply.code(statusCode).send({ error: message })
    })

    await app.register(websocket)

    app.get('/health', async () => ({ status: 'ok' }))

    app.get('/v1/gateways', async (request, reply) => {
        const identity = await requireClient(request, reply, clientAuthenticator, 'gateway:list', {})
        if (!identity) return
        return { gateways: await repositories.gateways.list(identity.workspaceId) }
    })

    app.get('/v1/gateways/:gatewayId/projects', async (request, reply) => {
        const { gatewayId } = request.params as Required<Pick<IdParams, 'gatewayId'>>
        if (!await requireClient(request, reply, clientAuthenticator, 'project:list', { gatewayId })) return
        await requireGateway(repositories, gatewayId)
        return { gatewayId, projects: await repositories.projects.listByGateway(gatewayId) }
    })

    app.get('/v1/projects/:projectId/sessions', async (request, reply) => {
        const { projectId } = request.params as Required<Pick<IdParams, 'projectId'>>
        const project = await requireProject(repositories, projectId)
        if (!await requireClient(request, reply, clientAuthenticator, 'session:list', {
            gatewayId: project.gatewayId,
            projectId,
        })) return
        return { projectId, sessions: await repositories.sessions.listByProject(projectId) }
    })

    app.post('/v1/projects/:projectId/sessions', async (request, reply) => {
        const { projectId } = request.params as Required<Pick<IdParams, 'projectId'>>
        const project = await requireProject(repositories, projectId)
        const identity = await requireClient(request, reply, clientAuthenticator, 'session:create', {
            gatewayId: project.gatewayId,
            projectId,
        })
        if (!identity) return
        const body = parseInput(() => parseCreateSessionDto(request.body))
        const receipt = await routeCommand(reply, request, repositories, connections, identity, {
            gatewayId: project.gatewayId,
            projectId,
            sessionId: randomUUID(),
            command: {
                kind: 'session.create',
                provider: body.provider,
                config: body.config,
                ...(body.title && { title: body.title }),
                ...(body.model && { model: body.model }),
                ...(body.mode && { mode: body.mode }),
            },
        }, false)
        const command = await repositories.commands.get(receipt.commandId)
        if (!command) throw new HttpError(500, 'Session creation command was not persisted')
        const session = await waitForCreatedSession(repositories, command, createSessionTimeoutMs)
        reply.code(201)
        return { session }
    })

    app.get('/v1/sessions/:sessionId', async (request, reply) => {
        const session = await requireSession(repositories, (request.params as IdParams).sessionId!)
        if (!await requireClient(request, reply, clientAuthenticator, 'session:read', targetFor(session))) return
        return { session }
    })

    app.get('/v1/sessions/:sessionId/events', async (request, reply) => {
        const session = await requireSession(repositories, (request.params as IdParams).sessionId!)
        if (!await requireClient(request, reply, clientAuthenticator, 'event:list', targetFor(session))) return
        const rawAfter = (request.query as { after?: string }).after
        const after = rawAfter === undefined ? 0 : Number(rawAfter)
        if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, 'after must be a non-negative integer')
        const events = await repositories.events.listAfter(session.id, after)
        return { sessionId: session.id, events, nextAfter: events.at(-1)?.seq ?? null }
    })

    app.get('/v1/sessions/:sessionId/events/ws', {
        websocket: true,
        preValidation: async (request, reply) => {
            const session = await requireSession(repositories, (request.params as IdParams).sessionId!)
            if (!await requireClient(request, reply, clientAuthenticator, 'event:list', targetFor(session))) return
            parseAfter(request)
        },
    }, (socket, request) => {
        const sessionId = (request.params as IdParams).sessionId!
        const unsubscribe = eventStreams.subscribe(sessionId, parseAfter(request), socket)
        socket.once('close', unsubscribe)
        socket.once('error', unsubscribe)
    })

    app.post('/v1/sessions/:sessionId/messages', async (request, reply) => {
        const body = parseInput(() => parseSendMessageDto(request.body))
        return routeSessionCommand(request, reply, repositories, connections, clientAuthenticator, 'session:message', {
            kind: 'session.message', text: body.text, ...(body.attachmentIds && { attachmentIds: body.attachmentIds }),
        }, body.expiresAt)
    })

    app.post('/v1/sessions/:sessionId/cancel', async (request, reply) => {
        const body = parseInput(() => parseCancelSessionDto(request.body ?? {}))
        return routeSessionCommand(request, reply, repositories, connections, clientAuthenticator, 'session:cancel', {
            kind: 'session.cancel', ...(body.reason && { reason: body.reason }),
        })
    })

    app.patch('/v1/sessions/:sessionId/config', async (request, reply) => {
        const body = parseInput(() => parsePatchSessionConfigDto(request.body))
        return routeSessionCommand(request, reply, repositories, connections, clientAuthenticator, 'session:config', {
            kind: 'session.config.patch', config: body.config,
        })
    })

    app.post('/v1/sessions/:sessionId/decisions/:decisionId', async (request, reply) => {
        const body = parseInput(() => parseResolveDecisionDto(request.body))
        const decisionId = (request.params as IdParams).decisionId!
        return routeSessionCommand(request, reply, repositories, connections, clientAuthenticator, 'decision:respond', {
            kind: 'decision.respond', decisionId, value: body.value,
        })
    })

    app.get('/v1/gateway/connect', { websocket: true }, (socket, request) => {
        handleGatewaySocket(socket, request, repositories, connections, eventStreams, gatewayAuthenticator, app, {
            relayId: options.relayId ?? 'codever-relay',
            challengeTtlMs: options.challengeTtlMs ?? 30_000,
        })
    })

    return app
}

async function requireClient(
    request: FastifyRequest,
    reply: FastifyReply,
    authenticator: ClientAuthenticator,
    action: ClientAction,
    target: ClientAuthorizationTarget,
): Promise<ClientIdentity | undefined> {
    const identity = await authenticator.authenticate(request)
    if (!identity) {
        await reply.code(401).send({ error: 'Client authentication required' })
        return undefined
    }
    if (!await authenticator.authorize(identity, action, target)) {
        await reply.code(403).send({ error: 'Forbidden' })
        return undefined
    }
    return identity
}

async function requireGateway(repositories: RelayRepositories, gatewayId: string) {
    const gateway = await repositories.gateways.get(gatewayId)
    if (!gateway) throw new HttpError(404, 'Gateway not found')
    return gateway
}

async function requireProject(repositories: RelayRepositories, projectId: string) {
    const project = await repositories.projects.get(projectId)
    if (!project) throw new HttpError(404, 'Project not found')
    return project
}

async function requireSession(repositories: RelayRepositories, sessionId: string) {
    const session = await repositories.sessions.get(sessionId)
    if (!session) throw new HttpError(404, 'Session not found')
    return session
}

const targetFor = (session: Awaited<ReturnType<typeof requireSession>>): ClientAuthorizationTarget => ({
    gatewayId: session.gatewayId,
    projectId: session.projectId,
    sessionId: session.id,
})

function parseInput<T>(parser: () => T): T {
    try {
        return parser()
    } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'Invalid request')
    }
}

function parseAfter(request: FastifyRequest): number {
    const rawAfter = (request.query as { after?: string }).after
    const after = rawAfter === undefined ? 0 : Number(rawAfter)
    if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, 'after must be a non-negative integer')
    return after
}

async function routeSessionCommand(
    request: FastifyRequest,
    reply: FastifyReply,
    repositories: RelayRepositories,
    connections: GatewayConnectionRegistry,
    authenticator: ClientAuthenticator,
    action: ClientAction,
    command: GatewayCommand,
    expiresAt?: string,
): Promise<MutationReceiptDto | undefined> {
    const session = await requireSession(repositories, (request.params as IdParams).sessionId!)
    const identity = await requireClient(request, reply, authenticator, action, targetFor(session))
    if (!identity) return undefined
    return routeCommand(reply, request, repositories, connections, identity, {
        gatewayId: session.gatewayId,
        projectId: session.projectId,
        sessionId: session.id,
        command,
        ...(expiresAt && { expiresAt }),
    })
}

interface RouteCommandInput {
    gatewayId: string
    projectId: string
    sessionId: string
    command: GatewayCommand
    expiresAt?: string
}

async function routeCommand(
    reply: FastifyReply,
    request: FastifyRequest,
    repositories: RelayRepositories,
    connections: GatewayConnectionRegistry,
    identity: ClientIdentity,
    input: RouteCommandInput,
    setReplyStatus = true,
): Promise<MutationReceiptDto> {
    const idempotencyKey = request.headers['idempotency-key']
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) throw new HttpError(400, 'idempotency-key header is required')

    const existing = await repositories.commands.getByIdempotencyKey(input.gatewayId, idempotencyKey)
    if (existing) {
        if (setReplyStatus) reply.code(existing.status === 'relay_accepted' ? 202 : 200)
        return receipt(existing)
    }

    const connection = connections.get(input.gatewayId)
    if (!connection?.ready) throw new HttpError(503, 'gateway_offline')
    const now = new Date().toISOString()
    const commandId = randomUUID()
    const payload: CommandRequest = {
        commandId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        command: input.command,
        requestedAt: now,
        ...(input.expiresAt && { expiresAt: input.expiresAt }),
        actorId: identity.id,
        ...(identity.deviceId && { deviceId: identity.deviceId }),
    }
    const record = await repositories.commands.create({
        gatewayId: input.gatewayId,
        connectionEpoch: connection.connectionEpoch,
        idempotencyKey,
        request: payload,
        status: 'relay_accepted',
        relayAcceptedAt: now,
    })
    const frame: GatewayFrame = {
        version: 1,
        type: 'command.request',
        messageId: randomUUID(),
        gatewayId: input.gatewayId,
        connectionEpoch: connection.connectionEpoch,
        sessionId: input.sessionId,
        idempotencyKey,
        payload,
    }
    if (!connections.send(input.gatewayId, frame)) {
        const failure: CommandFailed = {
            commandId,
            failedAt: new Date().toISOString(),
            status: 'unknown',
            error: { code: 'connection_lost', message: 'Gateway connection was lost before routing', retryable: true },
        }
        await repositories.commands.markFailed(failure)
        throw new HttpError(503, 'gateway_connection_lost')
    }
    if (setReplyStatus) reply.code(202)
    return receipt(record)
}

async function waitForCreatedSession(
    repositories: RelayRepositories,
    initialCommand: CommandRecord,
    timeoutMs: number,
): Promise<Awaited<ReturnType<SessionRepository['get']>> & {}> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const session = await repositories.sessions.get(initialCommand.request.sessionId)
        if (session) {
            if (session.gatewayId !== initialCommand.gatewayId || session.projectId !== initialCommand.request.projectId) {
                throw new HttpError(502, 'Gateway reported created session under an unexpected project')
            }
            return session
        }
        const command = await repositories.commands.get(initialCommand.request.commandId)
        if (!command) throw new HttpError(500, 'Session creation command disappeared')
        if (command.status === 'rejected') throw new HttpError(409, command.failure?.error.message ?? 'Session creation rejected')
        if (command.status === 'expired') throw new HttpError(504, command.failure?.error.message ?? 'Session creation expired')
        if (command.status === 'unknown') throw new HttpError(502, command.failure?.error.message ?? 'Session creation outcome is unknown')
        await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))))
    }
    throw new HttpError(504, 'Timed out waiting for Gateway session inventory')
}

function receipt(record: CommandRecord): MutationReceiptDto {
    return {
        commandId: record.request.commandId,
        status: record.status,
        acceptedAt: record.gatewayAcceptedAt ?? record.relayAcceptedAt,
        ...(record.result && { completedAt: record.result.completedAt }),
        ...(record.failure && { completedAt: record.failure.failedAt, error: record.failure.error }),
    }
}

function handleGatewaySocket(
    socket: WebSocket,
    request: FastifyRequest,
    repositories: RelayRepositories,
    connections: GatewayConnectionRegistry,
    eventStreams: SessionEventStreams,
    authenticator: GatewayAuthenticator,
    app: FastifyInstance,
    options: { relayId: string; challengeTtlMs: number },
): void {
    const issuedAt = new Date()
    const challenge: GatewayHandshakeFrame = {
        version: 1,
        type: 'relay.auth.challenge',
        messageId: randomUUID(),
        payload: {
            relayId: options.relayId,
            challengeId: randomUUID(),
            nonce: randomBytes(32).toString('base64url'),
            issuedAt: issuedAt.toISOString(),
            expiresAt: new Date(issuedAt.getTime() + options.challengeTtlMs).toISOString(),
        },
    }
    socket.send(JSON.stringify(challenge))

    let gatewayId: string | undefined
    let epoch: string | undefined
    let helloReceived = false

    socket.on('message', data => {
        void (async () => {
            if (!epoch) {
                let response: GatewayHandshakeFrame
                try {
                    response = parseGatewayHandshakeFrame(JSON.parse(data.toString()))
                } catch {
                    rejectGateway(socket, 'protocol_error', 'Invalid authentication frame')
                    return
                }
                if (response.type !== 'gateway.auth.response') {
                    rejectGateway(socket, 'protocol_error', 'gateway.auth.response must follow the challenge')
                    return
                }
                if (Date.now() > Date.parse(challenge.payload.expiresAt)) {
                    rejectGateway(socket, 'expired_challenge', 'Authentication challenge expired')
                    return
                }
                const result = await authenticator.verify({ request, challenge: challenge.payload, response: response.payload })
                if (!result.authenticated) {
                    rejectGateway(socket, result.code, result.message)
                    return
                }
                gatewayId = response.payload.gatewayId
                epoch = randomUUID()
                connections.replace({ gatewayId, connectionEpoch: epoch, socket })
                const accepted: GatewayHandshakeFrame = {
                    version: 1,
                    type: 'relay.auth.accepted',
                    messageId: randomUUID(),
                    payload: { gatewayId, connectionEpoch: epoch, acceptedAt: new Date().toISOString() },
                }
                socket.send(JSON.stringify(accepted))
                return
            }

            let frame: GatewayFrame
            try {
                frame = parseGatewayFrame(JSON.parse(data.toString()))
            } catch {
                socket.close(1008, 'Invalid protocol frame')
                return
            }
            if (frame.gatewayId !== gatewayId || frame.connectionEpoch !== epoch) {
                socket.close(1008, 'Gateway identity or connection epoch mismatch')
                return
            }
            if (!helloReceived) {
                if (frame.type !== 'gateway.hello') {
                    socket.close(1008, 'gateway.hello must be the first frame')
                    return
                }
                helloReceived = true
                await repositories.gateways.upsert({
                    id: gatewayId,
                    workspaceId: frame.payload.workspaceId,
                    name: frame.payload.name,
                    platform: frame.payload.platform,
                    version: frame.payload.gatewayVersion,
                    capabilities: frame.payload.capabilities,
                    status: 'online',
                    connectionEpoch: epoch,
                    lastSeenAt: frame.payload.connectedAt,
                })
                if (!connections.markReady(gatewayId, epoch, socket)) {
                    socket.close(4001, 'Stale connection epoch')
                }
                return
            }
            if (!connections.isCurrent(gatewayId, epoch, socket)) {
                socket.close(4001, 'Stale connection epoch')
                return
            }
            await consumeGatewayFrame(frame, repositories, connections, eventStreams, socket)
        })().catch(error => {
            app.log.error(error)
            socket.close(1011, 'Failed to process frame')
        })
    })

    socket.on('close', () => {
        if (gatewayId && epoch && connections.removeIfCurrent(gatewayId, epoch, socket)) {
            void repositories.gateways.updateConnection(gatewayId, 'offline', undefined, new Date().toISOString())
        }
    })
}

function rejectGateway(
    socket: WebSocket,
    code: Extract<GatewayHandshakeFrame, { type: 'relay.auth.rejected' }>['payload']['code'],
    message: string,
): void {
    const frame: GatewayHandshakeFrame = {
        version: 1,
        type: 'relay.auth.rejected',
        messageId: randomUUID(),
        payload: { code, message },
    }
    socket.send(JSON.stringify(frame), () => socket.close(1008, message))
}

async function consumeGatewayFrame(
    frame: GatewayFrame,
    repositories: RelayRepositories,
    connections: GatewayConnectionRegistry,
    eventStreams: SessionEventStreams,
    socket: WebSocket,
): Promise<void> {
    switch (frame.type) {
        case 'gateway.heartbeat':
            await repositories.gateways.updateConnection(frame.gatewayId, 'online', frame.connectionEpoch, frame.payload.sentAt)
            return
        case 'gateway.inventory.snapshot': {
            if (frame.payload.projects.some(project => project.gatewayId !== frame.gatewayId)) {
                throw new Error('Inventory project belongs to a different gateway')
            }
            const projectIds = new Set(frame.payload.projects.map(project => project.id))
            if (frame.payload.sessions.some(session => session.gatewayId !== frame.gatewayId || !projectIds.has(session.projectId))) {
                throw new Error('Inventory session does not belong to this gateway snapshot')
            }
            await repositories.projects.replaceForGateway(frame.gatewayId, frame.payload.projects)
            await repositories.sessions.replaceForGateway(frame.gatewayId, frame.payload.sessions)
            const cursors = await Promise.all(frame.payload.sessions.map(async session => ({
                sessionId: session.id,
                afterSeq: await repositories.events.highestSeq(session.id),
            })))
            const syncRequest: GatewayFrame = {
                version: 1,
                type: 'sync.request',
                messageId: randomUUID(),
                gatewayId: frame.gatewayId,
                connectionEpoch: frame.connectionEpoch,
                payload: { cursors, includeInventory: false },
            }
            if (!connections.send(frame.gatewayId, syncRequest)) throw new Error('Connection lost before sync request')
            return
        }
        case 'session.event.batch': {
            if (frame.payload.events.some(event => event.gatewayId !== frame.gatewayId)) {
                throw new Error('Event belongs to a different gateway')
            }
            for (const event of frame.payload.events) {
                const session = await repositories.sessions.get(event.sessionId)
                if (!session || session.gatewayId !== frame.gatewayId || session.projectId !== event.projectId) {
                    throw new Error(`Event references unknown or mismatched session ${event.sessionId}`)
                }
            }
            const result = await repositories.events.append(frame.payload.events)
            eventStreams.publish(frame.payload.events.map(event => event.sessionId))
            const ack: GatewayFrame = {
                version: 1,
                type: 'session.event.ack',
                messageId: randomUUID(),
                gatewayId: frame.gatewayId,
                connectionEpoch: frame.connectionEpoch,
                payload: { cursors: result.cursors },
            }
            if (!connections.send(frame.gatewayId, ack)) throw new Error('Connection lost before event acknowledgement')
            return
        }
        case 'command.accepted': {
            const command = await requireCurrentCommand(repositories.commands, frame)
            await repositories.commands.markAccepted(command.request.commandId, frame.payload.acceptedAt)
            return
        }
        case 'command.result':
            await requireCurrentCommand(repositories.commands, frame)
            await repositories.commands.markResult(frame.payload)
            return
        case 'command.failed':
            await requireCurrentCommand(repositories.commands, frame)
            await repositories.commands.markFailed(frame.payload)
            return
        case 'sync.complete':
            for (const cursor of frame.payload.cursors) {
                const session = await repositories.sessions.get(cursor.sessionId)
                if (!session || session.gatewayId !== frame.gatewayId) {
                    throw new Error(`Sync completion references unknown or mismatched session ${cursor.sessionId}`)
                }
            }
            return
        default:
            socket.close(1008, `Unexpected gateway frame type: ${frame.type}`)
    }
}

async function requireCurrentCommand(repository: CommandRepository, frame: GatewayFrame): Promise<CommandRecord> {
    if (!('commandId' in frame.payload)) throw new Error('Frame has no command')
    const command = await repository.get(frame.payload.commandId)
    if (!command || command.gatewayId !== frame.gatewayId || command.connectionEpoch !== frame.connectionEpoch) {
        throw new Error(`Unknown or stale command ${frame.payload.commandId}`)
    }
    return command
}
