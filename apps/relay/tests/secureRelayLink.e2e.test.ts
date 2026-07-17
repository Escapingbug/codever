import { createOpaqueServerSetup } from '@codever/secure-channel'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeGatewayIdentity } from '../../../src/gateway/identity'
import { GatewaySecureCredentialStore, RelayLink } from '../../../src/gateway/link'
import { createInMemoryRelayRepositories } from '../src/memoryRepositories'
import { createRelayServer, type RelayServer } from '../src/server'
import { SecureGatewayAuthenticator, type GatewayCredentialRecord } from '../src/secureGatewayAuth'

const servers: RelayServer[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())) })

describe('Gateway secure RelayLink end to end', () => {
    it('consumes the pairing code, provisions a random credential, and reconnects without the code', async () => {
        const records = new Map<string, GatewayCredentialRecord>()
        const credentials = {
            get: async (gatewayId: string) => records.get(gatewayId),
            put: async (gatewayId: string, registrationRecord: string) => {
                const record = { gatewayId, registrationRecord, enabled: true }
                records.set(gatewayId, record)
                return record
            },
        }
        const repositories = createInMemoryRelayRepositories()
        const authenticator = await SecureGatewayAuthenticator.create({
            relayId: 'relay-1', serverSetup: await createOpaqueServerSetup(), credentials,
        })
        const app = await createRelayServer({ repositories, relayId: 'relay-1', secureGatewayAuthenticator: authenticator })
        servers.push(app)
        await app.listen({ host: '127.0.0.1', port: 0 })
        const address = app.server.address()
        if (!address || typeof address === 'string') throw new Error('Expected TCP address')

        const directory = await mkdtemp(join(tmpdir(), 'codever-secure-link-'))
        const identity = await initializeGatewayIdentity(join(directory, 'identity'))
        const credentialStore = new GatewaySecureCredentialStore(join(directory, 'relay-credential.json'))
        const ticket = authenticator.issuePairing()
        const first = link(`ws://127.0.0.1:${address.port}/v2/gateway/connect`, identity, credentialStore, ticket.code)
        await first.start()
        await waitFor(async () => (await repositories.gateways.get('gateway-1'))?.status === 'online')
        expect(authenticator.pairing.hasOpenPairing(ticket.pairingId)).toBe(false)
        expect((await credentialStore.load('gateway-1'))?.relayId).toBe('relay-1')
        expect(records.get('gateway-1')?.registrationRecord).toBeTruthy()
        await first.stop()

        const second = link(`ws://127.0.0.1:${address.port}/v2/gateway/connect`, identity, credentialStore)
        await second.start()
        await waitFor(async () => app.relay.connections.get('gateway-1')?.ready === true)
        expect(second.state).toBe('online')
        await second.stop()
    }, 30_000)
})

function link(
    url: string,
    identity: Awaited<ReturnType<typeof initializeGatewayIdentity>>,
    credentialStore: GatewaySecureCredentialStore,
    pairingCode?: string,
): RelayLink {
    return new RelayLink({
        url,
        gatewayId: 'gateway-1',
        identity,
        secure: { credentialStore, ...(pairingCode ? { pairingCode } : {}) },
        hello: {
            workspaceId: 'workspace-1', name: 'Gateway 1', platform: 'linux', gatewayVersion: '0.1.0',
            supportedProtocolVersions: [1],
            capabilities: { protocolVersions: [1], providers: ['test'], features: [] },
        },
        getInventory: async () => ({ generatedAt: new Date().toISOString(), revision: 1, projects: [], sessions: [] }),
        handleCommand: async () => undefined,
        heartbeatIntervalMs: 60_000,
        reconnect: { initialDelayMs: 10, maxDelayMs: 10, jitter: 0 },
    })
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
        if (await predicate()) return
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('Condition was not reached')
}
