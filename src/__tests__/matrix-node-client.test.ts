import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    MatrixNodeSdkGatewayClient,
    loadOrCreateMatrixCryptoPassphrase,
} from '@/gateway/matrix'

const temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path =>
        rm(path, { recursive: true, force: true })))
})

describe('MatrixNodeSdkGatewayClient', () => {
    it('reopens the same Olm identity for a persisted Matrix device', async () => {
        const directory = await temporaryDirectory()
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            one_time_key_counts: {},
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch
        const config = {
            backend: 'node-sqlite' as const,
            storagePath: join(directory, 'crypto'),
            storagePassword: 'test-only-passphrase',
            syncTokenPath: join(directory, 'sync.json'),
        }
        const connection = {
            baseUrl: 'https://matrix.example.test',
            accessToken: 'token',
            userId: '@gateway:example.test',
            deviceId: 'STABLE_DEVICE',
        }

        const first = new MatrixNodeSdkGatewayClient(
            connection,
            1_000,
            undefined,
            fetchMock,
        )
        await first.initializeCrypto(config)
        const firstKeys = first.getOwnDeviceKeys()
        await first.stop()

        const second = new MatrixNodeSdkGatewayClient(
            connection,
            1_000,
            undefined,
            fetchMock,
        )
        await second.initializeCrypto(config)
        expect(second.getOwnDeviceKeys()).toEqual(firstKeys)
        await second.stop()
    })

    it('creates one stable, owner-only crypto-store passphrase', async () => {
        const directory = await temporaryDirectory()
        const path = join(directory, 'matrix-crypto.passphrase')

        const first = await loadOrCreateMatrixCryptoPassphrase(path)
        const second = await loadOrCreateMatrixCryptoPassphrase(path)

        expect(second).toBe(first)
        expect(first.length).toBeGreaterThanOrEqual(40)
        expect((await stat(path)).mode & 0o777).toBe(0o600)
    })

    it('restarts only the sync loop while preserving the crypto identity', async () => {
        const directory = await temporaryDirectory()
        let syncRequests = 0
        const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input)
            if (url.includes('/_matrix/client/v3/sync')) {
                syncRequests += 1
                if (syncRequests === 2) {
                    return new Response(JSON.stringify({
                        next_batch: 'sync-after-restart',
                        to_device: { events: [] },
                        device_lists: { changed: [], left: [] },
                        device_one_time_keys_count: {},
                        rooms: { join: {} },
                    }), {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    })
                }
                return new Promise<Response>((_resolve, reject) => {
                    const signal = init?.signal
                    const rejectAbort = () => reject(
                        signal?.reason ?? new DOMException('Aborted', 'AbortError'),
                    )
                    if (signal?.aborted) rejectAbort()
                    else signal?.addEventListener('abort', rejectAbort, { once: true })
                })
            }
            return new Response(JSON.stringify({ one_time_key_counts: {} }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        }) as unknown as typeof fetch
        const client = new MatrixNodeSdkGatewayClient(
            {
                baseUrl: 'https://matrix.example.test',
                accessToken: 'token',
                userId: '@gateway:example.test',
                deviceId: 'STABLE_DEVICE',
            },
            1_000,
            undefined,
            fetchMock,
        )
        await client.initializeCrypto({
            backend: 'node-sqlite',
            storagePath: join(directory, 'crypto'),
            storagePassword: 'test-only-passphrase',
            syncTokenPath: join(directory, 'sync.json'),
        })
        const keys = client.getOwnDeviceKeys()
        await client.start()
        await vi.waitFor(() => expect(syncRequests).toBe(1))

        await client.restartSync()
        await client.waitUntilReady()

        expect(syncRequests).toBeGreaterThanOrEqual(2)
        expect(client.getOwnDeviceKeys()).toEqual(keys)
        await client.stop()
    })
})

async function temporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'codever-matrix-node-client-'))
    temporaryDirectories.push(path)
    return path
}
