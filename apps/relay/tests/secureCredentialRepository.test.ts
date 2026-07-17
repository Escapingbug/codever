import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SecureCredentialRepository } from '../src/secureCredentialRepository'

describe('SecureCredentialRepository', () => {
    it('persists the OPAQUE server setup and revocable Gateway records', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-secure-credentials-'))
        const path = join(directory, 'credentials.json')
        const first = await SecureCredentialRepository.open(path)
        await first.put('gateway-1', 'opaque-registration-record')
        const setup = first.serverSetup

        const reopened = await SecureCredentialRepository.open(path)
        expect(reopened.serverSetup).toBe(setup)
        expect(await reopened.get('gateway-1')).toEqual({
            gatewayId: 'gateway-1', registrationRecord: 'opaque-registration-record', enabled: true,
        })
        expect(await reopened.revoke('gateway-1')).toBe(true)
        expect((await reopened.get('gateway-1'))?.enabled).toBe(false)
        expect(await readFile(path, 'utf8')).not.toContain('PRIVATE KEY')
    })
})
