import { randomUUID } from 'node:crypto'
import type { GatewayFrame } from '@codever/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { GatewaySecureCredentialStore } from '../secureCredentialStore'
import type { RelayLink as RelayLinkType } from '../relayLink'

vi.mock('../secureGatewayHandshake', () => ({
    SecureGatewayHandshake: class {
        ready = false
        accepted?: { connectionEpoch: string }

        async start() {
            return { version: 1, type: 'gateway.secure-auth.start', messageId: randomUUID(), payload: {} }
        }

        async handleHandshake(value: unknown) {
            const frame = value as { type?: string; connectionEpoch?: string }
            if (frame.type !== 'relay.test.accept' || !frame.connectionEpoch) throw new Error('Unexpected test handshake frame')
            this.accepted = { connectionEpoch: frame.connectionEpoch }
            this.ready = true
            return undefined
        }

        async handleSecureData(value: unknown) {
            return this.handleHandshake(value)
        }

        async encryptApplication(value: unknown) {
            return { version: 1, type: 'secure.test', messageId: randomUUID(), payload: value }
        }

        async decryptApplication(value: unknown) {
            return (value as { payload: unknown }).payload
        }
    },
}))

const links: RelayLinkType[] = []
const servers: WebSocketServer[] = []

const { RelayLink } = await import('../relayLink')

afterEach(async () => {
    await Promise.all(links.splice(0).map(link => link.stop()))
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

describe('RelayLink secure-only transport', () => {
    it('requires secure configuration and the /v2 Gateway endpoint', () => {
        expect(() => new RelayLink(createLinkOptions('ws://relay.example.test/v1/gateway/connect')))
            .toThrow('/v2/gateway/connect')
        expect(() => new RelayLink({
            ...createLinkOptions('ws://relay.example.test/v2/gateway/connect'),
            secure: undefined,
        } as never)).toThrow('secure credentialStore is required')
    })

    it('opens only /v2 and sends encrypted hello and heartbeat after secure acceptance', async () => {
        const relay = await createMockRelay()
        const link = createLink(relay.url)

        await link.start()
        const connection = await relay.connection()
        expect(connection.path).toBe('/v2/gateway/connect')
        expect(connection.handshakeFrames.map(frame => frame.type)).toEqual(['gateway.secure-auth.start'])
        expect(await connection.next('gateway.hello')).toMatchObject({
            gatewayId: 'gateway-1', connectionEpoch: connection.epoch,
        })
        const heartbeat = await connection.next('gateway.heartbeat')
        expect(Object.keys(heartbeat.payload).sort()).toEqual(['sentAt', 'uptimeMs'])
        expect(connection.applicationFrames.map(frame => frame.type)).toEqual(['gateway.hello', 'gateway.heartbeat'])
        expect(link.state).toBe('online')
    })

    it('handles encrypted device tunnel frames and encrypts tunnel responses', async () => {
        const relay = await createMockRelay()
        const received: unknown[] = []
        const link = createLink(relay.url, {
            handleDeviceTunnel: async (payload, actions) => {
                received.push(payload)
                if ('openedAt' in payload) actions.send('gateway-response')
                if ('opaquePayload' in payload) actions.close('complete')
            },
        })
        await link.start()
        const connection = await relay.connection()
        await connection.next('gateway.hello')
        await connection.next('gateway.heartbeat')

        connection.send(dataFrame(connection, 'device.tunnel.open', {
            tunnelId: 'tunnel-1', openedAt: new Date().toISOString(),
        }))
        expect(await connection.next('device.tunnel.data')).toMatchObject({
            payload: { tunnelId: 'tunnel-1', opaquePayload: 'gateway-response' },
        })

        connection.send(dataFrame(connection, 'device.tunnel.data', {
            tunnelId: 'tunnel-1', opaquePayload: 'device-request',
        }))
        expect(await connection.next('device.tunnel.close')).toMatchObject({
            payload: { tunnelId: 'tunnel-1', reason: 'complete' },
        })
        expect(received).toEqual([
            expect.objectContaining({ tunnelId: 'tunnel-1', openedAt: expect.any(String) }),
            { tunnelId: 'tunnel-1', opaquePayload: 'device-request' },
        ])
    })

    it('closes the connection when decrypted data is not a device-tunnel frame', async () => {
        const relay = await createMockRelay()
        const errors: Error[] = []
        const link = createLink(relay.url, { onError: error => errors.push(error) })
        await link.start()
        const connection = await relay.connection()
        await connection.next('gateway.hello')
        await connection.next('gateway.heartbeat')

        connection.send({ version: 1, type: 'relay.forbidden', messageId: randomUUID(), payload: {} })
        await connection.closed
        expect(errors).not.toHaveLength(0)
    })
})

interface MockConnection {
    socket: WebSocket
    path: string
    epoch: string
    handshakeFrames: Array<Record<string, any>>
    applicationFrames: Array<Record<string, any>>
    closed: Promise<void>
    send(frame: unknown): void
    next(type: string): Promise<any>
}

async function createMockRelay(): Promise<{ url: string; connection(): Promise<MockConnection> }> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve)
        server.once('error', reject)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Mock Relay did not bind a TCP port')

    let resolveConnection!: (connection: MockConnection) => void
    const connected = new Promise<MockConnection>(resolve => { resolveConnection = resolve })
    server.on('connection', (socket, request) => {
        const epoch = randomUUID()
        const handshakeFrames: Array<Record<string, any>> = []
        const applicationFrames: Array<Record<string, any>> = []
        const queue: any[] = []
        const waiters = new Map<string, Array<(frame: any) => void>>()
        let accepted = false
        let resolveClosed!: () => void
        const closed = new Promise<void>(resolve => { resolveClosed = resolve })
        socket.once('close', resolveClosed)
        const connection: MockConnection = {
            socket,
            path: request.url ?? '',
            epoch,
            handshakeFrames,
            applicationFrames,
            closed,
            send(frame) {
                socket.send(JSON.stringify({ version: 1, type: 'secure.test', messageId: randomUUID(), payload: frame }))
            },
            next(type) {
                const queuedIndex = queue.findIndex(frame => frame.type === type)
                if (queuedIndex >= 0) return Promise.resolve(queue.splice(queuedIndex, 1)[0])
                return new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 2_000)
                    const list = waiters.get(type) ?? []
                    list.push(frame => {
                        clearTimeout(timeout)
                        resolve(frame)
                    })
                    waiters.set(type, list)
                })
            },
        }
        resolveConnection(connection)
        socket.on('message', raw => {
            const wire = JSON.parse(raw.toString()) as any
            if (!accepted) {
                handshakeFrames.push(wire)
                accepted = true
                socket.send(JSON.stringify({ type: 'relay.test.accept', connectionEpoch: epoch }))
                return
            }
            expect(wire.type).toBe('secure.test')
            const frame = wire.payload
            applicationFrames.push(frame)
            const waiter = waiters.get(frame.type)?.shift()
            if (waiter) waiter(frame)
            else queue.push(frame)
        })
    })

    return {
        url: `ws://127.0.0.1:${address.port}/v2/gateway/connect`,
        connection: () => connected,
    }
}

function createLink(
    url: string,
    overrides: Partial<ConstructorParameters<typeof RelayLink>[0]> = {},
): RelayLinkType {
    const link = new RelayLink({ ...createLinkOptions(url), ...overrides })
    links.push(link)
    return link
}

function createLinkOptions(url: string): ConstructorParameters<typeof RelayLink>[0] {
    return {
        url,
        gatewayId: 'gateway-1',
        hello: {
            workspaceId: 'workspace-1',
            name: 'Test Gateway',
            platform: 'linux',
            gatewayVersion: '0.1.0',
            supportedProtocolVersions: [1],
            capabilities: { protocolVersions: [1], providers: ['test'], features: ['device-tunnel'] },
        },
        secure: {
            pairingCode: 'ABCDEF-23456-789AB',
            credentialStore: new GatewaySecureCredentialStore('unused-test-credential.json'),
        },
        heartbeatIntervalMs: 60_000,
        reconnect: { initialDelayMs: 10_000, maxDelayMs: 10_000, jitter: 0 },
    }
}

function dataFrame<TType extends GatewayFrame['type']>(
    connection: MockConnection,
    type: TType,
    payload: Extract<GatewayFrame, { type: TType }>['payload'],
): Extract<GatewayFrame, { type: TType }> {
    return {
        version: 1,
        type,
        messageId: randomUUID(),
        gatewayId: 'gateway-1',
        connectionEpoch: connection.epoch,
        payload,
    } as Extract<GatewayFrame, { type: TType }>
}
