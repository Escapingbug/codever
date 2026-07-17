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
            dataDirectory: './relay-state', repositoryMode: 'memory',
        }))
        await expect(loadRelayConfig({
            CODEVER_RELAY_CONFIG: join(directory, 'relay.json'),
            CODEVER_RELAY_PORT: '9443',
        })).resolves.toEqual({
            host: '0.0.0.0', port: 9443, relayId: 'relay-from-file', logger: false,
            dataDirectory: join(directory, 'relay-state'), repositoryMode: 'memory',
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

    it('uses durable storage by default and validates memory mode', async () => {
        await expect(loadRelayConfig({})).resolves.toMatchObject({ repositoryMode: 'durable' })
        await expect(loadRelayConfig({ CODEVER_RELAY_REPOSITORY_MODE: 'volatile' }))
            .rejects.toThrow('repositoryMode must be durable or memory')
    })
})

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'codever-relay-config-'))
    temporaryDirectories.push(directory)
    return directory
}
