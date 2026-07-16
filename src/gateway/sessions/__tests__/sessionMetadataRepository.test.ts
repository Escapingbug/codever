import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { CodeverSession } from '@codever/protocol'
import {
    FileSessionMetadataRepository,
    MemorySessionMetadataRepository,
} from '../sessionMetadataRepository'

const temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('session metadata repositories', () => {
    it('serializes memory mutations and returns defensive copies', async () => {
        const repository = new MemorySessionMetadataRepository()
        const session = createSession('session-1')
        await repository.save(session)

        const loaded = await repository.get(session.id)
        loaded!.config.changed = true

        expect((await repository.get(session.id))?.config).toEqual({ reasoning: 'high' })
        expect(await repository.list('project-1')).toHaveLength(1)
        expect(await repository.delete(session.id)).toBe(true)
        expect(await repository.delete(session.id)).toBe(false)
    })

    it('atomically persists metadata and restores it in a new repository', async () => {
        const directory = await makeTemporaryDirectory()
        const filePath = join(directory, 'sessions.json')
        const repository = await FileSessionMetadataRepository.open(filePath)
        await Promise.all([
            repository.save(createSession('session-1')),
            repository.save(createSession('session-2')),
        ])
        await repository.close()

        const persisted = JSON.parse(await readFile(filePath, 'utf8')) as { schemaVersion: number; sessions: unknown[] }
        expect(persisted).toMatchObject({ schemaVersion: 1 })
        expect(persisted.sessions).toHaveLength(2)

        const restored = await FileSessionMetadataRepository.open(filePath)
        expect((await restored.list()).map((session) => session.id)).toEqual(['session-1', 'session-2'])
        await restored.close()
    })
})

function createSession(id: string): CodeverSession {
    return {
        id,
        gatewayId: 'gateway-1',
        projectId: 'project-1',
        state: 'idle',
        provider: 'mock',
        config: { reasoning: 'high' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastEventSeq: 0,
    }
}

async function makeTemporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'codever-session-repository-'))
    temporaryDirectories.push(path)
    return path
}

