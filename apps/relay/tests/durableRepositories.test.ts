import type { Gateway } from '@codever/protocol'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDurableRelayRepositories } from '../src/durableRepositories'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))))

describe('durable Relay repositories', () => {
    it('persists only Gateway control-plane metadata and restores it offline', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-relay-gateways-'))
        directories.push(directory)
        const first = await createDurableRelayRepositories(directory)
        await first.gateways.upsert(gateway())

        expect(await readdir(directory)).toEqual(['gateways.json'])
        const stored = await readFile(join(directory, 'gateways.json'), 'utf8')
        expect(stored).not.toMatch(/projects|sessions|events|commands/)

        const restored = await createDurableRelayRepositories(directory)
        await expect(restored.gateways.get('gateway-1')).resolves.toMatchObject({
            id: 'gateway-1',
            status: 'offline',
        })
        expect((await restored.gateways.get('gateway-1'))).not.toHaveProperty('connectionEpoch')
    })
})

function gateway(): Gateway {
    return {
        id: 'gateway-1',
        workspaceId: 'workspace-1',
        name: 'Gateway 1',
        platform: 'linux',
        version: '1',
        capabilities: { protocolVersions: [1], providers: [], features: [] },
        status: 'online',
        connectionEpoch: 'epoch-1',
        lastSeenAt: '2026-07-17T00:00:00.000Z',
    }
}
