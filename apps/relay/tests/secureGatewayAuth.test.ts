import { createOpaqueServerSetup, finishOpaquePairingClient, startOpaquePairingClient } from '@codever/secure-channel'
import { nkeys } from '@nats-io/transport-node'
import { describe, expect, it } from 'vitest'
import { SecureGatewayAuthenticator } from '../src/secureGatewayAuth'

const jwt = `${'a'.repeat(40)}.${'b'.repeat(80)}.${'c'.repeat(64)}`

describe('SecureGatewayAuthenticator', () => {
    it('consumes one OPAQUE code and signs only the supplied NKey public key', async () => {
        const authenticator = await SecureGatewayAuthenticator.create({
            relayId: 'relay-1', serverSetup: await createOpaqueServerSetup(),
            natsCredentials: {
                issueClient: async (_id, publicKey) => ({ publicKey, userJwt: jwt, websocketUrl: 'wss://relay.test/nats' }),
                issueGateway: async (_id, publicKey) => ({ publicKey, userJwt: jwt, natsUrl: 'tls://relay.test:4222' }),
            },
        })
        const ticket = authenticator.issuePairing()
        const client = await startOpaquePairingClient(ticket.code)
        const key = nkeys.createUser()
        const started = await authenticator.begin({
            gatewayId: 'gateway-1', subjectId: client.pairingId,
            startLoginRequest: client.startLoginRequest, natsPublicKey: key.getPublicKey(),
        })
        const finished = finishOpaquePairingClient({
            domain: 'relay-gateway', code: ticket.code, serverId: 'relay-1',
            clientLoginState: client.clientLoginState, loginResponse: started.loginResponse,
        })
        await expect(authenticator.finish({
            handshakeId: started.handshakeId, finishLoginRequest: finished.finishLoginRequest,
        })).resolves.toMatchObject({
            gatewayId: 'gateway-1', sessionKey: finished.sessionKey, natsUserJwt: jwt, natsUrl: 'tls://relay.test:4222',
        })
        await expect(authenticator.finish({
            handshakeId: started.handshakeId, finishLoginRequest: finished.finishLoginRequest,
        })).rejects.toThrow('invalid or expired')
    }, 15_000)
})
