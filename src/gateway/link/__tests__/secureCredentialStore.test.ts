import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { GatewaySecureCredentialStore } from '../secureCredentialStore'

describe('GatewaySecureCredentialStore', () => {
    it('runs the post-save cleanup only after the credential is durable', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-secure-credential-'))
        const path = join(directory, 'credential.json')
        const afterSave = vi.fn(async () => {
            expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ gatewayId: 'gateway-1' })
        })
        const store = new GatewaySecureCredentialStore(path, afterSave)

        await store.save({
            version: 1,
            gatewayId: 'gateway-1',
            relayId: 'relay-1',
            relayStaticPublicKey: 'relay-public-key',
            secret: 'a'.repeat(43),
            createdAt: new Date(0).toISOString(),
        })

        expect(afterSave).toHaveBeenCalledOnce()
        await expect(store.load('gateway-1')).resolves.toMatchObject({ relayId: 'relay-1' })
    })
})
