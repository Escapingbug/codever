import type { ClientAuthenticator, GatewayAuthenticator } from '../src/auth'
import { createInMemoryRelayRepositories } from '../src/memoryRepositories'
import { createRelayServer } from '../src/server'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

const allowClients: ClientAuthenticator = {
    async authenticate() {
        return { id: 'user-1', workspaceId: 'workspace-1', deviceId: 'device-1' }
    },
    async authorize() {
        return true
    },
}

const allowGateways: GatewayAuthenticator = {
    async verify() {
        return { authenticated: true }
    },
}

const sockets: WebSocket[] = []
const messageQueues = new WeakMap<WebSocket, Array<Record<string, any>>>()
const messageWaiters = new WeakMap<WebSocket, (message: Record<string, any>) => void>()

afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close()
})

describe('relay server', () => {
    it('exposes health while denying clients and gateways by default', async () => {
        const app = await createRelayServer()
        const address = await app.listen({ host: '127.0.0.1', port: 0 })
        try {
            const health = await fetch(`${address}/health`)
            expect(await health.json()).toEqual({ status: 'ok' })

            const gateways = await fetch(`${address}/v1/gateways`)
            expect(gateways.status).toBe(401)

            const socket = await connect(`${address.replace('http', 'ws')}/v1/gateway/connect`)
            const challenge = await nextJson(socket)
            expect(challenge.type).toBe('relay.auth.challenge')
            socket.send(JSON.stringify(authResponse('gateway-denied')))
            const rejected = await nextJson(socket)
            expect(rejected).toMatchObject({ type: 'relay.auth.rejected', payload: { code: 'unknown_gateway' } })
        } finally {
            await app.close()
        }
    })

    it('ingests inventory and events, ACKs events, and serves authorized REST snapshots', async () => {
        const app = await createRelayServer({ clientAuthenticator: allowClients, gatewayAuthenticator: allowGateways })
        const address = await app.listen({ host: '127.0.0.1', port: 0 })
        try {
            const connection = await authenticateGateway(address, 'gateway-1')
            sendHello(connection.socket, 'gateway-1', connection.epoch)
            connection.socket.send(JSON.stringify(inventoryFrame('gateway-1', connection.epoch)))

            expect(await nextJson(connection.socket)).toMatchObject({
                type: 'sync.request',
                payload: { cursors: [{ sessionId: 'session-1', afterSeq: 0 }], includeInventory: false },
            })

            await eventually(async () => {
                const response = await fetch(`${address}/v1/projects/project-1/sessions`)
                return response.ok && (await response.json() as { sessions: unknown[] }).sessions.length === 1
            })

            connection.socket.send(JSON.stringify(eventFrame('gateway-1', connection.epoch)))
            const ack = await nextJson(connection.socket)
            expect(ack).toMatchObject({
                type: 'session.event.ack',
                gatewayId: 'gateway-1',
                connectionEpoch: connection.epoch,
                payload: { cursors: [{ sessionId: 'session-1', seq: 1 }] },
            })

            const gateways = await fetch(`${address}/v1/gateways`)
            expect(await gateways.json()).toMatchObject({ gateways: [{ id: 'gateway-1', status: 'online' }] })
            const projects = await fetch(`${address}/v1/gateways/gateway-1/projects`)
            expect(await projects.json()).toMatchObject({ projects: [{ id: 'project-1' }] })
            const detail = await fetch(`${address}/v1/sessions/session-1`)
            expect(await detail.json()).toMatchObject({ session: { id: 'session-1' } })
            const events = await fetch(`${address}/v1/sessions/session-1/events?after=0`)
            expect(await events.json()).toMatchObject({
                sessionId: 'session-1',
                nextAfter: 1,
                events: [{ eventId: 'event-1', seq: 1 }],
            })
        } finally {
            await app.close()
        }
    })

    it('replays event WebSocket history, fans out gateway ingest, and cleans up disconnects', async () => {
        const app = await createRelayServer({ clientAuthenticator: allowClients, gatewayAuthenticator: allowGateways })
        const address = await app.listen({ host: '127.0.0.1', port: 0 })
        try {
            const connection = await authenticateGateway(address, 'gateway-1')
            sendHello(connection.socket, 'gateway-1', connection.epoch)
            connection.socket.send(JSON.stringify(inventoryFrame('gateway-1', connection.epoch)))
            await nextJson(connection.socket)
            await eventually(async () => Boolean(await app.relay.repositories.sessions.get('session-1')))

            connection.socket.send(JSON.stringify(eventFrameAt('gateway-1', connection.epoch, 1)))
            await nextJson(connection.socket)

            const client = await connect(`${address.replace('http', 'ws')}/v1/sessions/session-1/events/ws?after=0`)
            expect(await nextJson(client)).toMatchObject({
                type: 'session.event',
                event: { sessionId: 'session-1', seq: 1, eventId: 'event-1' },
            })

            connection.socket.send(JSON.stringify(eventFrameAt('gateway-1', connection.epoch, 2)))
            expect(await nextJson(client)).toMatchObject({
                type: 'session.event',
                event: { sessionId: 'session-1', seq: 2, eventId: 'event-2' },
            })
            await nextJson(connection.socket)

            client.close()
            await eventually(async () => app.relay.eventStreams.subscriberCount('session-1') === 0)
        } finally {
            await app.close()
        }
    })

    it('routes session creation to the project gateway without inventing session metadata', async () => {
        const app = await createRelayServer({
            clientAuthenticator: allowClients,
            gatewayAuthenticator: allowGateways,
            createSessionTimeoutMs: 1_000,
        })
        const address = await app.listen({ host: '127.0.0.1', port: 0 })
        try {
            const connection = await authenticateGateway(address, 'gateway-1')
            sendHello(connection.socket, 'gateway-1', connection.epoch)
            connection.socket.send(JSON.stringify(inventoryFrame('gateway-1', connection.epoch)))
            await nextJson(connection.socket)
            await eventually(async () => Boolean(await app.relay.repositories.projects.get('project-1')))

            const responsePromise = fetch(`${address}/v1/projects/project-1/sessions`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'idempotency-key': 'create-1' },
                body: JSON.stringify({
                    provider: 'test', title: 'New work', model: 'model-1', mode: 'agent', config: { effort: 'high' },
                }),
            })
            const command = await nextJson(connection.socket)
            expect(command).toMatchObject({
                type: 'command.request',
                gatewayId: 'gateway-1',
                idempotencyKey: 'create-1',
                payload: {
                    projectId: 'project-1',
                    command: {
                        kind: 'session.create', provider: 'test', title: 'New work', model: 'model-1', mode: 'agent',
                        config: { effort: 'high' },
                    },
                },
            })
            expect(command.payload.sessionId).toMatch(/^[0-9a-f-]{36}$/)

            expect(await app.relay.repositories.sessions.get(command.payload.sessionId)).toBeUndefined()
            connection.socket.send(JSON.stringify(inventoryFrame(
                'gateway-1',
                connection.epoch,
                [sessionRecord('session-1', 'gateway-1'), sessionRecord(command.payload.sessionId, 'gateway-1', 'New work')],
            )))
            const response = await responsePromise
            expect(response.status).toBe(201)
            expect(await response.json()).toMatchObject({
                session: { id: command.payload.sessionId, projectId: 'project-1', title: 'New work' },
            })
            await nextJson(connection.socket)

            const retry = await fetch(`${address}/v1/projects/project-1/sessions`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'idempotency-key': 'create-1' },
                body: JSON.stringify({ provider: 'test', config: {} }),
            })
            expect(retry.status).toBe(201)
            expect(await retry.json()).toMatchObject({ session: { id: command.payload.sessionId } })
        } finally {
            await app.close()
        }
    })

    it('maps rejected and timed-out session creation without synthesizing metadata', async () => {
        const app = await createRelayServer({
            clientAuthenticator: allowClients,
            gatewayAuthenticator: allowGateways,
            createSessionTimeoutMs: 75,
        })
        const address = await app.listen({ host: '127.0.0.1', port: 0 })
        try {
            const connection = await authenticateGateway(address, 'gateway-1')
            sendHello(connection.socket, 'gateway-1', connection.epoch)
            connection.socket.send(JSON.stringify(inventoryFrame('gateway-1', connection.epoch)))
            await nextJson(connection.socket)

            const rejectedPromise = fetch(`${address}/v1/projects/project-1/sessions`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'idempotency-key': 'create-rejected' },
                body: JSON.stringify({ provider: 'test', config: {} }),
            })
            const rejectedCommand = await nextJson(connection.socket)
            connection.socket.send(JSON.stringify(commandFrame(
                'command.failed', 'gateway-1', connection.epoch, rejectedCommand.payload.commandId,
                {
                    commandId: rejectedCommand.payload.commandId,
                    failedAt: new Date().toISOString(),
                    status: 'rejected',
                    error: { code: 'provider_unavailable', message: 'Provider is unavailable', retryable: false },
                },
            )))
            const rejected = await rejectedPromise
            expect(rejected.status).toBe(409)
            expect(await rejected.json()).toEqual({ error: 'Provider is unavailable' })
            expect(await app.relay.repositories.sessions.get(rejectedCommand.payload.sessionId)).toBeUndefined()

            const timeoutPromise = fetch(`${address}/v1/projects/project-1/sessions`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'idempotency-key': 'create-timeout' },
                body: JSON.stringify({ provider: 'test', config: {} }),
            })
            const timeoutCommand = await nextJson(connection.socket)
            const timedOut = await timeoutPromise
            expect(timedOut.status).toBe(504)
            expect(await timedOut.json()).toEqual({ error: 'Timed out waiting for Gateway session inventory' })
            expect(await app.relay.repositories.sessions.get(timeoutCommand.payload.sessionId)).toBeUndefined()
        } finally {
            await app.close()
        }
    })

    it('routes commands and records accepted, result, and failed lifecycle frames', async () => {
        const app = await createRelayServer({ clientAuthenticator: allowClients, gatewayAuthenticator: allowGateways })
        const address = await app.listen({ host: '127.0.0.1', port: 0 })
        try {
            const connection = await authenticateGateway(address, 'gateway-1')
            sendHello(connection.socket, 'gateway-1', connection.epoch)
            connection.socket.send(JSON.stringify(inventoryFrame('gateway-1', connection.epoch)))
            await nextJson(connection.socket)
            await eventually(async () => Boolean(await app.relay.repositories.sessions.get('session-1')))

            const response = await fetch(`${address}/v1/sessions/session-1/messages`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'idempotency-key': 'idem-1' },
                body: JSON.stringify({ text: 'Run tests' }),
            })
            expect(response.status).toBe(202)
            const receipt = await response.json() as { commandId: string; status: string }
            expect(receipt.status).toBe('relay_accepted')

            const request = await nextJson(connection.socket)
            expect(request).toMatchObject({
                type: 'command.request',
                idempotencyKey: 'idem-1',
                payload: { commandId: receipt.commandId, command: { kind: 'session.message', text: 'Run tests' } },
            })
            connection.socket.send(JSON.stringify(commandFrame(
                'command.accepted', 'gateway-1', connection.epoch, receipt.commandId,
                { commandId: receipt.commandId, acceptedAt: new Date().toISOString() },
            )))
            await eventually(async () => (await app.relay.repositories.commands.get(receipt.commandId))?.status === 'gateway_accepted')

            connection.socket.send(JSON.stringify(commandFrame(
                'command.result', 'gateway-1', connection.epoch, receipt.commandId,
                { commandId: receipt.commandId, completedAt: new Date().toISOString(), result: { ok: true } },
            )))
            await eventually(async () => (await app.relay.repositories.commands.get(receipt.commandId))?.status === 'completed')

            const failedResponse = await fetch(`${address}/v1/sessions/session-1/cancel`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'idempotency-key': 'idem-2' },
                body: '{}',
            })
            const failedReceipt = await failedResponse.json() as { commandId: string }
            await nextJson(connection.socket)
            connection.socket.send(JSON.stringify(commandFrame(
                'command.failed', 'gateway-1', connection.epoch, failedReceipt.commandId,
                {
                    commandId: failedReceipt.commandId,
                    failedAt: new Date().toISOString(),
                    status: 'rejected',
                    error: { code: 'busy', message: 'Gateway is busy', retryable: true },
                },
            )))
            await eventually(async () => (await app.relay.repositories.commands.get(failedReceipt.commandId))?.status === 'rejected')
        } finally {
            await app.close()
        }
    })

    it('requests replay from zero on an empty Relay and from the persisted cursor after restart', async () => {
        const repositories = createInMemoryRelayRepositories()
        const first = await createRelayServer({ repositories, gatewayAuthenticator: allowGateways })
        const firstAddress = await first.listen({ host: '127.0.0.1', port: 0 })
        try {
            const connection = await authenticateGateway(firstAddress, 'gateway-1')
            sendHello(connection.socket, 'gateway-1', connection.epoch)
            connection.socket.send(JSON.stringify(inventoryFrame('gateway-1', connection.epoch)))
            expect(await nextJson(connection.socket)).toMatchObject({
                type: 'sync.request',
                connectionEpoch: connection.epoch,
                payload: { cursors: [{ sessionId: 'session-1', afterSeq: 0 }], includeInventory: false },
            })
            connection.socket.send(JSON.stringify(eventFrameAt('gateway-1', connection.epoch, 1)))
            await nextJson(connection.socket)
        } finally {
            await first.close()
        }

        const restarted = await createRelayServer({ repositories, gatewayAuthenticator: allowGateways })
        const restartedAddress = await restarted.listen({ host: '127.0.0.1', port: 0 })
        try {
            const connection = await authenticateGateway(restartedAddress, 'gateway-1')
            sendHello(connection.socket, 'gateway-1', connection.epoch)
            connection.socket.send(JSON.stringify(inventoryFrame('gateway-1', connection.epoch)))
            expect(await nextJson(connection.socket)).toMatchObject({
                type: 'sync.request',
                connectionEpoch: connection.epoch,
                payload: { cursors: [{ sessionId: 'session-1', afterSeq: 1 }], includeInventory: false },
            })
            connection.socket.send(JSON.stringify(syncCompleteFrame('gateway-1', connection.epoch, 1)))
            await new Promise(resolve => setTimeout(resolve, 20))
            expect(connection.socket.readyState).toBe(WebSocket.OPEN)
        } finally {
            await restarted.close()
        }
    })

    it('assigns a new epoch and replaces the previous connection after reconnect authentication', async () => {
        const app = await createRelayServer({ gatewayAuthenticator: allowGateways })
        const address = await app.listen({ host: '127.0.0.1', port: 0 })
        try {
            const first = await authenticateGateway(address, 'gateway-1')
            const firstClosed = new Promise<number>(resolve => first.socket.once('close', resolve))
            const second = await authenticateGateway(address, 'gateway-1')

            expect(second.epoch).not.toBe(first.epoch)
            expect(await firstClosed).toBe(4001)
            expect(app.relay.connections.get('gateway-1')?.connectionEpoch).toBe(second.epoch)
        } finally {
            await app.close()
        }
    })
})

async function authenticateGateway(address: string, gatewayId: string) {
    const socket = await connect(`${address.replace('http', 'ws')}/v1/gateway/connect`)
    const challenge = await nextJson(socket)
    expect(challenge.type).toBe('relay.auth.challenge')
    socket.send(JSON.stringify(authResponse(gatewayId)))
    const accepted = await nextJson(socket)
    expect(accepted).toMatchObject({ type: 'relay.auth.accepted', payload: { gatewayId } })
    return { socket, epoch: accepted.payload.connectionEpoch as string }
}

function authResponse(gatewayId: string) {
    return {
        version: 1,
        type: 'gateway.auth.response',
        messageId: crypto.randomUUID(),
        payload: {
            gatewayId,
            algorithm: 'ECDSA-P256-SHA256',
            fingerprint: 'sha256:test-key',
            signature: 'test-signature',
        },
    }
}

function sendHello(socket: WebSocket, gatewayId: string, epoch: string) {
    socket.send(JSON.stringify({
        version: 1,
        type: 'gateway.hello',
        messageId: crypto.randomUUID(),
        gatewayId,
        connectionEpoch: epoch,
        payload: {
            workspaceId: 'workspace-1',
            name: 'Test Gateway',
            platform: 'linux',
            gatewayVersion: '0.1.0',
            supportedProtocolVersions: [1],
            capabilities: { protocolVersions: [1], providers: ['test'], features: [] },
            connectedAt: new Date().toISOString(),
        },
    }))
}

function inventoryFrame(gatewayId: string, epoch: string, sessions = [sessionRecord('session-1', gatewayId)]) {
    const now = new Date().toISOString()
    return {
        version: 1,
        type: 'gateway.inventory.snapshot',
        messageId: crypto.randomUUID(),
        gatewayId,
        connectionEpoch: epoch,
        payload: {
            generatedAt: now,
            revision: 1,
            projects: [{
                id: 'project-1', gatewayId, name: 'Codever', rootPath: '/codever', canonicalRoot: '/codever',
            }],
            sessions,
        },
    }
}

function sessionRecord(id: string, gatewayId: string, title?: string) {
    const now = new Date().toISOString()
    return {
        id, gatewayId, projectId: 'project-1', state: 'idle', provider: 'test', config: {},
        ...(title && { title }), createdAt: now, updatedAt: now, lastEventSeq: 0,
    }
}

function syncCompleteFrame(gatewayId: string, epoch: string, seq: number) {
    return {
        version: 1,
        type: 'sync.complete',
        messageId: crypto.randomUUID(),
        gatewayId,
        connectionEpoch: epoch,
        payload: {
            completedAt: new Date().toISOString(),
            inventoryRevision: 1,
            cursors: [{ sessionId: 'session-1', seq }],
        },
    }
}

function eventFrame(gatewayId: string, epoch: string) {
    return eventFrameAt(gatewayId, epoch, 1)
}

function eventFrameAt(gatewayId: string, epoch: string, seq: number) {
    return {
        version: 1,
        type: 'session.event.batch',
        messageId: crypto.randomUUID(),
        gatewayId,
        connectionEpoch: epoch,
        sessionId: 'session-1',
        payload: {
            events: [{
                schemaVersion: 1,
                gatewayId,
                projectId: 'project-1',
                sessionId: 'session-1',
                seq,
                eventId: `event-${seq}`,
                timestamp: new Date().toISOString(),
                event: { kind: 'user_message', text: 'hello' },
            }],
        },
    }
}

function commandFrame(type: string, gatewayId: string, epoch: string, commandId: string, payload: unknown) {
    return {
        version: 1,
        type,
        messageId: crypto.randomUUID(),
        gatewayId,
        connectionEpoch: epoch,
        sessionId: 'session-1',
        idempotencyKey: commandId,
        payload,
    }
}

async function connect(url: string): Promise<WebSocket> {
    const socket = new WebSocket(url)
    sockets.push(socket)
    messageQueues.set(socket, [])
    socket.on('message', data => {
        const message = JSON.parse(data.toString()) as Record<string, any>
        const waiter = messageWaiters.get(socket)
        if (waiter) {
            messageWaiters.delete(socket)
            waiter(message)
        } else {
            messageQueues.get(socket)!.push(message)
        }
    })
    await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
    })
    return socket
}

function nextJson(socket: WebSocket): Promise<Record<string, any>> {
    const queued = messageQueues.get(socket)?.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for WebSocket message')), 2_000)
        messageWaiters.set(socket, message => {
            clearTimeout(timeout)
            resolve(message)
        })
    })
}

async function eventually(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (await check()) return
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('Condition was not met before timeout')
}
