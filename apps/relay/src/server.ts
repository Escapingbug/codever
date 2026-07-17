import { randomUUID } from 'node:crypto'
import websocket from '@fastify/websocket'
import {
    parseGatewayFrame,
    parseGatewaySecureHandshakeFrame,
    parseSecureControlFrame,
    parseSecureDataFrame,
    type GatewayFrame,
    type GatewaySecureHandshakeFrame,
} from '@codever/protocol'
import { SessionCipher } from '@codever/secure-channel'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import type WebSocket from 'ws'
import { ClientConnectionRegistry } from './clientConnectionRegistry'
import { ClientSecureSession } from './clientSecureSession'
import { GatewayConnectionRegistry } from './connectionRegistry'
import { DeviceTunnelRegistry } from './deviceTunnelRegistry'
import { InMemoryGatewayRepository } from './memoryRepositories'
import type { GatewayRepository } from './repositories'
import type { SecureGatewayAuthenticator } from './secureGatewayAuth'
import type { SecureClientAuthenticator } from './secureClientAuth'

export interface RelayRepositories {
    gateways: GatewayRepository
}

export interface CreateRelayServerOptions {
    repositories?: RelayRepositories
    connectionRegistry?: GatewayConnectionRegistry
    clientConnectionRegistry?: ClientConnectionRegistry
    logger?: boolean
    secureGatewayAuthenticator?: SecureGatewayAuthenticator
    secureClientAuthenticator?: SecureClientAuthenticator
    deviceTunnelRegistry?: DeviceTunnelRegistry
}

export interface RelayServer extends FastifyInstance {
    relay: {
        repositories: RelayRepositories
        connections: GatewayConnectionRegistry
        clients: ClientConnectionRegistry
        deviceTunnels: DeviceTunnelRegistry
    }
}

export async function createRelayServer(options: CreateRelayServerOptions = {}): Promise<RelayServer> {
    const repositories = options.repositories ?? { gateways: new InMemoryGatewayRepository() }
    const connections = options.connectionRegistry ?? new GatewayConnectionRegistry()
    const clients = options.clientConnectionRegistry ?? new ClientConnectionRegistry()
    const deviceTunnels = options.deviceTunnelRegistry ?? new DeviceTunnelRegistry()
    const app = Fastify({ logger: options.logger ?? false }) as unknown as RelayServer
    app.decorate('relay', { repositories, connections, clients, deviceTunnels })

    app.setErrorHandler((error: unknown, _request, reply) => {
        const statusCode = 500
        app.log.error(error)
        const message = error instanceof Error ? error.message : 'Internal server error'
        void reply.code(statusCode).send({ error: message })
    })

    await app.register(websocket)

    app.get('/health', async () => ({ status: 'ok' }))

    app.get('/v2/client/connect', { websocket: true }, socket => {
        if (!options.secureClientAuthenticator) {
            socket.close(1013, 'Secure Client authentication is not configured')
            return
        }
        const session = new ClientSecureSession({
            socket,
            authenticator: options.secureClientAuthenticator,
            repositories,
            clients,
            gateways: connections,
            tunnels: deviceTunnels,
            logError: error => app.log.error(error),
        })
        socket.on('message', data => {
            try {
                session.receive(JSON.parse(data.toString()) as unknown)
            } catch (error) {
                app.log.error(error)
                socket.close(1008, 'Invalid Client frame')
            }
        })
        socket.on('close', () => session.disconnected())
    })

    app.get('/v2/gateway/connect', { websocket: true }, (socket, request) => {
        if (!options.secureGatewayAuthenticator) {
            socket.close(1013, 'Secure Gateway authentication is not configured')
            return
        }
        handleSecureGatewaySocket(
            socket,
            request,
            repositories,
            connections,
            options.secureGatewayAuthenticator,
            deviceTunnels,
            app,
        )
    })

    return app
}

function gatewayTunnelFrame<T extends 'device.tunnel.open' | 'device.tunnel.data' | 'device.tunnel.close'>(
    type: T,
    gatewayId: string,
    connectionEpoch: string,
    payload: Extract<GatewayFrame, { type: T }>['payload'],
): Extract<GatewayFrame, { type: T }> {
    return { version: 1, type, messageId: randomUUID(), gatewayId, connectionEpoch, payload } as Extract<GatewayFrame, { type: T }>
}

function handleSecureGatewaySocket(
    socket: WebSocket,
    _request: FastifyRequest,
    repositories: RelayRepositories,
    connections: GatewayConnectionRegistry,
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
                cipher = await SessionCipher.create({ sessionKey: finished.sessionKey, role: 'responder', channelId })
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
                const accepted: GatewaySecureHandshakeFrame = {
                    version: 1,
                    type: 'relay.secure-auth.accepted',
                    messageId: randomUUID(),
                    payload: {
                        handshakeId: pendingHandshakeId,
                        envelope: await activeCipher.encrypt({
                            gatewayId,
                            connectionEpoch: epoch,
                            acceptedAt: new Date().toISOString(),
                            credentialProvisioningRequired,
                        }),
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
                    if (control.payload.gatewayId !== gatewayId || credentialRegistrationStarted) throw new Error('Invalid credential registration start')
                    credentialRegistrationStarted = true
                    const response = await authenticator.createCredentialRegistrationResponse(gatewayId!, control.payload.registrationRequest)
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
                    if (control.payload.gatewayId !== gatewayId || !credentialRegistrationStarted) throw new Error('Invalid credential registration commit')
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
            if (frame.gatewayId !== gatewayId || frame.connectionEpoch !== epoch) throw new Error('Gateway identity or connection epoch mismatch')
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
            await consumeSecureGatewayFrame(frame, repositories.gateways, deviceTunnels, socket)
        }).catch(error => {
            app.log.error(error)
            if (!cipher && socket.readyState === socket.OPEN) {
                const rejection: GatewaySecureHandshakeFrame = {
                    version: 1,
                    type: 'relay.secure-auth.rejected',
                    messageId: randomUUID(),
                    payload: { code: 'authentication_failed', message: 'Secure Gateway authentication failed' },
                }
                socket.send(JSON.stringify(rejection))
            }
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

async function consumeSecureGatewayFrame(
    frame: GatewayFrame,
    gateways: GatewayRepository,
    deviceTunnels: DeviceTunnelRegistry,
    socket: WebSocket,
): Promise<void> {
    switch (frame.type) {
        case 'gateway.heartbeat':
            await gateways.updateConnection(frame.gatewayId, 'online', frame.connectionEpoch, frame.payload.sentAt)
            return
        case 'device.tunnel.data':
            if (!deviceTunnels.send(frame.gatewayId, frame.payload.tunnelId, frame.payload.opaquePayload)) {
                throw new Error(`Unknown device tunnel ${frame.payload.tunnelId}`)
            }
            return
        case 'device.tunnel.close':
            if (!deviceTunnels.closeFromGateway(
                frame.gatewayId, frame.payload.tunnelId, frame.payload.code ?? 'normal', frame.payload.reason,
            )) throw new Error(`Unknown device tunnel ${frame.payload.tunnelId}`)
            return
        default:
            socket.close(1008, `Unexpected secure gateway frame type: ${frame.type}`)
    }
}
