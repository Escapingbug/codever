import {
    PROTOCOL_VERSION,
    parseGatewayFrame,
    parseRelayClientAuthAcceptedPayload,
    parseRelayClientCredentialRegistrationFrame,
    parseRelayClientSecureControlFrame,
    parseRelayClientSecureHandshakeFrame,
    parseSecureDataFrame,
} from '@codever/protocol'
import {
    createOpaqueServerSetup,
    finishOpaqueCredentialRegistration,
    finishOpaquePairingClient,
    generateOpaqueCredentialSecret,
    SessionCipher,
    startOpaqueCredentialRegistration,
    startOpaquePairingClient,
} from '@codever/secure-channel'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { GatewayConnectionRegistry } from '../src/connectionRegistry'
import { createInMemoryRelayRepositories } from '../src/memoryRepositories'
import { SecureClientAuthenticator } from '../src/secureClientAuth'
import { createRelayServer, type RelayServer } from '../src/server'

const servers: RelayServer[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())) })

describe('secure Client WebSocket', () => {
    it('encrypts gateway discovery and tunnel routing while forwarding opaque payloads unchanged', async () => {
        const credentials = new Map<string, string>()
        const authenticator = await SecureClientAuthenticator.create({
            relayId: 'relay-1',
            serverSetup: await createOpaqueServerSetup(),
            credentials: {
                get: async clientId => {
                    const registrationRecord = credentials.get(clientId)
                    return registrationRecord ? { clientId, registrationRecord, enabled: true } : undefined
                },
                put: async (clientId, registrationRecord) => {
                    credentials.set(clientId, registrationRecord)
                    return { clientId, registrationRecord, enabled: true }
                },
            },
        })
        const repositories = createInMemoryRelayRepositories()
        await repositories.gateways.upsert({
            id: 'gateway-1', workspaceId: 'workspace-1', name: 'Secret Gateway', platform: 'linux', version: '1.0.0',
            capabilities: { protocolVersions: [PROTOCOL_VERSION], providers: ['codex'], features: [] },
            status: 'online', connectionEpoch: 'epoch-1', lastSeenAt: new Date().toISOString(),
        })
        const gatewayWire: string[] = []
        const gatewaySocket = {
            OPEN: WebSocket.OPEN,
            readyState: WebSocket.OPEN,
            send: (value: string) => gatewayWire.push(value),
            close: vi.fn(),
        } as unknown as WebSocket
        const connections = new GatewayConnectionRegistry()
        connections.replace({ gatewayId: 'gateway-1', connectionEpoch: 'epoch-1', socket: gatewaySocket, ready: true })
        const app = await createRelayServer({
            repositories, connectionRegistry: connections, secureClientAuthenticator: authenticator,
        })
        servers.push(app)
        await app.listen({ host: '127.0.0.1', port: 0 })
        const address = app.server.address()
        if (!address || typeof address === 'string') throw new Error('Expected TCP address')

        const ticket = authenticator.issuePairing()
        const pairing = await startOpaquePairingClient(ticket.code)
        const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v2/client/connect`)
        await onceOpen(socket)
        socket.send(JSON.stringify({
            version: PROTOCOL_VERSION,
            type: 'client.relay-auth.start',
            messageId: randomUUID(),
            payload: {
                mode: 'pairing', credentialId: 'client-1', subjectId: pairing.pairingId,
                startLoginRequest: pairing.startLoginRequest,
            },
        }))
        const response = parseRelayClientSecureHandshakeFrame(JSON.parse(await onceMessage(socket)))
        if (response.type !== 'relay.client-auth.response') throw new Error('Expected Client authentication response')
        const finished = finishOpaquePairingClient({
            code: ticket.code, serverId: 'relay-1', clientLoginState: pairing.clientLoginState,
            loginResponse: response.payload.loginResponse,
        })
        socket.send(JSON.stringify({
            version: PROTOCOL_VERSION,
            type: 'client.relay-auth.finish',
            messageId: randomUUID(),
            payload: { handshakeId: response.payload.handshakeId, finishLoginRequest: finished.finishLoginRequest },
        }))
        const acceptedWire = await onceMessage(socket)
        expect(acceptedWire).not.toContain('client-1')
        const acceptedFrame = parseRelayClientSecureHandshakeFrame(JSON.parse(acceptedWire))
        if (acceptedFrame.type !== 'relay.client-auth.accepted') throw new Error('Expected Client authentication acceptance')
        const cipher = await SessionCipher.create({
            sessionKey: finished.sessionKey, role: 'initiator', channelId: acceptedFrame.payload.envelope.channelId,
        })
        const accepted = parseRelayClientAuthAcceptedPayload(await cipher.decrypt(acceptedFrame.payload.envelope))
        expect(accepted).toMatchObject({ relayId: 'relay-1', credentialId: 'client-1', provisioningRequired: true })

        const secret = generateOpaqueCredentialSecret()
        const registrationStart = await startOpaqueCredentialRegistration(secret)
        await sendEncrypted(socket, cipher, {
            version: PROTOCOL_VERSION,
            type: 'client.credential.registration.start',
            messageId: randomUUID(),
            payload: { credentialId: 'client-1', registrationRequest: registrationStart.registrationRequest },
        })
        const registrationResponse = parseRelayClientCredentialRegistrationFrame(await decryptMessage(socket, cipher))
        if (registrationResponse.type !== 'relay.client-credential.registration.response') throw new Error('Expected registration response')
        const registration = await finishOpaqueCredentialRegistration({
            secret, subjectId: 'client-1', serverId: 'relay-1',
            clientRegistrationState: registrationStart.clientRegistrationState,
            registrationResponse: registrationResponse.payload.registrationResponse,
            expectedServerStaticPublicKey: registrationResponse.payload.serverStaticPublicKey,
        })
        await sendEncrypted(socket, cipher, {
            version: PROTOCOL_VERSION,
            type: 'client.credential.registration.commit',
            messageId: randomUUID(),
            payload: { credentialId: 'client-1', registrationRecord: registration.registrationRecord },
        })
        expect(parseRelayClientCredentialRegistrationFrame(await decryptMessage(socket, cipher)).type)
            .toBe('relay.client-credential.registration.accepted')

        const listMessage = onceMessage(socket)
        await sendEncrypted(socket, cipher, {
            version: PROTOCOL_VERSION, type: 'client.relay.gateways.request', requestId: 'request-1',
        })
        const listWire = await listMessage
        expect(listWire).not.toContain('Secret Gateway')
        const list = parseRelayClientSecureControlFrame(await decryptWire(listWire, cipher))
        expect(list).toMatchObject({ type: 'relay.client.gateways.response', requestId: 'request-1' })

        const openedMessage = onceMessage(socket)
        await sendEncrypted(socket, cipher, {
            version: PROTOCOL_VERSION, type: 'device.tunnel.open', messageId: randomUUID(),
            payload: { gatewayId: 'gateway-1' },
        })
        await waitFor(() => gatewayWire.length === 1)
        const gatewayOpen = parseGatewayFrame(JSON.parse(gatewayWire.shift()!))
        if (gatewayOpen.type !== 'device.tunnel.open') throw new Error('Expected Gateway tunnel open')
        expect(await decryptWire(await openedMessage, cipher)).toMatchObject({
            type: 'relay.device-tunnel.opened', payload: { tunnelId: gatewayOpen.payload.tunnelId },
        })

        await sendEncrypted(socket, cipher, {
            version: PROTOCOL_VERSION, type: 'device.tunnel.data', messageId: randomUUID(),
            payload: { tunnelId: gatewayOpen.payload.tunnelId, opaquePayload: 'bm90LXJlbGF5LXBsYWludGV4dA' },
        })
        await waitFor(() => gatewayWire.length === 1)
        expect(parseGatewayFrame(JSON.parse(gatewayWire.shift()!))).toMatchObject({
            type: 'device.tunnel.data', payload: { opaquePayload: 'bm90LXJlbGF5LXBsYWludGV4dA' },
        })

        const gatewayDataMessage = onceMessage(socket)
        expect(app.relay.deviceTunnels.send('gateway-1', gatewayOpen.payload.tunnelId, 'b3BhcXVlLWZyb20tZ2F0ZXdheQ')).toBe(true)
        expect(await decryptWire(await gatewayDataMessage, cipher)).toMatchObject({
            type: 'relay.device-tunnel.data', payload: { opaquePayload: 'b3BhcXVlLWZyb20tZ2F0ZXdheQ' },
        })
        socket.close()
    }, 20_000)
})

async function sendEncrypted(socket: WebSocket, cipher: SessionCipher, value: unknown): Promise<void> {
    socket.send(JSON.stringify({
        version: PROTOCOL_VERSION, type: 'secure.data', messageId: randomUUID(), envelope: await cipher.encrypt(value),
    }))
}

async function decryptMessage(socket: WebSocket, cipher: SessionCipher): Promise<unknown> {
    return decryptWire(await onceMessage(socket), cipher)
}

async function decryptWire(wire: string, cipher: SessionCipher): Promise<unknown> {
    return cipher.decrypt(parseSecureDataFrame(JSON.parse(wire)).envelope)
}

function onceOpen(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
}

function onceMessage(socket: WebSocket): Promise<string> {
    return new Promise((resolve, reject) => {
        socket.once('message', data => resolve(data.toString()))
        socket.once('error', reject)
    })
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
        if (predicate()) return
        await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('Condition was not reached')
}
