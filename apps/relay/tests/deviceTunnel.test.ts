import type { ClientAuthenticator, GatewayAuthenticator } from '../src/auth'
import { createRelayServer } from '../src/server'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

const clients: ClientAuthenticator = {
    async authenticate() { return { id: 'user-1', workspaceId: 'workspace-1', deviceId: 'device-1' } },
    async authorize(_identity, action, target) {
        return action === 'gateway:tunnel' && target.gatewayId === 'gateway-1'
    },
}

const gateways: GatewayAuthenticator = {
    async verify() { return { authenticated: true } },
}

const sockets: WebSocket[] = []
const messageQueues = new WeakMap<WebSocket, Array<Record<string, any>>>()
const messageWaiters = new WeakMap<WebSocket, (message: Record<string, any>) => void>()

afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close()
})

describe('Relay-blind device tunnel', () => {
    it('routes opaque payloads without parsing their inner content', async () => {
        const app = await createRelayServer({ clientAuthenticator: clients, gatewayAuthenticator: gateways })
        const address = await app.listen({ host: '127.0.0.1', port: 0 })
        try {
            const gateway = await connect(`${address.replace('http', 'ws')}/v1/gateway/connect`)
            const challenge = await nextJson(gateway)
            gateway.send(JSON.stringify({
                version: 1,
                type: 'gateway.auth.response',
                messageId: 'gateway-auth-1',
                payload: {
                    gatewayId: 'gateway-1',
                    algorithm: 'ECDSA-P256-SHA256',
                    fingerprint: 'sha256:test',
                    signature: 'opaque-test-signature',
                },
            }))
            const accepted = await nextJson(gateway)
            const epoch = accepted.payload.connectionEpoch as string
            gateway.send(JSON.stringify({
                version: 1,
                type: 'gateway.hello',
                messageId: 'hello-1',
                gatewayId: 'gateway-1',
                connectionEpoch: epoch,
                payload: {
                    workspaceId: 'workspace-1',
                    name: 'Gateway 1',
                    platform: 'linux',
                    gatewayVersion: 'test',
                    supportedProtocolVersions: [1],
                    capabilities: { protocolVersions: [1], providers: [], features: [] },
                    connectedAt: new Date().toISOString(),
                },
            }))
            await eventually(() => app.relay.connections.get('gateway-1')?.ready === true)

            const device = await connect(`${address.replace('http', 'ws')}/v2/device/connect/gateway-1`)
            const gatewayOpenPromise = nextJson(gateway)
            const openedPromise = nextJson(device)
            device.send(JSON.stringify({
                version: 1,
                type: 'device.tunnel.open',
                messageId: 'device-open-1',
                payload: { gatewayId: 'gateway-1' },
            }))
            const gatewayOpen = await gatewayOpenPromise
            expect(gatewayOpen).toMatchObject({ type: 'device.tunnel.open', gatewayId: 'gateway-1' })
            const opened = await openedPromise
            expect(opened).toMatchObject({
                type: 'relay.device-tunnel.opened',
                payload: { gatewayId: 'gateway-1', tunnelId: gatewayOpen.payload.tunnelId },
            })

            const opaquePayload = Buffer.from(JSON.stringify({ secret: 'Relay must not inspect this' })).toString('base64url')
            device.send(JSON.stringify({
                version: 1,
                type: 'device.tunnel.data',
                messageId: 'device-data-1',
                payload: { tunnelId: gatewayOpen.payload.tunnelId, opaquePayload },
            }))
            expect(await nextJson(gateway)).toMatchObject({
                type: 'device.tunnel.data',
                payload: { tunnelId: gatewayOpen.payload.tunnelId, opaquePayload },
            })

            const deviceResponsePromise = nextJson(device)
            gateway.send(JSON.stringify({
                version: 1,
                type: 'device.tunnel.data',
                messageId: 'gateway-data-1',
                gatewayId: 'gateway-1',
                connectionEpoch: epoch,
                payload: { tunnelId: gatewayOpen.payload.tunnelId, opaquePayload: 'ZW5jcnlwdGVk' },
            }))
            expect(await deviceResponsePromise).toMatchObject({
                type: 'relay.device-tunnel.data',
                payload: { tunnelId: gatewayOpen.payload.tunnelId, opaquePayload: 'ZW5jcnlwdGVk' },
            })
        } finally {
            await app.close()
        }
    })

    it('rejects tunnel access before the gateway is online', async () => {
        const app = await createRelayServer({ clientAuthenticator: clients, gatewayAuthenticator: gateways })
        await app.relay.repositories.gateways.upsert({
            id: 'gateway-1', workspaceId: 'workspace-1', name: 'Gateway 1', platform: 'linux', version: 'test',
            capabilities: { protocolVersions: [1], providers: [], features: [] }, status: 'offline',
            lastSeenAt: new Date().toISOString(),
        })
        const address = await app.listen({ host: '127.0.0.1', port: 0 })
        try {
            const device = await connect(`${address.replace('http', 'ws')}/v2/device/connect/gateway-1`)
            device.send(JSON.stringify({
                version: 1, type: 'device.tunnel.open', messageId: 'device-open-2', payload: { gatewayId: 'gateway-1' },
            }))
            const closed = await onceClose(device)
            expect(closed.code).toBe(1013)
        } finally {
            await app.close()
        }
    })
})

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

async function nextJson(socket: WebSocket): Promise<Record<string, any>> {
    const queued = messageQueues.get(socket)?.shift()
    if (queued) return queued
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            messageWaiters.delete(socket)
            reject(new Error('Timed out waiting for WebSocket message'))
        }, 2_000)
        messageWaiters.set(socket, message => {
            clearTimeout(timeout)
            resolve(message)
        })
    })
}

async function onceClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
    return new Promise(resolve => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
}

async function eventually(check: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (check()) return
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('Condition was not met')
}
