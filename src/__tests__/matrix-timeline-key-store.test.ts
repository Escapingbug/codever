import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    FileTimelineKeyStore,
    MAX_MATRIX_TIMELINE_KEY_EPOCHS,
} from '@/gateway/matrix/fileTimelineKeyStore'

describe('FileTimelineKeyStore', () => {
    it('adds devices without rotating and rotates when a device is removed', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-timeline-keys-'))
        const path = join(directory, 'keys.json')
        const store = new FileTimelineKeyStore(path)
        await store.initialize()

        const first = await store.ensureRoom('!room:example.org', ['phone'], 10)
        const added = await store.ensureRoom('!room:example.org', ['phone', 'web'], 20)
        expect(added.activeEpochId).toBe(first.activeEpochId)
        expect(added.epochs).toHaveLength(1)

        const rotated = await store.ensureRoom('!room:example.org', ['web'], 30)
        expect(rotated.activeEpochId).not.toBe(first.activeEpochId)
        expect(rotated.epochs).toHaveLength(2)
        expect(rotated.epochs[0]?.key).toEqual(first.epochs[0]?.key)

        const persisted = JSON.parse(await readFile(path, 'utf8')) as {
            rooms: Record<string, { epochs: Array<{ key: string }> }>
        }
        expect(persisted.rooms['!room:example.org']?.epochs).toHaveLength(2)
        expect(persisted.rooms['!room:example.org']?.epochs[0]?.key).not.toContain('[')
    })

    it('restores a stable active key ring after restart', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-timeline-keys-'))
        const path = join(directory, 'keys.json')
        const firstStore = new FileTimelineKeyStore(path)
        await firstStore.initialize()
        const first = await firstStore.ensureRoom('!room:example.org', ['phone'], 10)

        const restoredStore = new FileTimelineKeyStore(path)
        await restoredStore.initialize()
        const restored = await restoredStore.ensureRoom('!room:example.org', ['phone'], 20)
        expect(restored.activeEpochId).toBe(first.activeEpochId)
        expect(restored.epochs[0]?.key).toEqual(first.epochs[0]?.key)
    })

    it('fails explicitly instead of silently dropping history keys', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-timeline-keys-'))
        const store = new FileTimelineKeyStore(join(directory, 'keys.json'))
        await store.initialize()
        await store.ensureRoom('!room:example.org', ['phone', 'web'], 1)

        for (let index = 1; index < MAX_MATRIX_TIMELINE_KEY_EPOCHS; index += 1) {
            await store.ensureRoom('!room:example.org', ['phone'], index * 2)
            await store.ensureRoom('!room:example.org', ['phone', 'web'], index * 2 + 1)
        }

        await expect(
            store.ensureRoom('!room:example.org', ['phone'], 10_000),
        ).rejects.toThrow(`exceeded ${MAX_MATRIX_TIMELINE_KEY_EPOCHS} retained epochs`)
    })
})
