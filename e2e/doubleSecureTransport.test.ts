import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ClientGatewayResponseFrame } from '@codever/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { ClientCredentialRepository, SecureClientAuthenticator, SecureCredentialRepository, SecureGatewayAuthenticator, createRelayServer } from '../apps/relay/src/index'
import { SecureRelayClient } from '../apps/web/src/api/secureRelayClient'
import { DeviceSecureHandshake } from '../apps/web/src/security/deviceSecureHandshake'
import { ClientDeviceCredentialStore } from '../apps/web/src/security/deviceCredentialStore'
import { ClientRelayCredentialStore } from '../apps/web/src/security/relayCredentialStore'
import { RelaySecureHandshake } from '../apps/web/src/security/relaySecureHandshake'
import { MemorySecretStore } from '../apps/web/src/security/secretStore'
import { GatewaySecureCredentialStore, RelayLink } from '../src/gateway/link'
import { DeviceAuthenticator } from '../src/gateway/security/deviceAuthenticator'
import { DeviceCredentialRepository } from '../src/gateway/security/deviceCredentialRepository'
import { DeviceSecureSession } from '../src/gateway/security/deviceSecureSession'

const directories: string[] = []

afterEach(async () => {
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('two-layer secure client path', () => {
    it('pairs Client↔Relay and Client↔Gateway, then carries business data Relay-blind', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-double-e2e-'))
        directories.push(directory)
        const relayGatewayCredentials = await SecureCredentialRepository.open(join(directory, 'relay-gateways.json'))
        const relayClientCredentials = await ClientCredentialRepository.open(join(directory, 'relay-clients.json'))
        const gatewayAuth = await SecureGatewayAuthenticator.create({
            relayId: 'relay-1', serverSetup: relayGatewayCredentials.serverSetup, credentials: relayGatewayCredentials,
        })
        const clientAuth = await SecureClientAuthenticator.create({
            relayId: 'relay-1', serverSetup: relayClientCredentials.serverSetup, credentials: relayClientCredentials,
        })
        const gatewayTicket = gatewayAuth.issuePairing()
        const clientTicket = clientAuth.issuePairing()
        const relay = await createRelayServer({ secureGatewayAuthenticator: gatewayAuth, secureClientAuthenticator: clientAuth })
        const address = await relay.listen({ host: '127.0.0.1', port: 0 })

        const deviceCredentials = await DeviceCredentialRepository.open(join(directory, 'gateway-devices.json'))
        const deviceAuth = await DeviceAuthenticator.create({
            gatewayId: 'gateway-1', serverSetup: deviceCredentials.serverSetup, credentials: deviceCredentials,
        })
        const deviceTicket = deviceAuth.issuePairing()
        const deviceSessions = new Map<string, DeviceSecureSession>()
        const gateway = new RelayLink({
            url: `${address.replace('http', 'ws')}/v2/gateway/connect`,
            gatewayId: 'gateway-1',
            hello: {
                workspaceId: 'workspace-1', name: 'Gateway One', platform: 'linux', gatewayVersion: 'test',
                supportedProtocolVersions: [1],
                capabilities: { protocolVersions: [1], providers: ['test'], features: ['device-tunnel'] },
            },
            secure: {
                pairingCode: gatewayTicket.code,
                credentialStore: new GatewaySecureCredentialStore(join(directory, 'gateway-relay-credential.json')),
            },
            handleDeviceTunnel: async (payload, actions) => {
                if ('openedAt' in payload) {
                    deviceSessions.set(payload.tunnelId, new DeviceSecureSession({
                        gatewayId: 'gateway-1', authenticator: deviceAuth, send: actions.send,
                        handleRequest: request => ({
                            version: 1, type: 'gateway.client.response', requestId: request.requestId,
                            status: 'completed', completedAt: new Date().toISOString(),
                            payload: {
                                generatedAt: new Date().toISOString(), revision: 7,
                                projects: [], sessions: [],
                            },
                        } satisfies ClientGatewayResponseFrame),
                    }))
                } else if ('opaquePayload' in payload) {
                    await deviceSessions.get(payload.tunnelId)?.receive(payload.opaquePayload)
                } else {
                    deviceSessions.get(payload.tunnelId)?.close()
                    deviceSessions.delete(payload.tunnelId)
                }
            },
            heartbeatIntervalMs: 60_000,
        })

        try {
            await gateway.start()
            const secrets = new MemorySecretStore()
            const relayStore = new ClientRelayCredentialStore(secrets)
            const outerHandshake = new RelaySecureHandshake({
                relayProfileId: 'profile-1', credentialId: 'client-1', pairingCode: clientTicket.code,
                saveCredential: value => relayStore.save(value),
            })
            const client = new SecureRelayClient({
                baseUrl: address,
                handshake: outerHandshake,
                webSocketFactory: url => new WebSocket(url) as unknown as globalThis.WebSocket,
            })
            await client.connect()
            await eventually(async () => (await client.listGateways()).some(value => value.id === 'gateway-1'))

            const deviceStore = new ClientDeviceCredentialStore(secrets)
            const innerHandshake = new DeviceSecureHandshake({
                relayProfileId: 'profile-1', gatewayId: 'gateway-1', credentialId: 'device-1',
                pairingCode: deviceTicket.code,
                saveCredential: value => deviceStore.save(value),
            })
            const connection = await client.openGateway('gateway-1', innerHandshake)
            const response = await connection.request({ kind: 'inventory.get' })
            expect(response).toMatchObject({
                status: 'completed', payload: { revision: 7, projects: [], sessions: [] },
            })
            expect(await relayClientCredentials.get('client-1')).toMatchObject({ enabled: true })
            expect(await deviceCredentials.get('device-1')).toMatchObject({ enabled: true })
            expect(clientTicket.code).not.toBe(deviceTicket.code)
            client.close()
        } finally {
            await gateway.stop()
            await relay.close()
        }
    }, 45_000)
})

async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (await check()) return
        await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('Condition was not met')
}
