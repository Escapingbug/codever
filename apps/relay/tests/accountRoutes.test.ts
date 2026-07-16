import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createInMemoryRelayRepositories } from '../src/memoryRepositories'
import type { Gateway } from '@codever/protocol'
import { createRelayServer } from '../src/server'
import {
    AuthSessionRepository,
    BearerAccountAuthenticator,
    CLIENT_BEARER_PROTOCOL_PREFIX,
    CLIENT_EVENT_PROTOCOL,
    hashPassword,
} from '../src/accountAuth'

describe('Relay account routes', () => {
    it('logs in, returns a token-free current session, authorizes APIs, and revokes logout', async () => {
        const repositories = createInMemoryRelayRepositories()
        await repositories.gateways.upsert(gateway('gateway-1', 'workspace-1'))
        await repositories.gateways.upsert(gateway('gateway-2', 'workspace-2'))
        const accounts = new BearerAccountAuthenticator({
            users: [{
                id: 'user-alice', username: 'alice', passwordHash: await hashPassword('secret'),
                workspaceId: 'workspace-1', roles: ['viewer'], enabled: true,
            }],
            sessions: AuthSessionRepository.memory(),
            gateways: repositories.gateways,
            sessionTtlSeconds: 3600,
        })
        const app = await createRelayServer({ repositories, clientAuthenticator: accounts, accountService: accounts })
        const address = await app.listen({ host: '127.0.0.1', port: 0 })
        try {
            const bad = await fetch(`${address}/v1/auth/login`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ username: 'alice', password: 'wrong' }),
            })
            expect(bad.status).toBe(401)

            const login = await fetch(`${address}/v1/auth/login`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ username: ' alice ', password: 'secret', deviceName: 'Pixel' }),
            })
            expect(login.status).toBe(200)
            const loggedIn = await login.json() as { accessToken: string; expiresAt: string; user: { username: string } }
            expect(loggedIn.accessToken.length).toBeGreaterThanOrEqual(20)
            expect(loggedIn.user.username).toBe('alice')
            const headers = { authorization: `Bearer ${loggedIn.accessToken}` }

            const current = await fetch(`${address}/v1/auth/session`, { headers })
            expect(current.status).toBe(200)
            const currentBody = await current.json() as Record<string, unknown>
            expect(currentBody).not.toHaveProperty('accessToken')
            expect(currentBody).toMatchObject({ user: { username: 'alice', workspaceId: 'workspace-1' } })

            const gateways = await fetch(`${address}/v1/gateways`, { headers })
            expect(await gateways.json()).toMatchObject({ gateways: [{ id: 'gateway-1' }] })

            const logout = await fetch(`${address}/v1/auth/logout`, { method: 'POST', headers })
            expect(logout.status).toBe(204)
            expect((await fetch(`${address}/v1/auth/session`, { headers })).status).toBe(401)
            expect((await fetch(`${address}/v1/gateways`, { headers })).status).toBe(401)
        } finally {
            await app.close()
        }
    })

    it('authenticates event WebSockets from a bearer subprotocol and responds with the fixed protocol', async () => {
        const repositories = createInMemoryRelayRepositories()
        await repositories.gateways.upsert(gateway('gateway-1', 'workspace-1'))
        await repositories.projects.replaceForGateway('gateway-1', [{
            id: 'project-1', gatewayId: 'gateway-1', name: 'Codever', rootPath: '/codever', canonicalRoot: '/codever',
        }])
        const now = new Date().toISOString()
        await repositories.sessions.replaceForGateway('gateway-1', [{
            id: 'session-1', gatewayId: 'gateway-1', projectId: 'project-1', state: 'idle', provider: 'test', config: {},
            createdAt: now, updatedAt: now, lastEventSeq: 0,
        }])
        const accounts = new BearerAccountAuthenticator({
            users: [{
                id: 'user-alice', username: 'alice', passwordHash: await hashPassword('secret'),
                workspaceId: 'workspace-1', roles: ['viewer'], enabled: true,
            }],
            sessions: AuthSessionRepository.memory(), gateways: repositories.gateways, sessionTtlSeconds: 3600,
        })
        const login = await accounts.login({ username: 'alice', password: 'secret' })
        const app = await createRelayServer({ repositories, clientAuthenticator: accounts, accountService: accounts })
        const address = await app.listen({ host: '127.0.0.1', port: 0 })
        const socket = new WebSocket(
            `${address.replace('http', 'ws')}/v1/sessions/session-1/events/ws`,
            [CLIENT_EVENT_PROTOCOL, `${CLIENT_BEARER_PROTOCOL_PREFIX}${login!.accessToken}`],
        )
        try {
            await new Promise<void>((resolve, reject) => {
                socket.once('open', resolve)
                socket.once('error', reject)
            })
            expect(socket.protocol).toBe(CLIENT_EVENT_PROTOCOL)
        } finally {
            socket.close()
            await app.close()
        }
    })
})

function gateway(id: string, workspaceId: string): Gateway {
    return {
        id, workspaceId, name: id, platform: 'linux', version: '1',
        capabilities: { protocolVersions: [1], providers: [], features: [] },
        status: 'offline', lastSeenAt: '2026-07-16T12:00:00.000Z',
    }
}
