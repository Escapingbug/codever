import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CodeverSession, Gateway, Project, SessionEventEnvelope } from '@codever/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createDurableRelayRepositories } from '../src/durableRepositories'
import type { CommandRecord } from '../src/repositories'

const temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('durable Relay repositories', () => {
    it('restores metadata, commands, events, and idempotency indexes after restart', async () => {
        const directory = await temporaryDirectory()
        const first = await createDurableRelayRepositories(directory)
        await first.gateways.upsert(gateway())
        await first.projects.replaceForGateway('gateway-1', [project()])
        await first.sessions.replaceForGateway('gateway-1', [session()])
        const created = await first.commands.create(command())
        await first.commands.markAccepted(created.request.commandId, '2026-07-16T10:00:01.000Z')
        await first.commands.markResult({
            commandId: created.request.commandId,
            completedAt: '2026-07-16T10:00:02.000Z',
            result: { sessionId: 'session-1' },
        })
        await expect(first.events.append([event()])).resolves.toMatchObject({ inserted: 1 })
        await expect(first.events.append([event()])).resolves.toMatchObject({ inserted: 0 })

        const restored = await createDurableRelayRepositories(directory)
        await expect(restored.gateways.list('workspace-1')).resolves.toEqual([{
            ...gateway(), status: 'offline', connectionEpoch: undefined,
        }])
        await expect(restored.projects.listByGateway('gateway-1')).resolves.toEqual([project()])
        await expect(restored.sessions.listByProject('project-1')).resolves.toEqual([session()])
        await expect(restored.events.listAfter('session-1', 0)).resolves.toEqual([event()])
        await expect(restored.events.highestSeq('session-1')).resolves.toBe(1)
        await expect(restored.commands.getByIdempotencyKey('gateway-1', 'idem-1')).resolves.toMatchObject({
            status: 'completed',
            result: { commandId: 'command-1' },
        })
        await expect(restored.commands.create({ ...command(), request: { ...command().request, commandId: 'command-2' } }))
            .resolves.toMatchObject({ request: { commandId: 'command-1' }, status: 'completed' })
    })

    it('rejects event id and session sequence conflicts without appending them', async () => {
        const directory = await temporaryDirectory()
        const repositories = await createDurableRelayRepositories(directory)
        await repositories.events.append([event()])

        await expect(repositories.events.append([{ ...event(), event: { kind: 'status', level: 'error', message: 'different' } }]))
            .rejects.toThrow('Conflicting event')
        await expect(repositories.events.append([{ ...event(), eventId: 'event-2' }]))
            .rejects.toThrow('Conflicting event')
        const restored = await createDurableRelayRepositories(directory)
        await expect(restored.events.listAfter('session-1', 0)).resolves.toEqual([event()])
    })

    it('truncates only a torn final event-log record and restores complete records', async () => {
        const directory = await temporaryDirectory()
        const repositories = await createDurableRelayRepositories(directory)
        await repositories.events.append([event()])
        const path = join(directory, 'session-events.jsonl')
        await appendFile(path, '{"formatVersion":1,"checksum":"torn"')

        const restored = await createDurableRelayRepositories(directory)
        await expect(restored.events.listAfter('session-1', 0)).resolves.toEqual([event()])
        expect((await readFile(path, 'utf8')).endsWith('\n')).toBe(true)
    })

    it('detects checksummed event corruption and invalid metadata on startup', async () => {
        const eventDirectory = await temporaryDirectory()
        const repositories = await createDurableRelayRepositories(eventDirectory)
        await repositories.events.append([event()])
        const eventPath = join(eventDirectory, 'session-events.jsonl')
        const record = JSON.parse(await readFile(eventPath, 'utf8')) as { event: SessionEventEnvelope }
        record.event.eventId = 'tampered'
        await writeFile(eventPath, `${JSON.stringify(record)}\n`)
        await expect(createDurableRelayRepositories(eventDirectory)).rejects.toThrow('Corrupt Relay event log')

        const metadataDirectory = await temporaryDirectory()
        await writeFile(join(metadataDirectory, 'metadata.json'), '{not json}\n')
        await expect(createDurableRelayRepositories(metadataDirectory)).rejects.toThrow('invalid JSON')

        const commandDirectory = await temporaryDirectory()
        await writeFile(join(commandDirectory, 'commands.json'), JSON.stringify({
            formatVersion: 1,
            commands: [command(), { ...command(), idempotencyKey: 'idem-2' }],
        }))
        await expect(createDurableRelayRepositories(commandDirectory)).rejects.toThrow('duplicate command id')
    })

    it('refuses to persist private key fields or PEM material', async () => {
        const directory = await temporaryDirectory()
        const repositories = await createDurableRelayRepositories(directory)
        await expect(repositories.sessions.replaceForGateway('gateway-1', [{
            ...session(),
            config: { privateKeyPem: 'secret' },
        }])).rejects.toThrow('must not persist private key field')

        await expect(repositories.events.append([{ ...event(), event: {
            kind: 'status',
            level: 'error',
            message: '-----BEGIN PRIVATE KEY-----',
        } }])).rejects.toThrow('must not persist private key material')
    })
})

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'codever-relay-durable-'))
    temporaryDirectories.push(directory)
    return directory
}

function gateway(): Gateway {
    return {
        id: 'gateway-1',
        workspaceId: 'workspace-1',
        name: 'Gateway One',
        platform: 'linux',
        version: '0.1.0',
        capabilities: { protocolVersions: [1], providers: ['mock'], features: [] },
        status: 'online',
        connectionEpoch: 'epoch-1',
        lastSeenAt: '2026-07-16T10:00:00.000Z',
    }
}

function project(): Project {
    return {
        id: 'project-1',
        gatewayId: 'gateway-1',
        name: 'Project One',
        rootPath: '/workspace/project',
        canonicalRoot: '/workspace/project',
    }
}

function session(): CodeverSession {
    return {
        id: 'session-1',
        gatewayId: 'gateway-1',
        projectId: 'project-1',
        state: 'idle',
        provider: 'mock',
        config: {},
        createdAt: '2026-07-16T10:00:00.000Z',
        updatedAt: '2026-07-16T10:00:00.000Z',
        lastEventSeq: 1,
    }
}

function command(): CommandRecord {
    return {
        gatewayId: 'gateway-1',
        connectionEpoch: 'epoch-1',
        idempotencyKey: 'idem-1',
        request: {
            commandId: 'command-1',
            projectId: 'project-1',
            sessionId: 'session-1',
            command: { kind: 'session.message', text: 'hello' },
            requestedAt: '2026-07-16T10:00:00.000Z',
        },
        status: 'relay_accepted',
        relayAcceptedAt: '2026-07-16T10:00:00.000Z',
    }
}

function event(): SessionEventEnvelope {
    return {
        schemaVersion: 1,
        gatewayId: 'gateway-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        seq: 1,
        eventId: 'event-1',
        timestamp: '2026-07-16T10:00:00.000Z',
        event: { kind: 'status', level: 'info', message: 'ready' },
    }
}
