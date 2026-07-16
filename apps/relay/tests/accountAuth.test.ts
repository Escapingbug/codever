import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyRequest } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { createInMemoryRelayRepositories } from '../src/memoryRepositories'
import {
    accessTokenFromRequest,
    AuthSessionRepository,
    BearerAccountAuthenticator,
    CLIENT_BEARER_PROTOCOL_PREFIX,
    CLIENT_EVENT_PROTOCOL,
    hashAccessToken,
    hashPassword,
    selectWebSocketProtocol,
    verifyPassword,
    type RelayUserAccount,
} from '../src/accountAuth'

const temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Relay account authentication', () => {
    it('hashes and verifies passwords with scrypt without embedding plaintext', async () => {
        const encoded = await hashPassword('correct horse battery staple')
        expect(encoded).toMatch(/^scrypt\$v1\$16384\$8\$1\$/)
        expect(encoded).not.toContain('correct horse')
        await expect(verifyPassword('correct horse battery staple', encoded)).resolves.toBe(true)
        await expect(verifyPassword('wrong', encoded)).resolves.toBe(false)
        await expect(verifyPassword('anything', 'not-a-hash')).resolves.toBe(false)
    })

    it('persists only token hashes, restores sessions, and revokes them', async () => {
        const directory = await temporaryDirectory()
        const path = join(directory, 'auth-sessions.json')
        const repositories = createInMemoryRelayRepositories()
        const sessions = await AuthSessionRepository.open(path)
        const authenticator = new BearerAccountAuthenticator({
            users: [await account('alice', 'secret', 'workspace-1', ['operator'])],
            sessions,
            gateways: repositories.gateways,
            sessionTtlSeconds: 3600,
            now: () => new Date('2026-07-16T12:00:00.000Z'),
        })

        const login = await authenticator.login({ username: 'ALICE', password: 'secret', deviceName: 'Pixel' })
        expect(login).toMatchObject({ user: { username: 'alice', workspaceId: 'workspace-1' } })
        const token = login!.accessToken
        const persisted = await readFile(path, 'utf8')
        expect(persisted).not.toContain(token)
        expect(persisted).not.toContain('secret')
        expect(persisted).toContain(hashAccessToken(token))

        const restored = new BearerAccountAuthenticator({
            users: [await account('alice', 'secret', 'workspace-1', ['operator'])],
            sessions: await AuthSessionRepository.open(path),
            gateways: repositories.gateways,
            sessionTtlSeconds: 3600,
            now: () => new Date('2026-07-16T12:30:00.000Z'),
        })
        const request = bearerRequest(token)
        await expect(restored.current(request)).resolves.toMatchObject({ user: { username: 'alice' } })
        await expect(restored.logout(request)).resolves.toBe(true)
        await expect(restored.authenticate(request)).resolves.toBeNull()
    })

    it('rejects expired and disabled-user sessions and enforces role/workspace access', async () => {
        const repositories = createInMemoryRelayRepositories()
        await repositories.gateways.upsert({
            id: 'gateway-1', workspaceId: 'workspace-1', name: 'one', platform: 'linux', version: '1',
            capabilities: { protocolVersions: [1], providers: [], features: [] }, status: 'offline', lastSeenAt: '2026-07-16T12:00:00.000Z',
        })
        await repositories.gateways.upsert({
            id: 'gateway-2', workspaceId: 'workspace-2', name: 'two', platform: 'linux', version: '1',
            capabilities: { protocolVersions: [1], providers: [], features: [] }, status: 'offline', lastSeenAt: '2026-07-16T12:00:00.000Z',
        })
        let now = new Date('2026-07-16T12:00:00.000Z')
        const viewer = await account('viewer', 'secret', 'workspace-1', ['viewer'])
        const authenticator = new BearerAccountAuthenticator({
            users: [viewer], sessions: AuthSessionRepository.memory(), gateways: repositories.gateways,
            sessionTtlSeconds: 60, now: () => now,
        })
        const login = await authenticator.login({ username: 'viewer', password: 'secret' })
        const identity = await authenticator.authenticate(bearerRequest(login!.accessToken))
        expect(identity).not.toBeNull()
        await expect(authenticator.authorize(identity!, 'session:read', { gatewayId: 'gateway-1' })).resolves.toBe(true)
        await expect(authenticator.authorize(identity!, 'session:message', { gatewayId: 'gateway-1' })).resolves.toBe(false)
        await expect(authenticator.authorize(identity!, 'session:read', { gatewayId: 'gateway-2' })).resolves.toBe(false)

        viewer.enabled = false
        await expect(authenticator.authenticate(bearerRequest(login!.accessToken))).resolves.toBeNull()
        viewer.enabled = true
        now = new Date('2026-07-16T12:01:00.001Z')
        await expect(authenticator.authenticate(bearerRequest(login!.accessToken))).resolves.toBeNull()
    })

    it('reads bearer WebSocket protocols while selecting only the fixed event protocol', () => {
        const token = 'abcdefghijklmnopqrstuvwxyz123456'
        const request = {
            headers: { 'sec-websocket-protocol': `${CLIENT_EVENT_PROTOCOL}, ${CLIENT_BEARER_PROTOCOL_PREFIX}${token}` },
        } as FastifyRequest
        expect(accessTokenFromRequest(request)).toBe(token)
        expect(selectWebSocketProtocol(new Set([
            CLIENT_EVENT_PROTOCOL,
            `${CLIENT_BEARER_PROTOCOL_PREFIX}${token}`,
        ]))).toBe(CLIENT_EVENT_PROTOCOL)
        expect(selectWebSocketProtocol(new Set([`${CLIENT_BEARER_PROTOCOL_PREFIX}${token}`]))).toBe(false)
    })
})

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'codever-relay-auth-'))
    temporaryDirectories.push(directory)
    return directory
}

async function account(
    username: string,
    password: string,
    workspaceId: string,
    roles: RelayUserAccount['roles'],
): Promise<RelayUserAccount> {
    return { id: `user-${username}`, username, passwordHash: await hashPassword(password), workspaceId, roles, enabled: true }
}

function bearerRequest(token: string): FastifyRequest {
    return { headers: { authorization: `Bearer ${token}` } } as FastifyRequest
}
