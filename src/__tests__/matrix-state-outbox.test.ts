import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { FileMatrixStateOutbox } from '@/gateway/matrix'

const temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory =>
        rm(directory, { recursive: true, force: true }),
    ))
})

describe('FileMatrixStateOutbox', () => {
    it('recovers the last complete fsynced record after a torn append', async () => {
        const { path, outbox } = await fixture()
        const delivery = outbox.createDelivery(input(1))
        await outbox.stage(delivery)
        await appendFile(path, '{"version":1,"kind":"pending"', 'utf8')

        const restarted = new FileMatrixStateOutbox(path)
        await restarted.initialize()

        expect(restarted.pendingForRoom('!room:example.org')).toEqual([delivery])
        expect((await readFile(path, 'utf8')).endsWith('\n')).toBe(true)
    })

    it('keeps only the latest pending replacement for one state entity', async () => {
        const { path, outbox } = await fixture()
        const first = outbox.createDelivery(input(1))
        const latest = outbox.createDelivery(input(2))
        await outbox.stage(first)
        await outbox.stage(latest)
        await outbox.supersedeOlder(latest)

        const restarted = new FileMatrixStateOutbox(path)
        await restarted.initialize()

        expect(restarted.pendingForRoom('!room:example.org')).toEqual([latest])
        expect(restarted.latestForEntity(first)).toEqual(latest)
    })

    it('atomically compacts delivered history to one latest value per state key', async () => {
        const { path, outbox } = await fixture()
        const first = outbox.createDelivery(input(1))
        const latest = outbox.createDelivery(input(2))
        await outbox.stage(first)
        await outbox.markDelivered(first.deliveryId, '$first')
        await outbox.stage(latest)
        await outbox.markDelivered(latest.deliveryId, '$latest')
        await outbox.compact()

        const restarted = new FileMatrixStateOutbox(path)
        await restarted.initialize()

        expect(restarted.pendingForRoom('!room:example.org')).toEqual([])
        expect(restarted.latestForRoom('!room:example.org')).toEqual([latest])
        expect((await readFile(path, 'utf8')).split('\n').filter(Boolean)).toHaveLength(2)
    })

    it('preserves the latest pending value across compaction and restart', async () => {
        const { path, outbox } = await fixture()
        const delivered = outbox.createDelivery(input(1))
        const pending = outbox.createDelivery(input(2))
        await outbox.stage(delivered)
        await outbox.markDelivered(delivered.deliveryId, '$delivered')
        await outbox.stage(pending)
        await outbox.compact()

        const restarted = new FileMatrixStateOutbox(path)
        await restarted.initialize()
        expect(restarted.pendingForRoom('!room:example.org')).toEqual([pending])
        expect(restarted.latestForEntity(delivered)).toEqual(pending)
    })

    it('tracks a new entity independently from an unrelated pending gap', async () => {
        const { outbox } = await fixture()
        const oldGap = outbox.createDelivery(input(1))
        const currentSession = outbox.createDelivery({
            ...input(2),
            stateKey: 'session-2',
            content: {
                ...input(2).content,
                session_id: 'session-2',
            },
        })
        await outbox.stage(oldGap)
        await outbox.stage(currentSession)

        expect(outbox.latestForEntity(currentSession)).toEqual(currentSession)
        expect(outbox.isPending(currentSession.deliveryId)).toBe(true)
        expect(outbox.latestPendingForRoom('!room:example.org')).toEqual([
            oldGap,
            currentSession,
        ])
    })

    it('loads a delivered Gateway state written before command cursors existed', async () => {
        const { path, outbox } = await fixture()
        const delivery = outbox.createDelivery(gatewayInput(1))
        await outbox.stage(delivery)
        await outbox.markDelivered(delivery.deliveryId, '$legacy-gateway-state')
        await removeGatewayCommandSequences(path)

        const restarted = new FileMatrixStateOutbox(path)
        await restarted.initialize()

        expect(restarted.pendingForRoom('!room:example.org')).toEqual([])
        expect(restarted.latestForRoom('!room:example.org')).toEqual([
            {
                ...delivery,
                content: {
                    ...delivery.content,
                    command_sequences: [],
                },
            },
        ])
    })

    it('retires an undelivered legacy Gateway state instead of retrying it', async () => {
        const { path, outbox } = await fixture()
        const legacy = outbox.createDelivery(gatewayInput(1))
        await outbox.stage(legacy)
        await removeGatewayCommandSequences(path)

        const restarted = new FileMatrixStateOutbox(path)
        await restarted.initialize()

        expect(restarted.pendingForRoom('!room:example.org')).toEqual([])
        expect((await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line =>
            JSON.parse(line) as { kind: string; deliveryId: string }
        )).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'superseded',
                deliveryId: legacy.deliveryId,
            }),
        ]))

        const secondRestart = new FileMatrixStateOutbox(path)
        await secondRestart.initialize()
        expect(secondRestart.pendingForRoom('!room:example.org')).toEqual([])
    })
})

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'codever-state-outbox-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'state.jsonl')
    const outbox = new FileMatrixStateOutbox(path)
    await outbox.initialize()
    return { path, outbox }
}

function input(stateVersion: number) {
    return {
        roomId: '!room:example.org',
        eventType: 'io.codever.session.current.v2',
        stateKey: 'session-1',
        stateVersion,
        content: {
            version: 2 as const,
            kind: 'session_state' as const,
            gateway_id: 'gateway-1',
            conversation_id: 'conversation-1',
            revision: stateVersion,
            revision_epoch: 'epoch-1',
            revision_epoch_generation: 1,
            state_version: stateVersion,
            session_id: 'session-1',
            state: 'deleted' as const,
            updated_at: stateVersion,
        },
        createdAt: stateVersion,
    }
}

function gatewayInput(stateVersion: number) {
    return {
        roomId: '!room:example.org',
        eventType: 'io.codever.gateway.current.v2',
        stateKey: 'gateway-1',
        stateVersion,
        content: {
            version: 2 as const,
            kind: 'gateway_state' as const,
            gateway_id: 'gateway-1',
            conversation_id: 'conversation-1',
            revision: stateVersion,
            revision_epoch: 'epoch-1',
            revision_epoch_generation: 1,
            state_version: stateVersion,
            active_device_count: 1,
            command_sequences: [{
                device_id: 'device-1',
                sequence_epoch: 'certificate-1',
                sequence: 3,
            }],
            workspace: {
                project: {
                    id: 'project-1',
                    name: 'Project 1',
                    cwd: '/work/project-1',
                },
                provider: 'codex',
                permission_mode: 'default',
            },
            capabilities: {
                models: [],
                permission_modes: [],
                can_create_session: true,
                can_select_session: false,
                can_archive_session: true,
                can_delete_session: true,
                session_extensions: [],
            },
            updated_at: stateVersion,
        },
        createdAt: stateVersion,
    }
}

async function removeGatewayCommandSequences(path: string): Promise<void> {
    const records = (await readFile(path, 'utf8')).split(/\r?\n/u).filter(Boolean)
        .map(line => JSON.parse(line) as Record<string, unknown>)
    for (const record of records) {
        const content = record.content
        if (content && typeof content === 'object' && !Array.isArray(content)) {
            delete (content as Record<string, unknown>).command_sequences
        }
    }
    await writeFile(path, `${records.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8')
}
