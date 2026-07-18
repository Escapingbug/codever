import { parseRelayClientAuthAcceptedPayload, parseRelayClientSecureHandshakeFrame } from '@codever/protocol'
import { createOpaqueServerSetup, finishOpaquePairingClient, SessionCipher, startOpaquePairingClient } from '@codever/secure-channel'
import { nkeys } from '@nats-io/transport-node'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { SecureClientAuthenticator } from '../src/secureClientAuth'
import { createRelayServer, type RelayServer } from '../src/server'

const servers: RelayServer[] = []
const jwt = `${'a'.repeat(40)}.${'b'.repeat(80)}.${'c'.repeat(64)}`
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())) })

describe('one-time secure Client WebSocket', () => {
    it('returns a signed NATS credential only inside the OPAQUE-derived cipher', async () => {
        const authenticator = await SecureClientAuthenticator.create({
            relayId: 'relay-1', serverSetup: await createOpaqueServerSetup(),
            natsCredentials: {
                issueClient: async (_id, publicKey) => ({ publicKey, userJwt: jwt, websocketUrl: 'wss://relay.test/nats' }),
                issueGateway: async (_id, publicKey) => ({ publicKey, userJwt: jwt, natsUrl: 'tls://relay.test:4222' }),
            },
        })
        const app = await createRelayServer({ secureClientAuthenticator: authenticator })
        servers.push(app)
        await app.listen({ host: '127.0.0.1', port: 0 })
        const address = app.server.address()
        if (!address || typeof address === 'string') throw new Error('Expected TCP address')

        const ticket = authenticator.issuePairing()
        const pairing = await startOpaquePairingClient(ticket.code)
        const key = nkeys.createUser()
        const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v2/client/connect`)
        await onceOpen(socket)
        socket.send(JSON.stringify({
            version: 1, type: 'client.relay-auth.start', messageId: randomUUID(),
            payload: {
                mode: 'pairing', credentialId: 'client-1', subjectId: pairing.pairingId,
                startLoginRequest: pairing.startLoginRequest, natsPublicKey: key.getPublicKey(),
            },
        }))
        const response = parseRelayClientSecureHandshakeFrame(JSON.parse(await onceMessage(socket)))
        if (response.type !== 'relay.client-auth.response') throw new Error('Expected auth response')
        const finished = finishOpaquePairingClient({
            domain: 'relay-client', code: ticket.code, serverId: 'relay-1',
            clientLoginState: pairing.clientLoginState, loginResponse: response.payload.loginResponse,
        })
        socket.send(JSON.stringify({
            version: 1, type: 'client.relay-auth.finish', messageId: randomUUID(),
            payload: { handshakeId: response.payload.handshakeId, finishLoginRequest: finished.finishLoginRequest },
        }))
        const acceptedWire = await onceMessage(socket)
        expect(acceptedWire).not.toContain(jwt)
        const acceptedFrame = parseRelayClientSecureHandshakeFrame(JSON.parse(acceptedWire))
        if (acceptedFrame.type !== 'relay.client-auth.accepted') throw new Error('Expected auth acceptance')
        const cipher = await SessionCipher.create({
            sessionKey: finished.sessionKey, role: 'initiator', channelId: acceptedFrame.payload.envelope.channelId,
        })
        expect(parseRelayClientAuthAcceptedPayload(await cipher.decrypt(acceptedFrame.payload.envelope))).toMatchObject({
            credentialId: 'client-1', natsUserJwt: jwt, natsWebSocketUrl: 'wss://relay.test/nats',
        })
        socket.close()
    }, 20_000)
})

function onceOpen(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
}
function onceMessage(socket: WebSocket): Promise<string> {
    return new Promise((resolve, reject) => { socket.once('message', data => resolve(data.toString())); socket.once('error', reject) })
}
