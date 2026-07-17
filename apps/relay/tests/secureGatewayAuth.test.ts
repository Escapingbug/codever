import {
    createOpaqueServerSetup,
    finishOpaquePairingClient,
    startOpaquePairingClient,
} from '@codever/secure-channel'
import { describe, expect, it } from 'vitest'
import { SecureGatewayAuthenticator } from '../src/secureGatewayAuth'

describe('SecureGatewayAuthenticator', () => {
    it('opens only an explicit one-time pairing and returns the OPAQUE session key', async () => {
        const serverSetup = await createOpaqueServerSetup()
        const authenticator = await SecureGatewayAuthenticator.create({
            relayId: 'relay-1', serverSetup,
            credentials: { get: async () => undefined, put: async (gatewayId, registrationRecord) => ({ gatewayId, registrationRecord, enabled: true }) },
        })
        const ticket = authenticator.issuePairing()
        const clientStart = await startOpaquePairingClient(ticket.code)
        const serverStart = await authenticator.begin({
            mode: 'pairing', gatewayId: 'gateway-1', subjectId: clientStart.pairingId,
            startLoginRequest: clientStart.startLoginRequest,
        })
        const clientFinish = finishOpaquePairingClient({
            code: ticket.code, serverId: 'relay-1', clientLoginState: clientStart.clientLoginState,
            loginResponse: serverStart.loginResponse,
        })
        const serverFinish = await authenticator.finish({
            handshakeId: serverStart.handshakeId, finishLoginRequest: clientFinish.finishLoginRequest,
        })
        expect(serverFinish).toEqual({
            gatewayId: 'gateway-1', sessionKey: clientFinish.sessionKey, credentialProvisioningRequired: true,
        })
        await expect(authenticator.finish({
            handshakeId: serverStart.handshakeId, finishLoginRequest: clientFinish.finishLoginRequest,
        })).rejects.toThrow('invalid or expired')
    }, 15_000)
})
