import {
    finishOpaqueCredentialClientLogin,
    finishOpaqueCredentialRegistration,
    finishOpaquePairingClient,
    startOpaqueCredentialLogin,
    startOpaqueCredentialRegistration,
    startOpaquePairingClient,
} from '@codever/secure-channel'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DeviceAuthenticator } from '../deviceAuthenticator'
import { DeviceCredentialRepository } from '../deviceCredentialRepository'

describe('DeviceAuthenticator', () => {
    it('binds pairing to the Gateway identity and consumes it exactly once', async () => {
        const now = Date.parse('2026-07-17T08:00:00.000Z')
        const { authenticator } = await fixture(() => now)
        const ticket = authenticator.issuePairing()
        expect(ticket.attemptsRemaining).toBe(5)
        expect(Date.parse(ticket.expiresAt) - now).toBe(3 * 60_000)

        const clientStart = await startOpaquePairingClient(ticket.code)
        const serverStart = await authenticator.begin({
            mode: 'pairing',
            credentialId: 'device-1',
            subjectId: clientStart.pairingId,
            startLoginRequest: clientStart.startLoginRequest,
        })
        expect(Date.parse(serverStart.expiresAt) - now).toBe(30_000)
        const clientFinish = finishOpaquePairingClient({
            code: ticket.code,
            serverId: 'gateway-1',
            clientLoginState: clientStart.clientLoginState,
            loginResponse: serverStart.loginResponse,
        })
        await expect(authenticator.finish({
            handshakeId: serverStart.handshakeId,
            finishLoginRequest: clientFinish.finishLoginRequest,
        })).resolves.toEqual({
            credentialId: 'device-1',
            sessionKey: clientFinish.sessionKey,
            credentialProvisioningRequired: true,
        })
        await expect(authenticator.finish({
            handshakeId: serverStart.handshakeId,
            finishLoginRequest: clientFinish.finishLoginRequest,
        })).rejects.toThrow('Gateway device handshake is invalid or expired')
    }, 15_000)

    it('rejects a wrong credential and prevents a revoked credential from starting', async () => {
        const { authenticator } = await fixture()
        const correctSecret = 'correct-device-secret-000000000000'
        const registrationStart = await startOpaqueCredentialRegistration(correctSecret)
        const registrationResponse = await authenticator.createCredentialRegistrationResponse(
            'device-1',
            registrationStart.registrationRequest,
        )
        const registration = await finishOpaqueCredentialRegistration({
            secret: correctSecret,
            subjectId: 'device-1',
            serverId: 'gateway-1',
            clientRegistrationState: registrationStart.clientRegistrationState,
            registrationResponse: registrationResponse.registrationResponse,
            expectedServerStaticPublicKey: registrationResponse.serverStaticPublicKey,
        })
        await authenticator.commitCredential('device-1', registration.registrationRecord, 'Alice phone')

        const wrongStart = await startOpaqueCredentialLogin('wrong-device-secret-0000000000000')
        const wrongServerStart = await authenticator.begin({
            mode: 'credential',
            credentialId: 'device-1',
            subjectId: 'device-1',
            startLoginRequest: wrongStart.startLoginRequest,
        })
        await expect(finishOpaqueCredentialClientLogin({
            secret: 'wrong-device-secret-0000000000000',
            subjectId: 'device-1',
            serverId: 'gateway-1',
            clientLoginState: wrongStart.clientLoginState,
            loginResponse: wrongServerStart.loginResponse,
            expectedServerStaticPublicKey: registrationResponse.serverStaticPublicKey,
        })).rejects.toThrow('Credential authentication failed')

        const correctStart = await startOpaqueCredentialLogin(correctSecret)
        const correctServerStart = await authenticator.begin({
            mode: 'credential',
            credentialId: 'device-1',
            subjectId: 'device-1',
            startLoginRequest: correctStart.startLoginRequest,
        })
        const correctFinish = await finishOpaqueCredentialClientLogin({
            secret: correctSecret,
            subjectId: 'device-1',
            serverId: 'gateway-1',
            clientLoginState: correctStart.clientLoginState,
            loginResponse: correctServerStart.loginResponse,
            expectedServerStaticPublicKey: registrationResponse.serverStaticPublicKey,
        })
        await expect(authenticator.finish({
            handshakeId: correctServerStart.handshakeId,
            finishLoginRequest: correctFinish.finishLoginRequest,
        })).resolves.toEqual({
            credentialId: 'device-1',
            sessionKey: correctFinish.sessionKey,
            credentialProvisioningRequired: false,
        })

        expect(await authenticator.revoke('device-1')).toBe(true)
        const retry = await startOpaqueCredentialLogin(correctSecret)
        await expect(authenticator.begin({
            mode: 'credential',
            credentialId: 'device-1',
            subjectId: 'device-1',
            startLoginRequest: retry.startLoginRequest,
        })).rejects.toThrow('Device credential is unknown or disabled')
    }, 15_000)
})

async function fixture(now?: () => number): Promise<{
    repository: DeviceCredentialRepository
    authenticator: DeviceAuthenticator
}> {
    const directory = await mkdtemp(join(tmpdir(), 'codever-device-authenticator-'))
    const repository = await DeviceCredentialRepository.open(join(directory, 'credentials.json'), { now })
    const authenticator = await DeviceAuthenticator.create({
        gatewayId: 'gateway-1',
        serverSetup: repository.serverSetup,
        credentials: repository,
        now,
    })
    return { repository, authenticator }
}
