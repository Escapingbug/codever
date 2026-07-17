import { randomBytes, randomUUID } from 'node:crypto'
import type { ServerOptions as HttpsServerOptions } from 'node:https'
import websocket from '@fastify/websocket'
import {
    parseCancelSessionDto,
    parseCreateSessionDto,
    parseGatewayFrame,
    parseGatewayHandshakeFrame,
    parseGatewayEnrollmentChallengeRequest,
    parseGatewayEnrollmentProofDto,
    parseGatewaySecureHandshakeFrame,
    parseClientDeviceTunnelFrame,
    parseSecureDataFrame,
    parseSecureControlFrame,
    parseApproveGatewayEnrollmentDto,
    parseRejectGatewayEnrollmentDto,
    parseAuthSessionDto,
    parseLoginDto,
    parseLoginResultDto,
    parsePatchSessionConfigDto,
    parseProviderSessionListDto,
    parseResolveDecisionDto,
    parseSendMessageDto,
    type CommandFailed,
    type CommandRequest,
    type GatewayCommand,
    type GatewayFrame,
    type GatewayHandshakeFrame,
    type GatewaySecureHandshakeFrame,
    type MutationReceiptDto,
    type JsonValue,
} from '@codever/protocol'
import { SessionCipher } from '@codever/secure-channel'
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
import {
    selectWebSocketProtocol,
    type AccountSessionService,
} from './accountAuth'
import { GatewayConnectionRegistry } from './connectionRegistry'
import { DeviceTunnelRegistry } from './deviceTunnelRegistry'
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
import {
    BootstrapRequiredError,
    EnrollmentChallengeStore,
    EnrollmentConflictError,
    EnrollmentExpiredError,
    EnrollmentNotFoundError,
    EnrollmentRateLimitError,
    GatewayEnrollmentRepository,
} from './enrollmentRepository'
import type { SecureGatewayAuthenticator } from './secureGatewayAuth'

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
    accountService?: AccountSessionService
    enrollmentRepository?: GatewayEnrollmentRepository
    enrollmentChallengeStore?: EnrollmentChallengeStore
    enrollmentTtlMs?: number
    secureGatewayAuthenticator?: SecureGatewayAuthenticator
    deviceTunnelRegistry?: DeviceTunnelRegistry
}

export interface RelayServer extends FastifyInstance {
    relay: {
        repositories: RelayRepositories
        connections: GatewayConnectionRegistry
        eventStreams: SessionEventStreams
        deviceTunnels: DeviceTunnelRegistry
    }
}

interface IdParams {
    gatewayId?: string
    projectId?: string
    sessionId?: string
    decisionId?: string
    provider?: string
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
    const deviceTunnels = options.deviceTunnelRegistry ?? new DeviceTunnelRegistry()
    const eventStreams = new SessionEventStreams(repositories.events, options.eventStreams)
    const createSessionTimeoutMs = options.createSessionTimeoutMs ?? 30_000
    const enrollmentTtlMs = options.enrollmentTtlMs ?? 10 * 60_000
    const enrollmentRepository = options.enrollmentRepository
    const enrollmentChallenges = options.enrollmentChallengeStore ?? (enrollmentRepository
        ? new EnrollmentChallengeStore(enrollmentRepository, { relayId: options.relayId ?? 'codever-relay' })
        : undefined)
    if (!Number.isSafeInteger(createSessionTimeoutMs) || createSessionTimeoutMs < 1) {
        throw new Error('createSessionTimeoutMs must be a positive safe integer')
    }
    const app = Fastify({ logger: options.logger ?? false, ...(options.https && { https: options.https }) }) as unknown as RelayServer
    app.decorate('relay', { repositories, connections, eventStreams, deviceTunnels })

    app.setErrorHandler((error: unknown, _request, reply) => {
        const statusCode = error instanceof HttpError ? error.statusCode : 500
        if (statusCode === 500) app.log.error(error)
        const message = error instanceof Error ? error.message : 'Internal server error'
        void reply.code(statusCode).send({ error: message })
    })

    await app.register(websocket, { options: { handleProtocols: selectWebSocketProtocol } })

    app.get('/health', async () => ({ status: 'ok' }))

    app.post('/v1/gateway-enrollments/challenge', async (request, reply) => {
        if (!enrollmentChallenges) throw new HttpError(503, 'Gateway enrollment is not configured')
        try {
            const input = parseInput(() => parseGatewayEnrollmentChallengeRequest(request.body))
            return enrollmentChallenges.issue(input, request.ip)
        } catch (error) {
            throw enrollmentHttpError(error)
        }
    })

    app.post('/v1/gateway-enrollments/proof', async (request, reply) => {
        if (!enrollmentChallenges) throw new HttpError(503, 'Gateway enrollment is not configured')
        try {
            const proof = parseInput(() => parseGatewayEnrollmentProofDto(request.body))
            const result = await enrollmentChallenges.prove(proof, enrollmentTtlMs, request.ip)
            reply.code(result.status === 'approved' ? 200 : 201)
            return result
        } catch (error) {
            throw enrollmentHttpError(error)
        }
    })

    app.get('/v1/gateway-enrollments', async (request, reply) => {
        if (!enrollmentRepository) throw new HttpError(503, 'Gateway enrollment is not configured')
        const identity = await requireClient(request, reply, clientAuthenticator, 'gateway:enrollment:list', {})
        if (!identity) return
        return { bootstrapComplete: enrollmentRepository.bootstrapComplete, enrollments: await enrollmentRepository.listPending(identity.workspaceId) }
    })

    app.get('/v1/gateway-enrollments/:code', async (request, reply) => {
        if (!enrollmentRepository) throw new HttpError(503, 'Gateway enrollment is not configured')
        const identity = await requireClient(request, reply, clientAuthenticator, 'gateway:enrollment:list', {})
        if (!identity) return
        const value = await enrollmentRepository.getByCode((request.params as { code: string }).code.toUpperCase())
        if (!value || value.workspaceId !== identity.workspaceId) throw new HttpError(404, 'Pending Gateway enrollment not found')
        return value
    })

    app.post('/v1/gateway-enrollments/:code/approve', async (request, reply) => {
        if (!enrollmentRepository) throw new HttpError(503, 'Gateway enrollment is not configured')
        const identity = await requireClient(request, reply, clientAuthenticator, 'gateway:enrollment:approve', {})
        if (!identity) return
        const body = parseInput(() => parseApproveGatewayEnrollmentDto(request.body))
        try {
            return await enrollmentRepository.approve((request.params as { code: string }).code.toUpperCase(), 'client', { workspaceId: identity.workspaceId, ...body })
        } catch (error) {
            throw enrollmentHttpError(error)
        }
    })

    app.post('/v1/gateway-enrollments/:code/reject', async (request, reply) => {
        if (!enrollmentRepository) throw new HttpError(503, 'Gateway enrollment is not configured')
        const identity = await requireClient(request, reply, clientAuthenticator, 'gateway:enrollment:reject', {})
        if (!identity) return
        const body = parseInput(() => parseRejectGatewayEnrollmentDto(request.body ?? {}))
        try {
            return await enrollmentRepository.reject((request.params as { code: string }).code.toUpperCase(), body.reason, identity.workspaceId)
        } catch (error) {
            throw enrollmentHttpError(error)
        }
    })

    app.get('/v1/enrolled-gateways', async (request, reply) => {
        if (!enrollmentRepository) throw new HttpError(503, 'Gateway enrollment is not configured')
        const identity = await requireClient(request, reply, clientAuthenticator, 'gateway:enrollment:list', {})
        if (!identity) return
        return { gateways: await enrollmentRepository.listEnrolled(identity.workspaceId) }
    })

    app.post('/v1/enrolled-gateways/:gatewayId/revoke', async (request, reply) => {
        if (!enrollmentRepository) throw new HttpError(503, 'Gateway enrollment is not configured')
        const identity = await requireClient(request, reply, clientAuthenticator, 'gateway:revoke', {})
        if (!identity) return
        try {
            return await enrollmentRepository.revoke((request.params as { gatewayId: string }).gatewayId, identity.workspaceId)
        } catch (error) {
            throw enrollmentHttpError(error)
        }
    })

    app.post('/v1/auth/login', async (request, reply) => {
        if (!options.accountService) throw new HttpError(503, 'Account authentication is not configured')
        const input = parseInput(() => parseLoginDto(request.body))
        const session = await options.accountService.login(input)
        if (!session) {
            await reply.code(401).send({ error: 'Invalid username or password' })
            return
        }
        return parseLoginResultDto(session)
    })

    app.get('/v1/auth/session', async (request, reply) => {
        if (!options.accountService) throw new HttpError(503, 'Account authentication is not configured')
        const session = await options.accountService.current(request)
        if (!session) {
            await reply.code(401).send({ error: 'Client authentication required' })
            return
        }
        return parseAuthSessionDto(session)
    })

    app.post('/v1/auth/logout', async (request, reply) => {
        if (!options.accountService) throw new HttpError(503, 'Account authentication is not configured')
        if (!await options.accountService.logout(request)) {
            await reply.code(401).send({ error: 'Client authentication required' })
            return
        }
        await reply.code(204).send()
    })

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

    app.post('/v1/projects/:projectId/providers/:provider/sessions/discover', async (request, reply) => {
        const { projectId, provider } = request.params as Required<Pick<IdParams, 'projectId' | 'provider'>>
        const project = await requireProject(repositories, projectId)
        const identity = await requireClient(request, reply, clientAuthenticator, 'session:list', {
            gatewayId: project.gatewayId,
            projectId,
        })
        if (!identity) return
        const receipt = await routeCommand(reply, request, repositories, connections, identity, {
            gatewayId: project.gatewayId,
            projectId,
            sessionId: randomUUID(),
            command: { kind: 'provider.sessions.list', provider },
        }, false)
        const command = await repositories.commands.get(receipt.commandId)
        if (!command) throw new HttpError(500, 'Provider discovery command was not persisted')
        const result = await waitForCommandResult(repositories.commands, command, createSessionTimeoutMs)
        return parseProviderSessionListDto(result)
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
                ...(body.providerSessionId && { providerSessionId: body.providerSessionId }),
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

    app.get('/v2/device/connect/:gatewayId', {
        websocket: true,
        preValidation: async (request, reply) => {
            const { gatewayId } = request.params as Required<Pick<IdParams, 'gatewayId'>>
            await requireGateway(repositories, gatewayId)
            await requireClient(request, reply, clientAuthenticator, 'gateway:tunnel', { gatewayId })
        },
    }, (socket, request) => {
        const { gatewayId } = request.params as Required<Pick<IdParams, 'gatewayId'>>
        handleDeviceTunnelSocket(socket, gatewayId, connections, deviceTunnels, app)
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
            kind: 'session.config.patch',
            config: body.config,
            ...('model' in body ? { model: body.model } : {}),
            ...('mode' in body ? { mode: body.mode } : {}),
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
        handleGatewaySocket(socket, request, repositories, connections, eventStreams, deviceTunnels, gatewayAuthenticator, app, {
            relayId: options.relayId ?? 'codever-relay',
            challengeTtlMs: options.challengeTtlMs ?? 30_000,
        })
    })

    app.get('/v2/gateway/connect', { websocket: true }, (socket, request) => {
        if (!options.secureGatewayAuthenticator) {
            socket.close(1013, 'Secure Gateway authentication is not configured')
            return
        }
        handleSecureGatewaySocket(
            socket, request, repositories, connections, eventStreams,
            options.secureGatewayAuthenticator, deviceTunnels, app,
        )
    })

    return app
}

function handleDeviceTunnelSocket(
    socket: WebSocket,
    gatewayId: string,
    connections: GatewayConnectionRegistry,
    tunnels: DeviceTunnelRegistry,
    app: FastifyInstance,
): void {
    let tunnelId: string | undefined
    let incoming = Promise.resolve()

    socket.on('message', data => {
        incoming = incoming.then(async () => {
            const frame = parseClientDeviceTunnelFrame(JSON.parse(data.toString()) as unknown)
            const connection = connections.get(gatewayId)
            if (!connection?.ready) {
                socket.close(1013, 'Gateway is offline')
                return
            }
            if (!tunnelId) {
                if (frame.type !== 'device.tunnel.open' || frame.payload.gatewayId !== gatewayId) {
                    socket.close(1008, 'device.tunnel.open must be the first frame')
                    return
                }
                tunnelId = tunnels.open(gatewayId, socket)
                const openedAt = new Date().toISOString()
                if (!connections.send(gatewayId, {
                    version: 1,
                    type: 'device.tunnel.open',
                    messageId: randomUUID(),
                    gatewayId,
                    connectionEpoch: connection.connectionEpoch,
                    payload: { tunnelId, openedAt },
                })) {
                    tunnels.close(tunnelId, 'gateway_offline', 'Gateway connection was lost')
                    return
                }
                socket.send(JSON.stringify({
                    version: 1,
                    type: 'relay.device-tunnel.opened',
                    messageId: randomUUID(),
                    payload: { gatewayId, tunnelId, openedAt },
                }))
                return
            }
            if (frame.type === 'device.tunnel.data') {
                if (!tunnels.owns(frame.payload.tunnelId, gatewayId, socket)) {
                    socket.close(1008, 'Device tunnel ID mismatch')
                    return
                }
                if (!connections.send(gatewayId, {
                    version: 1,
                    type: 'device.tunnel.data',
                    messageId: randomUUID(),
                    gatewayId,
                    connectionEpoch: connection.connectionEpoch,
                    payload: { tunnelId, opaquePayload: frame.payload.opaquePayload },
                })) tunnels.close(tunnelId, 'gateway_offline', 'Gateway connection was lost')
                return
            }
            if (frame.type === 'device.tunnel.close') {
                if (!tunnels.owns(frame.payload.tunnelId, gatewayId, socket)) {
                    socket.close(1008, 'Device tunnel ID mismatch')
                    return
                }
                connections.send(gatewayId, {
                    version: 1,
                    type: 'device.tunnel.close',
                    messageId: randomUUID(),
                    gatewayId,
                    connectionEpoch: connection.connectionEpoch,
                    payload: { tunnelId, code: 'normal', ...(frame.payload.reason ? { reason: frame.payload.reason } : {}) },
                })
                tunnels.close(tunnelId, 'normal', frame.payload.reason)
                tunnelId = undefined
                return
            }
            socket.close(1008, 'Unexpected device tunnel frame')
        }).catch(error => {
            app.log.error(error)
            if (tunnelId) tunnels.close(tunnelId, 'protocol_error', 'Invalid device tunnel frame')
            else socket.close(1008, 'Invalid device tunnel frame')
        })
    })

    socket.on('close', () => {
        for (const removedId of tunnels.removeSocket(socket)) {
            const connection = connections.get(gatewayId)
            if (!connection?.ready) continue
            connections.send(gatewayId, {
                version: 1,
                type: 'device.tunnel.close',
                messageId: randomUUID(),
                gatewayId,
                connectionEpoch: connection.connectionEpoch,
                payload: { tunnelId: removedId, code: 'normal', reason: 'Device connection closed' },
            })
        }
    })
}

function handleSecureGatewaySocket(
    socket: WebSocket,
    _request: FastifyRequest,
    repositories: RelayRepositories,
    connections: GatewayConnectionRegistry,
    eventStreams: SessionEventStreams,
    authenticator: SecureGatewayAuthenticator,
    deviceTunnels: DeviceTunnelRegistry,
    app: FastifyInstance,
): void {
    let pendingHandshakeId: string | undefined
    let claimedGatewayId: string | undefined
    let gatewayId: string | undefined
    let epoch: string | undefined
    let cipher: SessionCipher | undefined
    let helloReceived = false
    let credentialProvisioningRequired = false
    let credentialRegistrationStarted = false
    let incoming = Promise.resolve()

    socket.on('message', data => {
        incoming = incoming.then(async () => {
            const value = JSON.parse(data.toString()) as unknown
            if (!cipher) {
                const frame = parseGatewaySecureHandshakeFrame(value)
                if (!pendingHandshakeId) {
                    if (frame.type !== 'gateway.secure-auth.start') throw new Error('Secure authentication must start with gateway.secure-auth.start')
                    claimedGatewayId = frame.payload.gatewayId
                    const started = await authenticator.begin(frame.payload)
                    pendingHandshakeId = started.handshakeId
                    const response: GatewaySecureHandshakeFrame = {
                        version: 1,
                        type: 'relay.secure-auth.response',
                        messageId: randomUUID(),
                        payload: {
                            relayId: authenticator.relayId,
                            handshakeId: started.handshakeId,
                            loginResponse: started.loginResponse,
                            expiresAt: started.expiresAt,
                            ...(started.attemptsRemaining !== undefined ? { attemptsRemaining: started.attemptsRemaining } : {}),
                        },
                    }
                    socket.send(JSON.stringify(response))
                    return
                }
                if (frame.type !== 'gateway.secure-auth.finish' || frame.payload.handshakeId !== pendingHandshakeId) {
                    throw new Error('Secure authentication finish does not match the active handshake')
                }
                const finished = await authenticator.finish(frame.payload)
                if (finished.gatewayId !== claimedGatewayId) throw new Error('Authenticated Gateway identity changed')
                gatewayId = finished.gatewayId
                epoch = randomUUID()
                const channelId = randomUUID()
                cipher = await SessionCipher.create({
                    sessionKey: finished.sessionKey,
                    role: 'responder',
                    channelId,
                })
                credentialProvisioningRequired = finished.credentialProvisioningRequired
                const activeCipher = cipher
                const replaced = connections.replace({
                    gatewayId,
                    connectionEpoch: epoch,
                    socket,
                    encode: async frameToSend => JSON.stringify({
                        version: 1,
                        type: 'secure.data',
                        messageId: randomUUID(),
                        envelope: await activeCipher.encrypt(frameToSend),
                    }),
                })
                if (replaced) deviceTunnels.closeGateway(gatewayId, 'gateway_replaced', 'Gateway connection was replaced')
                const acceptedPayload = {
                    gatewayId,
                    connectionEpoch: epoch,
                    acceptedAt: new Date().toISOString(),
                    credentialProvisioningRequired: finished.credentialProvisioningRequired,
                }
                const accepted: GatewaySecureHandshakeFrame = {
                    version: 1,
                    type: 'relay.secure-auth.accepted',
                    messageId: randomUUID(),
                    payload: {
                        handshakeId: pendingHandshakeId,
                        envelope: await activeCipher.encrypt(acceptedPayload),
                    },
                }
                socket.send(JSON.stringify(accepted))
                return
            }

            const secureFrame = parseSecureDataFrame(value)
            const decrypted = await cipher.decrypt(secureFrame.envelope)
            if (credentialProvisioningRequired) {
                const control = parseSecureControlFrame(decrypted)
                if (control.type === 'gateway.credential.registration.start') {
                    if (control.payload.gatewayId !== gatewayId || credentialRegistrationStarted) {
                        throw new Error('Invalid credential registration start')
                    }
                    credentialRegistrationStarted = true
                    const response = await authenticator.createCredentialRegistrationResponse(
                        gatewayId!, control.payload.registrationRequest,
                    )
                    socket.send(JSON.stringify({
                        version: 1,
                        type: 'secure.data',
                        messageId: randomUUID(),
                        envelope: await cipher.encrypt({
                            version: 1,
                            type: 'relay.credential.registration.response',
                            messageId: randomUUID(),
                            payload: { gatewayId, ...response },
                        }),
                    }))
                    return
                }
                if (control.type === 'gateway.credential.registration.commit') {
                    if (control.payload.gatewayId !== gatewayId || !credentialRegistrationStarted) {
                        throw new Error('Invalid credential registration commit')
                    }
                    await authenticator.commitCredential(gatewayId!, control.payload.registrationRecord)
                    credentialProvisioningRequired = false
                    socket.send(JSON.stringify({
                        version: 1,
                        type: 'secure.data',
                        messageId: randomUUID(),
                        envelope: await cipher.encrypt({
                            version: 1,
                            type: 'relay.credential.registration.accepted',
                            messageId: randomUUID(),
                            payload: { gatewayId, registeredAt: new Date().toISOString() },
                        }),
                    }))
                    return
                }
                throw new Error('Gateway credential provisioning must complete before application data')
            }
            const frame = parseGatewayFrame(decrypted)
            if (frame.gatewayId !== gatewayId || frame.connectionEpoch !== epoch) {
                throw new Error('Gateway identity or connection epoch mismatch')
            }
            if (!helloReceived) {
                if (frame.type !== 'gateway.hello') throw new Error('gateway.hello must be the first encrypted data frame')
                helloReceived = true
                await repositories.gateways.upsert({
                    id: gatewayId!,
                    workspaceId: frame.payload.workspaceId,
                    name: frame.payload.name,
                    platform: frame.payload.platform,
                    version: frame.payload.gatewayVersion,
                    capabilities: frame.payload.capabilities,
                    status: 'online',
                    connectionEpoch: epoch,
                    lastSeenAt: frame.payload.connectedAt,
                })
                if (!connections.markReady(gatewayId!, epoch!, socket)) throw new Error('Stale secure connection epoch')
                return
            }
            if (!connections.isCurrent(gatewayId!, epoch!, socket)) throw new Error('Stale secure connection epoch')
            await consumeGatewayFrame(frame, repositories, connections, eventStreams, deviceTunnels, socket)
        }).catch(error => {
            app.log.error(error)
            const rejection: GatewaySecureHandshakeFrame = {
                version: 1,
                type: 'relay.secure-auth.rejected',
                messageId: randomUUID(),
                payload: { code: 'authentication_failed', message: 'Secure Gateway authentication failed' },
            }
            if (!cipher && socket.readyState === socket.OPEN) socket.send(JSON.stringify(rejection))
            socket.close(1008, 'Secure Gateway protocol error')
        })
    })

    socket.on('close', () => {
        if (gatewayId && epoch && connections.removeIfCurrent(gatewayId, epoch, socket)) {
            deviceTunnels.closeGateway(gatewayId, 'gateway_offline', 'Gateway disconnected')
            void repositories.gateways.updateConnection(gatewayId, 'offline', undefined, new Date().toISOString())
        }
    })
}

function enrollmentHttpError(error: unknown): HttpError {
    if (error instanceof HttpError) return error
    if (error instanceof EnrollmentNotFoundError) return new HttpError(404, error.message)
    if (error instanceof EnrollmentExpiredError) return new HttpError(410, error.message)
    if (error instanceof EnrollmentRateLimitError) return new HttpError(429, error.message || 'Too many enrollment attempts')
    if (error instanceof EnrollmentConflictError) return new HttpError(409, error.message)
    if (error instanceof BootstrapRequiredError) return new HttpError(409, error.message)
    return error instanceof Error ? new HttpError(400, error.message) : new HttpError(400, 'Invalid enrollment request')
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

async function waitForCommandResult(
    repository: CommandRepository,
    initialCommand: CommandRecord,
    timeoutMs: number,
): Promise<JsonValue | undefined> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const command = await repository.get(initialCommand.request.commandId)
        if (!command) throw new HttpError(500, 'Gateway command disappeared')
        if (command.status === 'completed') return command.result?.result
        if (command.status === 'rejected') throw new HttpError(409, command.failure?.error.message ?? 'Gateway command rejected')
        if (command.status === 'expired') throw new HttpError(504, command.failure?.error.message ?? 'Gateway command expired')
        if (command.status === 'unknown') throw new HttpError(502, command.failure?.error.message ?? 'Gateway command outcome is unknown')
        await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))))
    }
    throw new HttpError(504, 'Timed out waiting for Gateway provider sessions')
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
    deviceTunnels: DeviceTunnelRegistry,
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
                const replaced = connections.replace({ gatewayId, connectionEpoch: epoch, socket })
                if (replaced) deviceTunnels.closeGateway(gatewayId, 'gateway_replaced', 'Gateway connection was replaced')
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
            await consumeGatewayFrame(frame, repositories, connections, eventStreams, deviceTunnels, socket)
        })().catch(error => {
            app.log.error(error)
            socket.close(1011, 'Failed to process frame')
        })
    })

    socket.on('close', () => {
        if (gatewayId && epoch && connections.removeIfCurrent(gatewayId, epoch, socket)) {
            deviceTunnels.closeGateway(gatewayId, 'gateway_offline', 'Gateway disconnected')
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
    deviceTunnels: DeviceTunnelRegistry,
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
        case 'device.tunnel.data':
            if (!deviceTunnels.send(frame.gatewayId, frame.payload.tunnelId, frame.payload.opaquePayload)) {
                throw new Error(`Unknown device tunnel ${frame.payload.tunnelId}`)
            }
            return
        case 'device.tunnel.close':
            deviceTunnels.close(
                frame.payload.tunnelId,
                frame.payload.code ?? 'normal',
                frame.payload.reason,
            )
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
