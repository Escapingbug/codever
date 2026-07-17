import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DeviceCredentialRepository } from '../deviceCredentialRepository'

describe('DeviceCredentialRepository', () => {
    it('persists the Gateway setup and complete revocable device records', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-device-credentials-'))
        const path = join(directory, 'credentials.json')
        let now = Date.parse('2026-07-17T08:00:00.000Z')
        const first = await DeviceCredentialRepository.open(path, { now: () => now })
        const serverSetup = first.serverSetup
        await first.put('device-1', 'opaque-registration-record', 'Alice phone')

        now += 60_000
        expect(await first.revoke('device-1')).toBe(true)
        expect(await first.revoke('device-1')).toBe(false)

        const reopened = await DeviceCredentialRepository.open(path)
        expect(reopened.serverSetup).toBe(serverSetup)
        expect(await reopened.get('device-1')).toEqual({
            credentialId: 'device-1',
            registrationRecord: 'opaque-registration-record',
            enabled: false,
            label: 'Alice phone',
            createdAt: '2026-07-17T08:00:00.000Z',
            revokedAt: '2026-07-17T08:01:00.000Z',
        })

        const snapshot = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
        expect(snapshot).toMatchObject({
            formatVersion: 1,
            serverSetup,
            credentials: [{
                credentialId: 'device-1',
                registrationRecord: 'opaque-registration-record',
                enabled: false,
                label: 'Alice phone',
                createdAt: '2026-07-17T08:00:00.000Z',
                revokedAt: '2026-07-17T08:01:00.000Z',
            }],
        })
    })
})
