import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadOrLoginMatrixGateway } from '@/gateway/matrix/login'

const temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })),
    )
})

describe('Matrix Gateway login persistence', () => {
    it('persists the first password login and reuses it after a supervisor restart', async () => {
        const directory = await temporaryDirectory()
        const sessionPath = join(directory, 'matrix-session.json')
        const requests: Array<{ url: string; method: string }> = []
        const readPassword = vi.fn(async () => 'secret')
        const fetchImpl: typeof fetch = async (input, init) => {
            const url = String(input)
            requests.push({ url, method: init?.method ?? 'GET' })
            if (url.endsWith('/login')) {
                return jsonResponse({
                    user_id: '@gateway:example.org',
                    access_token: 'persisted-access-token',
                    device_id: 'GATEWAY_FIRST',
                })
            }
            return jsonResponse({
                user_id: '@gateway:example.org',
                device_id: 'GATEWAY_FIRST',
            })
        }

        const first = await loadOrLoginMatrixGateway({
            homeserver: 'https://example.org/',
            loginUser: 'gateway',
            deviceId: 'GATEWAY_FIRST',
            sessionPath,
            readPassword,
            fetch: fetchImpl,
        })
        const restarted = await loadOrLoginMatrixGateway({
            homeserver: 'https://example.org',
            loginUser: 'gateway',
            deviceId: 'GATEWAY_UNUSED',
            sessionPath,
            readPassword,
            fetch: fetchImpl,
        })

        expect(first).toEqual(restarted)
        expect(requests).toEqual([
            { url: 'https://example.org/_matrix/client/v3/login', method: 'POST' },
            { url: 'https://example.org/_matrix/client/v3/account/whoami', method: 'GET' },
        ])
        expect(readPassword).toHaveBeenCalledOnce()
        expect((await stat(sessionPath)).mode & 0o777).toBe(0o600)
        expect(JSON.parse(await readFile(sessionPath, 'utf8'))).toMatchObject({
            version: 1,
            homeserver: 'https://example.org',
            loginUser: 'gateway',
            access_token: 'persisted-access-token',
            device_id: 'GATEWAY_FIRST',
        })
    })

    it('honors login retry_after_ms without exiting into a supervisor restart loop', async () => {
        const directory = await temporaryDirectory()
        const sleep = vi.fn(async () => undefined)
        const onLog = vi.fn()
        let attempts = 0

        await expect(loadOrLoginMatrixGateway({
            homeserver: 'https://example.org',
            loginUser: 'gateway',
            deviceId: 'GATEWAY_RATE_LIMITED',
            sessionPath: join(directory, 'matrix-session.json'),
            readPassword: async () => 'secret',
            fetch: async () => {
                attempts += 1
                return attempts === 1
                    ? jsonResponse({ retry_after_ms: 42_123 }, 429)
                    : jsonResponse({
                        user_id: '@gateway:example.org',
                        access_token: 'new-access-token',
                        device_id: 'GATEWAY_RATE_LIMITED',
                    })
            },
            sleep,
            onLog,
        })).resolves.toMatchObject({ access_token: 'new-access-token' })

        expect(attempts).toBe(2)
        expect(sleep).toHaveBeenCalledWith(42_123)
        expect(onLog).toHaveBeenCalledWith(
            'Matrix login rate limited; retrying in 42123ms.',
        )
    })

    it('replaces only an explicitly rejected persisted access token', async () => {
        const directory = await temporaryDirectory()
        const sessionPath = join(directory, 'matrix-session.json')
        let rejectPersisted = false
        const fetchImpl: typeof fetch = async input => {
            const url = String(input)
            if (url.endsWith('/account/whoami')) {
                return rejectPersisted
                    ? jsonResponse({ errcode: 'M_UNKNOWN_TOKEN' }, 401)
                    : jsonResponse({
                        user_id: '@gateway:example.org',
                        device_id: 'GATEWAY_OLD',
                    })
            }
            const next = rejectPersisted ? 'GATEWAY_NEW' : 'GATEWAY_OLD'
            return jsonResponse({
                user_id: '@gateway:example.org',
                access_token: `token-${next}`,
                device_id: next,
            })
        }
        const readPassword = vi.fn(async () => 'secret')

        await loadOrLoginMatrixGateway({
            homeserver: 'https://example.org',
            loginUser: 'gateway',
            deviceId: 'GATEWAY_OLD',
            sessionPath,
            readPassword,
            fetch: fetchImpl,
        })
        rejectPersisted = true
        const replaced = await loadOrLoginMatrixGateway({
            homeserver: 'https://example.org',
            loginUser: 'gateway',
            deviceId: 'GATEWAY_NEW',
            sessionPath,
            readPassword,
            fetch: fetchImpl,
        })

        expect(replaced.device_id).toBe('GATEWAY_NEW')
        expect(readPassword).toHaveBeenCalledTimes(2)
        expect(JSON.parse(await readFile(sessionPath, 'utf8'))).toMatchObject({
            access_token: 'token-GATEWAY_NEW',
            device_id: 'GATEWAY_NEW',
        })
    })
})

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'codever-matrix-login-'))
    temporaryDirectories.push(directory)
    return directory
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    })
}
