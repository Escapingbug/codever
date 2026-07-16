import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import type {
    GatewayFrame,
    GatewayHandshakeFrame,
    InventorySnapshot,
    SessionEventEnvelope,
} from '@codever/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { GatewayIdentity, verifyRelayChallengeSignature } from '@/gateway/identity'
import { RelayLink } from '../relayLink'

const links: RelayLink[] = []
const servers: WebSocketServer[] = []

afterEach(async () => {
    await Promise.all(links.splice(0).map(link => link.stop()))
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

describe('RelayLink', () => {
    it('authenticates a versioned challenge before sending hello, inventory, and heartbeat', async () => {
        const identity = createIdentity()
        const relay = await createMockRelay(identity)
        const link = createLink(relay.url, identity)

        await link.start()
        const connection = await relay.connection(0)
        expect(connection.beforeAccepted).toHaveLength(1)
        expect(connection.beforeAccepted[0]?.type).toBe('gateway.auth.response')

        const hello = await connection.next('gateway.hello')
        const inventory = await connection.next('gateway.inventory.snapshot')
        const heartbeat = await connection.next('gateway.heartbeat')
        expect(hello).toMatchObject({ gatewayId: 'gateway-1', connectionEpoch: connection.epoch })
        expect(inventory).toMatchObject({ payload: { revision: 7 } })
        expect(heartbeat).toMatchObject({ payload: { inventoryRevision: 7, sessionStates: { 'session-1': 'idle' } } })
        expect(link.state).toBe('online')
    })

    it('queues and batches events offline, removes ACKed cursors, and resends only unacked events on a new epoch', async () => {
        const identity = createIdentity()
        const relay = await createMockRelay(identity)
        const acknowledgements: Array<Readonly<Record<string, number>>> = []
        const link = createLink(relay.url, identity, { maxBatchSize: 2, onAck: cursors => acknowledgements.push(cursors) })
        link.enqueueEvents([event(1), event(2), event(3)])

        await link.start()
        const first = await relay.connection(0)
        await consumeStartup(first)
        const firstBatch = await first.next('session.event.batch')
        const secondBatch = await first.next('session.event.batch')
        expect(firstBatch.payload.events.map((item: SessionEventEnvelope) => item.seq)).toEqual([1, 2])
        expect(secondBatch.payload.events.map((item: SessionEventEnvelope) => item.seq)).toEqual([3])

        first.send(dataFrame(first, 'session.event.ack', { cursors: [{ sessionId: 'session-1', seq: 2 }] }))
        await vi.waitFor(() => expect(link.acknowledgedCursors).toEqual({ 'session-1': 2 }))
        expect(acknowledgements.at(-1)).toEqual({ 'session-1': 2 })

        first.socket.close(1012, 'Relay restart')
        const second = await relay.connection(1)
        await vi.waitFor(() => expect(link.epoch).toBe(second.epoch))
        await consumeStartup(second)
        const replay = await second.next('session.event.batch')
        expect(replay.payload.events.map((item: SessionEventEnvelope) => item.seq)).toEqual([3])
        expect(second.epoch).not.toBe(first.epoch)
    })

    it('executes command requests once and replays accepted/result frames for duplicate idempotency keys', async () => {
        const identity = createIdentity()
        const relay = await createMockRelay(identity)
        const handler = vi.fn(async () => ({ ok: true }))
        const link = createLink(relay.url, identity, { handleCommand: handler })
        await link.start()
        const connection = await relay.connection(0)
        await consumeStartup(connection)

        const request = commandRequest(connection, 'command-1', 'idem-1')
        connection.send(request)
        expect((await connection.next('command.accepted')).payload.commandId).toBe('command-1')
        expect((await connection.next('command.result')).payload.result).toEqual({ ok: true })

        connection.send({ ...request, messageId: randomUUID() })
        expect((await connection.next('command.accepted')).payload.commandId).toBe('command-1')
        expect((await connection.next('command.result')).payload.result).toEqual({ ok: true })
        expect(handler).toHaveBeenCalledTimes(1)
    })

    it('handles sync requests by refreshing inventory, replaying journal events, and completing with cursors', async () => {
        const identity = createIdentity()
        const relay = await createMockRelay(identity)
        const loadEventsAfter = vi.fn(async (_sessionId: string, afterSeq: number) => [event(afterSeq + 1), event(afterSeq + 2)])
        const link = createLink(relay.url, identity, { loadEventsAfter })
        await link.start()
        const connection = await relay.connection(0)
        await consumeStartup(connection)

        connection.send(dataFrame(connection, 'sync.request', {
            cursors: [{ sessionId: 'session-1', afterSeq: 3 }],
            includeInventory: true,
        }))
        expect((await connection.next('gateway.inventory.snapshot')).payload.revision).toBe(7)
        expect((await connection.next('session.event.batch')).payload.events.map((item: SessionEventEnvelope) => item.seq)).toEqual([4, 5])
        expect(await connection.next('sync.complete')).toMatchObject({
            payload: { inventoryRevision: 7, cursors: [{ sessionId: 'session-1', seq: 5 }] },
        })
        expect(loadEventsAfter).toHaveBeenCalledWith('session-1', 3)
    })
})

interface MockConnection {
    socket: WebSocket
    epoch: string
    beforeAccepted: Array<Record<string, any>>
    send(frame: object): void
    next(type: string): Promise<any>
}

async function createMockRelay(identity: GatewayIdentity): Promise<{
    url: string
    connection(index: number): Promise<MockConnection>
}> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve)
        server.once('error', reject)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Mock Relay did not bind a TCP port')

    const connections: MockConnection[] = []
    const waiters: Array<() => void> = []
    server.on('connection', socket => {
        const epoch = randomUUID()
        const challenge = {
            version: 1 as const,
            relayId: 'relay-1',
            challengeId: randomUUID(),
            nonce: randomBytes(32).toString('base64url'),
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
        }
        const queue: any[] = []
        const typedWaiters = new Map<string, Array<(frame: any) => void>>()
        const beforeAccepted: Array<Record<string, any>> = []
        let accepted = false
        const connection: MockConnection = {
            socket,
            epoch,
            beforeAccepted,
            send(frame) {
                socket.send(JSON.stringify(frame))
            },
            next(type) {
                const queuedIndex = queue.findIndex(frame => frame.type === type)
                if (queuedIndex >= 0) return Promise.resolve(queue.splice(queuedIndex, 1)[0])
                return new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 2_000)
                    const list = typedWaiters.get(type) ?? []
                    list.push(frame => {
                        clearTimeout(timeout)
                        resolve(frame)
                    })
                    typedWaiters.set(type, list)
                })
            },
        }
        connections.push(connection)
        waiters.splice(0).forEach(resolve => resolve())

        const challengeFrame: GatewayHandshakeFrame = {
            version: 1,
            type: 'relay.auth.challenge',
            messageId: randomUUID(),
            payload: {
                relayId: challenge.relayId,
                challengeId: challenge.challengeId,
                nonce: challenge.nonce,
                issuedAt: challenge.issuedAt,
                expiresAt: challenge.expiresAt,
            },
        }
        socket.send(JSON.stringify(challengeFrame))
        socket.on('message', raw => {
            const frame = JSON.parse(raw.toString()) as any
            if (!accepted) {
                beforeAccepted.push(frame)
                expect(frame.type).toBe('gateway.auth.response')
                expect(verifyRelayChallengeSignature(challenge, {
                    version: 1,
                    algorithm: frame.payload.algorithm,
                    fingerprint: frame.payload.fingerprint,
                    signature: frame.payload.signature,
                }, identity.enrollmentBundle(), 'gateway-1')).toBe(true)
                accepted = true
                const acceptedFrame: GatewayHandshakeFrame = {
                    version: 1,
                    type: 'relay.auth.accepted',
                    messageId: randomUUID(),
                    payload: { gatewayId: 'gateway-1', connectionEpoch: epoch, acceptedAt: new Date().toISOString() },
                }
                socket.send(JSON.stringify(acceptedFrame))
                return
            }
            const typed = typedWaiters.get(frame.type)?.shift()
            if (typed) typed(frame)
            else queue.push(frame)
        })
    })

    return {
        url: `ws://127.0.0.1:${address.port}`,
        async connection(index) {
            if (!connections[index]) await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error(`Timed out waiting for connection ${index}`)), 2_000)
                waiters.push(() => {
                    clearTimeout(timeout)
                    resolve()
                })
            })
            return connections[index]!
        },
    }
}

function createLink(
    url: string,
    identity: GatewayIdentity,
    overrides: Partial<ConstructorParameters<typeof RelayLink>[0]> = {},
): RelayLink {
    const link = new RelayLink({
        url,
        gatewayId: 'gateway-1',
        identity,
        hello: {
            workspaceId: 'workspace-1',
            name: 'Test Gateway',
            platform: 'linux',
            gatewayVersion: '0.1.0',
            supportedProtocolVersions: [1],
            capabilities: { protocolVersions: [1], providers: ['test'], features: ['relay'] },
        },
        getInventory: () => inventory(),
        handleCommand: async () => undefined,
        heartbeatIntervalMs: 60_000,
        reconnect: { initialDelayMs: 5, maxDelayMs: 20, jitter: 0 },
        ...overrides,
    })
    links.push(link)
    return link
}

function createIdentity(): GatewayIdentity {
    const { privateKey } = generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
        publicKeyEncoding: { format: 'pem', type: 'spki' },
    })
    return GatewayIdentity.fromPrivateKeyPem(privateKey)
}

function inventory(): InventorySnapshot {
    const now = new Date().toISOString()
    return {
        generatedAt: now,
        revision: 7,
        projects: [{
            id: 'project-1', gatewayId: 'gateway-1', name: 'Codever', rootPath: '/codever', canonicalRoot: '/codever',
        }],
        sessions: [{
            id: 'session-1', gatewayId: 'gateway-1', projectId: 'project-1', state: 'idle', provider: 'test', config: {},
            createdAt: now, updatedAt: now, lastEventSeq: 0,
        }],
    }
}

function event(seq: number): SessionEventEnvelope {
    return {
        schemaVersion: 1,
        gatewayId: 'gateway-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        seq,
        eventId: `event-${seq}`,
        timestamp: new Date().toISOString(),
        event: { kind: 'assistant_text_delta', text: String(seq) },
    }
}

function dataFrame<T extends GatewayFrame['type']>(
    connection: MockConnection,
    type: T,
    payload: Extract<GatewayFrame, { type: T }>['payload'],
): Extract<GatewayFrame, { type: T }> {
    return {
        version: 1,
        type,
        messageId: randomUUID(),
        gatewayId: 'gateway-1',
        connectionEpoch: connection.epoch,
        payload,
    } as Extract<GatewayFrame, { type: T }>
}

function commandRequest(connection: MockConnection, commandId: string, idempotencyKey: string): Extract<GatewayFrame, { type: 'command.request' }> {
    return {
        ...dataFrame(connection, 'command.request', {
            commandId,
            projectId: 'project-1',
            sessionId: 'session-1',
            command: { kind: 'session.message', text: 'Run tests' },
            requestedAt: new Date().toISOString(),
        }),
        sessionId: 'session-1',
        idempotencyKey,
    }
}

async function consumeStartup(connection: MockConnection): Promise<void> {
    await connection.next('gateway.hello')
    await connection.next('gateway.inventory.snapshot')
    await connection.next('gateway.heartbeat')
}
