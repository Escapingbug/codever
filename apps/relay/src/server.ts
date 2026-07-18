import { randomUUID } from 'node:crypto'
import websocket from '@fastify/websocket'
import {
    parseGatewaySecureHandshakeFrame,
    type GatewaySecureHandshakeFrame,
} from '@codever/protocol'
import { SessionCipher } from '@codever/secure-channel'
import Fastify, { type FastifyInstance } from 'fastify'
import type WebSocket from 'ws'
import { ClientSecureSession } from './clientSecureSession'
import type { SecureClientAuthenticator } from './secureClientAuth'
import type { SecureGatewayAuthenticator } from './secureGatewayAuth'

export interface CreateRelayServerOptions {
    logger?: boolean
    secureGatewayAuthenticator?: SecureGatewayAuthenticator
    secureClientAuthenticator?: SecureClientAuthenticator
}

export type RelayServer = FastifyInstance

/** The HTTP/WebSocket Relay surface exists only for health and one-time OPAQUE provisioning. */
export async function createRelayServer(options: CreateRelayServerOptions = {}): Promise<RelayServer> {
    const app = Fastify({ logger: options.logger ?? false })
    app.setErrorHandler((error: unknown, _request, reply) => {
        app.log.error(error)
        void reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal server error' })
    })
    await app.register(websocket)
    app.get('/health', async () => ({ status: 'ok' }))

    app.get('/v2/client/connect', { websocket: true }, socket => {
        if (!options.secureClientAuthenticator) return socket.close(1013, 'Client pairing is not configured')
        const session = new ClientSecureSession({
            socket, authenticator: options.secureClientAuthenticator, logError: error => app.log.error(error),
        })
        socket.on('message', data => {
            try { session.receive(JSON.parse(data.toString()) as unknown) }
            catch (error) { app.log.error(error); socket.close(1008, 'Invalid Client pairing frame') }
        })
        socket.on('close', () => session.disconnected())
    })

    app.get('/v2/gateway/connect', { websocket: true }, socket => {
        if (!options.secureGatewayAuthenticator) return socket.close(1013, 'Gateway pairing is not configured')
        handleGatewayPairing(socket, options.secureGatewayAuthenticator, app)
    })
    return app
}

function handleGatewayPairing(
    socket: WebSocket,
    authenticator: SecureGatewayAuthenticator,
    app: FastifyInstance,
): void {
    let handshakeId: string | undefined
    let gatewayId: string | undefined
    let incoming = Promise.resolve()
    let completed = false
    socket.on('message', data => {
        incoming = incoming.then(async () => {
            if (completed) throw new Error('Gateway pairing already completed')
            const frame = parseGatewaySecureHandshakeFrame(JSON.parse(data.toString()))
            if (!handshakeId) {
                if (frame.type !== 'gateway.secure-auth.start') throw new Error('Gateway pairing must start with auth.start')
                gatewayId = frame.payload.gatewayId
                const started = await authenticator.begin(frame.payload)
                handshakeId = started.handshakeId
                return send(socket, {
                    version: 1, type: 'relay.secure-auth.response', messageId: randomUUID(),
                    payload: { relayId: authenticator.relayId, ...started },
                })
            }
            if (frame.type !== 'gateway.secure-auth.finish' || frame.payload.handshakeId !== handshakeId) {
                throw new Error('Gateway pairing finish does not match its start')
            }
            const finished = await authenticator.finish(frame.payload)
            if (finished.gatewayId !== gatewayId) throw new Error('Gateway pairing identity changed')
            const cipher = await SessionCipher.create({
                sessionKey: finished.sessionKey, role: 'responder', channelId: randomUUID(),
            })
            completed = true
            send(socket, {
                version: 1, type: 'relay.secure-auth.accepted', messageId: randomUUID(),
                payload: {
                    handshakeId,
                    envelope: await cipher.encrypt({
                        gatewayId, acceptedAt: new Date().toISOString(),
                        natsUserJwt: finished.natsUserJwt, natsUrl: finished.natsUrl,
                    }),
                },
            })
        }).catch(error => {
            app.log.error(error)
            if (socket.readyState === socket.OPEN) {
                send(socket, {
                    version: 1, type: 'relay.secure-auth.rejected', messageId: randomUUID(),
                    payload: { code: 'authentication_failed', message: 'Secure Gateway pairing failed' },
                })
            }
            socket.close(1008, 'Gateway pairing protocol error')
        })
    })
}

function send(socket: WebSocket, frame: GatewaySecureHandshakeFrame): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame))
}
