import {
    finishOpaquePairingClient,
    generateHpkeKeyPair,
    startOpaquePairingClient,
} from '@codever/secure-channel'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DeviceAuthenticator } from '../deviceAuthenticator'
import { DeviceCredentialRepository } from '../deviceCredentialRepository'

describe('DeviceAuthenticator', () => {
    it('uses OPAQUE only for one-time pairing and consumes the pairing handshake once', async () => {
        const now = Date.parse('2026-07-17T08:00:00.000Z')
        const { authenticator } = await fixture(() => now)
        const ticket = authenticator.issuePairing()
        expect(ticket.attemptsRemaining).toBe(5)
        expect(Date.parse(ticket.expiresAt) - now).toBe(3 * 60_000)

        const clientStart = await startOpaquePairingClient(ticket.code)
        const serverStart = authenticator.begin({
            credentialId: 'device-1',
            pairingId: clientStart.pairingId,
            startLoginRequest: clientStart.startLoginRequest,
        })
        expect(Date.parse(serverStart.expiresAt) - now).toBe(30_000)

        const clientFinish = finishOpaquePairingClient({
            domain: 'gateway-device',
            code: ticket.code,
            serverId: 'gateway-1',
            clientLoginState: clientStart.clientLoginState,
            loginResponse: serverStart.loginResponse,
        })
        expect(authenticator.finish({
            handshakeId: serverStart.handshakeId,
            finishLoginRequest: clientFinish.finishLoginRequest,
        })).toEqual({
            credentialId: 'device-1',
            sessionKey: clientFinish.sessionKey,
        })
        expect(() => authenticator.finish({
            handshakeId: serverStart.handshakeId,
            finishLoginRequest: clientFinish.finishLoginRequest,
        })).toThrow('Gateway device pairing handshake is invalid or expired')
    }, 15_000)

    it('registers and authorizes an HPKE public key, then rejects it after revocation', async () => {
        const { authenticator } = await fixture()
        const deviceKeyPair = await generateHpkeKeyPair()

        await expect(authenticator.register(
            'device-1',
            deviceKeyPair.keyId,
            deviceKeyPair.publicKey,
            'Alice phone',
        )).resolves.toMatchObject({
            credentialId: 'device-1',
            hpkeKeyId: deviceKeyPair.keyId,
            hpkePublicKey: deviceKeyPair.publicKey,
            enabled: true,
            label: 'Alice phone',
        })
        await expect(authenticator.authorize('device-1')).resolves.toMatchObject({
            hpkeKeyId: deviceKeyPair.keyId,
            hpkePublicKey: deviceKeyPair.publicKey,
            enabled: true,
        })

        expect(await authenticator.revoke('device-1')).toBe(true)
        expect(await authenticator.revoke('device-1')).toBe(false)
        await expect(authenticator.authorize('device-1')).rejects.toThrow('Device credential is unknown or revoked')
    })

    it('rejects an HPKE public key whose key ID does not match', async () => {
        const { authenticator } = await fixture()
        const deviceKeyPair = await generateHpkeKeyPair()

        await expect(authenticator.register(
            'device-1',
            'x25519-wrong-key-id',
            deviceKeyPair.publicKey,
        )).rejects.toThrow('Device HPKE key ID mismatch')
        await expect(authenticator.authorize('device-1')).rejects.toThrow('Device credential is unknown or revoked')
    })
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
        hpkeKeyPair: repository.hpkeKeyPair,
        now,
    })
    return { repository, authenticator }
}
