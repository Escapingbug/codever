import {
    parseGatewaySecureHandshakeFrame,
    parseRelaySecureAuthAcceptedPayload,
    parseRelayBlobResponseFrame,
    parseSecureControlFrame,
    parseSecureDataFrame,
    PROTOCOL_VERSION,
} from '@codever/protocol'
import {
    createOpaqueServerSetup,
    finishOpaqueCredentialRegistration,
    finishOpaquePairingClient,
    SessionCipher,
    generateOpaqueCredentialSecret,
    startOpaqueCredentialRegistration,
    startOpaquePairingClient,
} from '@codever/secure-channel'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createInMemoryRelayRepositories } from '../src/memoryRepositories'
import { createRelayServer, type RelayServer } from '../src/server'
import { SecureGatewayAuthenticator } from '../src/secureGatewayAuth'
import { RelayBlobStore } from '../src/relayBlobStore'

const servers: RelayServer[] = []
const directories: string[] = []
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.close()))
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('secure Gateway WebSocket', () => {
    it('accepts a one-time OPAQUE pairing and carries only encrypted application frames', async () => {
        const repositories = createInMemoryRelayRepositories()
        const authenticator = await SecureGatewayAuthenticator.create({
            relayId: 'relay-1', serverSetup: await createOpaqueServerSetup(),
            credentials: { get: async () => undefined, put: async (gatewayId, registrationRecord) => ({ gatewayId, registrationRecord, enabled: true }) },
        })
        const app = await createRelayServer({
            repositories,
            secureGatewayAuthenticator: authenticator,
            blobStore: new RelayBlobStore(await temporaryDirectory()),
        })
        servers.push(app)
        await app.listen({ host: '127.0.0.1', port: 0 })
        const address = app.server.address()
        if (!address || typeof address === 'string') throw new Error('Expected TCP address')

        const ticket = authenticator.issuePairing()
        const clientStart = await startOpaquePairingClient(ticket.code)
        const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v2/gateway/connect`)
        await onceOpen(socket)
        socket.send(JSON.stringify({
            version: 1, type: 'gateway.secure-auth.start', messageId: randomUUID(),
            payload: {
                gatewayId: 'gateway-1', mode: 'pairing', subjectId: clientStart.pairingId,
                startLoginRequest: clientStart.startLoginRequest,
            },
        }))
        const response = parseGatewaySecureHandshakeFrame(JSON.parse(await onceMessage(socket)))
        expect(response.type).toBe('relay.secure-auth.response')
        if (response.type !== 'relay.secure-auth.response') throw new Error('Unexpected response')
        const clientFinish = finishOpaquePairingClient({
            domain: 'relay-gateway',
            code: ticket.code, serverId: 'relay-1', clientLoginState: clientStart.clientLoginState,
            loginResponse: response.payload.loginResponse,
        })
        socket.send(JSON.stringify({
            version: 1, type: 'gateway.secure-auth.finish', messageId: randomUUID(),
            payload: { handshakeId: response.payload.handshakeId, finishLoginRequest: clientFinish.finishLoginRequest },
        }))
        const acceptedFrameText = await onceMessage(socket)
        expect(acceptedFrameText).not.toContain('connectionEpoch')
        const acceptedFrame = parseGatewaySecureHandshakeFrame(JSON.parse(acceptedFrameText))
        if (acceptedFrame.type !== 'relay.secure-auth.accepted') throw new Error('Unexpected accepted frame')
        const cipher = await SessionCipher.create({
            sessionKey: clientFinish.sessionKey, role: 'initiator',
            channelId: acceptedFrame.payload.envelope.channelId,
        })
        const accepted = parseRelaySecureAuthAcceptedPayload(await cipher.decrypt(acceptedFrame.payload.envelope))
        expect(accepted).toMatchObject({ gatewayId: 'gateway-1', credentialProvisioningRequired: true })

        const credentialSecret = generateOpaqueCredentialSecret()
        const registrationStart = await startOpaqueCredentialRegistration(credentialSecret)
        socket.send(JSON.stringify({
            version: 1, type: 'secure.data', messageId: randomUUID(),
            envelope: await cipher.encrypt({
                version: 1, type: 'gateway.credential.registration.start', messageId: randomUUID(),
                payload: { gatewayId: 'gateway-1', registrationRequest: registrationStart.registrationRequest },
            }),
        }))
        const registrationResponseWire = parseSecureDataFrame(JSON.parse(await onceMessage(socket)))
        const registrationResponse = parseSecureControlFrame(await cipher.decrypt(registrationResponseWire.envelope))
        if (registrationResponse.type !== 'relay.credential.registration.response') throw new Error('Unexpected registration response')
        const registration = await finishOpaqueCredentialRegistration({
            secret: credentialSecret, subjectId: 'gateway-1', serverId: 'relay-1',
            clientRegistrationState: registrationStart.clientRegistrationState,
            registrationResponse: registrationResponse.payload.registrationResponse,
            expectedServerStaticPublicKey: registrationResponse.payload.serverStaticPublicKey,
        })
        socket.send(JSON.stringify({
            version: 1, type: 'secure.data', messageId: randomUUID(),
            envelope: await cipher.encrypt({
                version: 1, type: 'gateway.credential.registration.commit', messageId: randomUUID(),
                payload: { gatewayId: 'gateway-1', registrationRecord: registration.registrationRecord },
            }),
        }))
        const registrationAcceptedWire = parseSecureDataFrame(JSON.parse(await onceMessage(socket)))
        const registrationAccepted = parseSecureControlFrame(await cipher.decrypt(registrationAcceptedWire.envelope))
        expect(registrationAccepted.type).toBe('relay.credential.registration.accepted')

        const hello = {
            version: PROTOCOL_VERSION,
            type: 'gateway.hello',
            messageId: randomUUID(),
            gatewayId: 'gateway-1',
            connectionEpoch: accepted.connectionEpoch,
            payload: {
                workspaceId: 'workspace-1', name: 'Secure Gateway', platform: 'linux', gatewayVersion: '0.1.0',
                supportedProtocolVersions: [PROTOCOL_VERSION],
                capabilities: { protocolVersions: [PROTOCOL_VERSION], providers: ['codex'], features: [] },
                connectedAt: new Date().toISOString(),
            },
        }
        const envelope = await cipher.encrypt(hello)
        const wire = JSON.stringify({ version: 1, type: 'secure.data', messageId: randomUUID(), envelope })
        expect(wire).not.toContain('Secure Gateway')
        socket.send(wire)
        await waitFor(async () => (await repositories.gateways.get('gateway-1'))?.status === 'online')

        await sendEncrypted(socket, cipher, blobFrame('gateway.blob.begin', accepted.connectionEpoch, {
            requestId: 'blob-begin', blobId: 'blob-1', totalSize: 5, chunkSize: 5,
        }))
        expect(parseRelayBlobResponseFrame(await decryptMessage(socket, cipher)).payload).toMatchObject({
            requestId: 'blob-begin', operation: 'begin', status: 'succeeded',
        })

        await sendEncrypted(socket, cipher, blobFrame('gateway.blob.complete', accepted.connectionEpoch, {
            requestId: 'blob-incomplete', blobId: 'blob-1',
        }))
        expect(parseRelayBlobResponseFrame(await decryptMessage(socket, cipher)).payload).toMatchObject({
            requestId: 'blob-incomplete', operation: 'complete', status: 'failed', code: 'incomplete',
        })

        await sendEncrypted(socket, cipher, blobFrame('gateway.blob.put-chunk', accepted.connectionEpoch, {
            requestId: 'blob-put', blobId: 'blob-1', index: 0, opaqueChunk: Buffer.from('abcde').toString('base64url'),
        }))
        expect(parseRelayBlobResponseFrame(await decryptMessage(socket, cipher)).payload).toMatchObject({
            requestId: 'blob-put', operation: 'put-chunk', status: 'succeeded',
        })
        await sendEncrypted(socket, cipher, blobFrame('gateway.blob.complete', accepted.connectionEpoch, {
            requestId: 'blob-complete', blobId: 'blob-1',
        }))
        expect(parseRelayBlobResponseFrame(await decryptMessage(socket, cipher)).payload).toMatchObject({
            requestId: 'blob-complete', operation: 'complete', status: 'succeeded', manifest: { complete: true },
        })

        const closed = onceClose(socket)
        socket.send(JSON.stringify({
            version: 1,
            type: 'secure.data',
            messageId: randomUUID(),
            envelope: await cipher.encrypt({
                version: 1,
                type: 'gateway.inventory.snapshot',
                messageId: randomUUID(),
                gatewayId: 'gateway-1',
                connectionEpoch: accepted.connectionEpoch,
                payload: { generatedAt: new Date().toISOString(), revision: 1, projects: [], sessions: [] },
            }),
        }))
        await expect(closed).resolves.toMatchObject({ code: 1008 })
    }, 20_000)
})

function blobFrame(type: string, connectionEpoch: string, payload: object): object {
    return {
        version: PROTOCOL_VERSION, type, messageId: randomUUID(), gatewayId: 'gateway-1', connectionEpoch, payload,
    }
}

async function sendEncrypted(socket: WebSocket, cipher: SessionCipher, value: unknown): Promise<void> {
    socket.send(JSON.stringify({
        version: 1, type: 'secure.data', messageId: randomUUID(), envelope: await cipher.encrypt(value),
    }))
}

async function decryptMessage(socket: WebSocket, cipher: SessionCipher): Promise<unknown> {
    return cipher.decrypt(parseSecureDataFrame(JSON.parse(await onceMessage(socket))).envelope)
}

async function temporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'codever-relay-integration-'))
    directories.push(path)
    return path
}

function onceOpen(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
    })
}

function onceMessage(socket: WebSocket): Promise<string> {
    return new Promise((resolve, reject) => {
        socket.once('message', data => resolve(data.toString()))
        socket.once('error', reject)
    })
}

function onceClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
    return new Promise(resolve => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
        if (await predicate()) return
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('Condition was not reached')
}
