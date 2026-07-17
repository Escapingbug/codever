import { describe, expect, it } from 'vitest'
import {
    createOpaqueCredentialRegistrationResponse,
    createOpaqueServerSetup,
    finishOpaqueCredentialClientLogin,
    finishOpaqueCredentialRegistration,
    finishOpaqueCredentialServerLogin,
    generateOpaqueCredentialSecret,
    getOpaqueServerPublicKey,
    startOpaqueCredentialLogin,
    startOpaqueCredentialRegistration,
    startOpaqueCredentialServerLogin,
} from '../src/opaqueCredential'

describe('OPAQUE long-lived device credential', () => {
    it('registers without revealing the secret and creates fresh matching login keys', async () => {
        const serverSetup = await createOpaqueServerSetup()
        const serverPublicKey = await getOpaqueServerPublicKey(serverSetup)
        const secret = generateOpaqueCredentialSecret()
        const registrationStart = await startOpaqueCredentialRegistration(secret)
        const registrationResponse = await createOpaqueCredentialRegistrationResponse({
            serverSetup, subjectId: 'gateway-1', serverId: 'relay-1',
            registrationRequest: registrationStart.registrationRequest,
        })
        const registration = await finishOpaqueCredentialRegistration({
            secret, subjectId: 'gateway-1', serverId: 'relay-1',
            clientRegistrationState: registrationStart.clientRegistrationState,
            registrationResponse, expectedServerStaticPublicKey: serverPublicKey,
            keyStretching: 'memory-constrained',
        })
        expect(registration.registrationRecord).not.toContain(secret)

        const clientStart = await startOpaqueCredentialLogin(secret)
        const serverStart = await startOpaqueCredentialServerLogin({
            serverSetup, registrationRecord: registration.registrationRecord,
            subjectId: 'gateway-1', serverId: 'relay-1', startLoginRequest: clientStart.startLoginRequest,
        })
        const clientFinish = await finishOpaqueCredentialClientLogin({
            secret, subjectId: 'gateway-1', serverId: 'relay-1', clientLoginState: clientStart.clientLoginState,
            loginResponse: serverStart.loginResponse, expectedServerStaticPublicKey: serverPublicKey,
            keyStretching: 'memory-constrained',
        })
        const serverSessionKey = await finishOpaqueCredentialServerLogin({
            serverLoginState: serverStart.serverLoginState, finishLoginRequest: clientFinish.finishLoginRequest,
            subjectId: 'gateway-1', serverId: 'relay-1',
        })
        expect(serverSessionKey).toBe(clientFinish.sessionKey)
    })
})
