import { generateHpkeKeyPair } from '@codever/secure-channel'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DeviceCredentialRepository } from '../deviceCredentialRepository'

describe('DeviceCredentialRepository', () => {
    it('persists the format v2 Gateway HPKE keypair and revocable device public keys', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-device-credentials-'))
        const path = join(directory, 'credentials.json')
        let now = Date.parse('2026-07-17T08:00:00.000Z')
        const first = await DeviceCredentialRepository.open(path, { now: () => now })
        const serverSetup = first.serverSetup
        const gatewayKeyPair = first.hpkeKeyPair
        const deviceKeyPair = await generateHpkeKeyPair()

        await expect(first.put(
            'device-1',
            deviceKeyPair.keyId,
            deviceKeyPair.publicKey,
            'Alice phone',
        )).resolves.toEqual({
            credentialId: 'device-1',
            hpkePublicKey: deviceKeyPair.publicKey,
            hpkeKeyId: deviceKeyPair.keyId,
            enabled: true,
            label: 'Alice phone',
            createdAt: '2026-07-17T08:00:00.000Z',
        })

        now += 60_000
        expect(await first.revoke('device-1')).toBe(true)
        expect(await first.revoke('device-1')).toBe(false)

        const reopened = await DeviceCredentialRepository.open(path)
        expect(reopened.serverSetup).toBe(serverSetup)
        expect(reopened.hpkeKeyPair).toEqual(gatewayKeyPair)
        expect(await reopened.get('device-1')).toEqual({
            credentialId: 'device-1',
            hpkePublicKey: deviceKeyPair.publicKey,
            hpkeKeyId: deviceKeyPair.keyId,
            enabled: false,
            label: 'Alice phone',
            createdAt: '2026-07-17T08:00:00.000Z',
            revokedAt: '2026-07-17T08:01:00.000Z',
        })

        const snapshot = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
        expect(snapshot).toEqual({
            formatVersion: 2,
            serverSetup,
            hpkeKeyPair: gatewayKeyPair,
            credentials: [{
                credentialId: 'device-1',
                hpkePublicKey: deviceKeyPair.publicKey,
                hpkeKeyId: deviceKeyPair.keyId,
                enabled: false,
                label: 'Alice phone',
                createdAt: '2026-07-17T08:00:00.000Z',
                revokedAt: '2026-07-17T08:01:00.000Z',
            }],
        })
    })

    it('never overwrites an existing credential ID', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-device-credentials-'))
        const repository = await DeviceCredentialRepository.open(join(directory, 'credentials.json'))
        const firstKeyPair = await generateHpkeKeyPair()
        const replacementKeyPair = await generateHpkeKeyPair()

        await repository.put('device-1', firstKeyPair.keyId, firstKeyPair.publicKey, 'Alice phone')
        await expect(repository.put(
            'device-1',
            replacementKeyPair.keyId,
            replacementKeyPair.publicKey,
            'Replacement phone',
        )).rejects.toThrow('Gateway device credential ID is already registered')

        expect(await repository.get('device-1')).toMatchObject({
            hpkeKeyId: firstKeyPair.keyId,
            hpkePublicKey: firstKeyPair.publicKey,
            label: 'Alice phone',
        })
    })
})
