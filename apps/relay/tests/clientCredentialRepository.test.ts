import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClientCredentialRepository } from '../src/clientCredentialRepository'

describe('ClientCredentialRepository', () => {
    it('persists an independent OPAQUE setup and revocable Client credentials', async () => {
        const path = join(await mkdtemp(join(tmpdir(), 'codever-client-credentials-')), 'clients.json')
        const first = await ClientCredentialRepository.open(path)
        await first.put('client-1', 'opaque-registration-record')
        const setup = first.serverSetup

        const reopened = await ClientCredentialRepository.open(path)
        expect(reopened.serverSetup).toBe(setup)
        expect(await reopened.get('client-1')).toEqual({
            clientId: 'client-1', registrationRecord: 'opaque-registration-record', enabled: true,
        })
        expect(await reopened.revoke('client-1')).toBe(true)
        expect((await reopened.get('client-1'))?.enabled).toBe(false)
    })
})
