import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRelayConfig } from '../src/config'

const temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Relay runtime configuration', () => {
    it('loads only transport-neutral Relay settings and environment overrides', async () => {
        const directory = await temporaryDirectory()
        await writeFile(join(directory, 'relay.json'), JSON.stringify({
            host: '0.0.0.0', port: 8787, relayId: 'relay-from-file', logger: false,
            dataDirectory: './relay-state', natsUrl: 'nats://nats.internal:4222',
            natsCredentialsFile: './relay.creds',
        }))
        await expect(loadRelayConfig({
            CODEVER_RELAY_CONFIG: join(directory, 'relay.json'),
            CODEVER_RELAY_PORT: '9443',
        })).resolves.toEqual({
            host: '0.0.0.0', port: 9443, relayId: 'relay-from-file', logger: false,
            dataDirectory: join(directory, 'relay-state'), natsUrl: 'nats://nats.internal:4222',
            natsGatewayUrl: 'nats://nats.internal:4222',
            natsWebSocketUrl: 'ws://127.0.0.1:8080/',
            natsCredentialsFile: join(directory, 'relay.creds'),
            nscExecutable: 'nsc',
            nscConfigDirectory: join(directory, 'relay-state', 'nsc-config'),
            nscStoreDirectory: join(directory, 'relay-state', 'nsc-store'),
            nscKeysDirectory: join(directory, 'relay-state', 'nsc-keys'),
            nscOperator: 'CODEVER',
            nscAccount: 'CODEVER',
        })
    })

    it.each([
        'CODEVER_RELAY_INSECURE_DEV_AUTH',
        'CODEVER_RELAY_USERS_JSON',
        'CODEVER_RELAY_SESSION_TTL_SECONDS',
        'CODEVER_RELAY_TLS_CERT_FILE',
        'CODEVER_RELAY_GATEWAYS_JSON',
    ])('rejects removed configuration %s', async key => {
        await expect(loadRelayConfig({ [key]: 'removed' })).rejects.toThrow('Removed Relay configuration')
    })

    it('rejects legacy JSON settings including TLS and users', async () => {
        const directory = await temporaryDirectory()
        for (const legacy of ['tls', 'users', 'usersFile', 'sessionTtlSeconds', 'insecureDevAuth']) {
            await writeFile(join(directory, 'relay.json'), JSON.stringify({ [legacy]: {} }))
            await expect(loadRelayConfig({ CODEVER_RELAY_CONFIG: join(directory, 'relay.json') }))
                .rejects.toThrow('unknown field')
        }
    })

    it('rejects the removed repository mode', async () => {
        const directory = await temporaryDirectory()
        await writeFile(join(directory, 'relay.json'), JSON.stringify({ repositoryMode: 'durable' }))
        await expect(loadRelayConfig({ CODEVER_RELAY_CONFIG: join(directory, 'relay.json') }))
            .rejects.toThrow('unknown field')
    })
})

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'codever-relay-config-'))
    temporaryDirectories.push(directory)
    return directory
}
