import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GatewaySecureCredentialStore } from '../secureCredentialStore'

const userJwt = `${'a'.repeat(40)}.${'b'.repeat(80)}.${'c'.repeat(64)}`

describe('GatewaySecureCredentialStore', () => {
    it('atomically persists the credential before it can be loaded', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-secure-credential-'))
        const path = join(directory, 'credential.json')
        const store = new GatewaySecureCredentialStore(path)

        await store.save({
            version: 3,
            gatewayId: 'gateway-1',
            relayId: 'relay-1',
            natsSeed: 'SUAH6B6TKFSN2RLD2GJ32ID4FSEU6TDTFSPQBKPM4LCYKUXOXETQHAAXNE',
            natsUserJwt: userJwt,
            natsUrl: 'tls://relay.test:4222',
            createdAt: new Date(0).toISOString(),
        })

        expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ gatewayId: 'gateway-1' })
        await expect(store.load('gateway-1')).resolves.toMatchObject({ relayId: 'relay-1' })
    })
})
