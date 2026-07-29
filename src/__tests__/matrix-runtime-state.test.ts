import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
    FileCommandReplayStore,
    FileGatewayRuntimeStateStore,
} from '@/gateway/matrix'

const temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(directory =>
            rm(directory, { recursive: true, force: true }),
        ),
    )
})

describe('FileGatewayRuntimeStateStore', () => {
    it('preserves the runtime epoch and never regresses a concurrent state version', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-runtime-state-'))
        temporaryDirectories.push(directory)
        const path = join(directory, 'runtime-state.json')
        const room = {
            roomId: '!room:example.org',
            conversationId: 'conversation-1',
            cwd: 'C:\\repo',
            providerName: 'mock-provider',
        }
        const store = new FileGatewayRuntimeStateStore(path)
        await store.initialize([room], 'ledger-generation-1')
        const initial = store.getRoom(room.roomId)

        await Promise.all([
            store.incrementStateVersion(room.roomId, {
                revisionEpoch: initial.revisionEpoch,
                replayGeneration: initial.replayGeneration,
                currentSessionId: null,
                appSessions: [],
                workspace: initial.workspace,
            }),
            store.saveRoom(room.roomId, {
                ...initial,
                appSessions: [{
                    id: 'app-session-1',
                    title: 'Persisted session',
                    updatedAt: 1,
                    provider: 'mock-provider',
                    model: null,
                    providerSessionId: 'provider-session-1',
                }],
                currentSessionId: 'app-session-1',
            }),
        ])

        const restarted = new FileGatewayRuntimeStateStore(path)
        await restarted.initialize([room], 'ledger-generation-1')
        expect(restarted.getRoom(room.roomId)).toMatchObject({
            revisionEpoch: initial.revisionEpoch,
            replayGeneration: 'ledger-generation-1',
            stateVersion: 1,
            currentSessionId: 'app-session-1',
            appSessions: [{
                id: 'app-session-1',
                providerSessionId: 'provider-session-1',
            }],
        })
    })

    it('rotates the revision epoch when the replay ledger is missing or rebuilt empty', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-runtime-generation-'))
        temporaryDirectories.push(directory)
        const ledgerPath = join(directory, 'replay.jsonl')
        const runtimePath = `${ledgerPath}.runtime-state.json`
        const room = {
            roomId: '!room:example.org',
            conversationId: 'conversation-1',
            cwd: 'C:\\repo',
            providerName: 'mock-provider',
        }
        const firstLedger = new FileCommandReplayStore(ledgerPath)
        await firstLedger.initialize()
        const firstGeneration = firstLedger.getGeneration()
        const firstRuntime = new FileGatewayRuntimeStateStore(runtimePath)
        await firstRuntime.initialize([room], firstGeneration)
        const firstState = firstRuntime.getRoom(room.roomId)
        await firstRuntime.saveRoom(room.roomId, {
            ...firstState,
            currentSessionId: 'app-session-1',
            appSessions: [{
                id: 'app-session-1',
                title: 'Survives ledger recovery',
                updatedAt: 1,
                provider: 'mock-provider',
                model: null,
                providerSessionId: 'provider-session-1',
            }],
        })

        await rm(ledgerPath)
        const missingLedger = new FileCommandReplayStore(ledgerPath)
        await missingLedger.initialize()
        const secondGeneration = missingLedger.getGeneration()
        expect(secondGeneration).not.toBe(firstGeneration)
        const afterMissing = new FileGatewayRuntimeStateStore(runtimePath)
        await afterMissing.initialize([room], secondGeneration)
        const secondState = afterMissing.getRoom(room.roomId)
        expect(secondState).toMatchObject({
            replayGeneration: secondGeneration,
            currentSessionId: 'app-session-1',
        })
        expect(secondState.revisionEpoch).not.toBe(firstState.revisionEpoch)

        await writeFile(ledgerPath, '', 'utf8')
        const emptyLedger = new FileCommandReplayStore(ledgerPath)
        await emptyLedger.initialize()
        const thirdGeneration = emptyLedger.getGeneration()
        expect(thirdGeneration).not.toBe(secondGeneration)
        const afterEmpty = new FileGatewayRuntimeStateStore(runtimePath)
        await afterEmpty.initialize([room], thirdGeneration)
        expect(afterEmpty.getRoom(room.roomId).revisionEpoch)
            .not.toBe(secondState.revisionEpoch)
    })

    it('recovers a fully written final replay record even if the trailing newline is lost', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-replay-crash-'))
        temporaryDirectories.push(directory)
        const ledgerPath = join(directory, 'replay.jsonl')
        const first = new FileCommandReplayStore(ledgerPath)
        await first.initialize()
        const claim = { key: 'durable-crash-claim', expiresAt: Date.now() + 60_000 }
        await expect(first.claimAll([claim], Date.now())).resolves.toBe(true)

        const durableText = await readFile(ledgerPath, 'utf8')
        await writeFile(ledgerPath, durableText.trimEnd(), 'utf8')
        const recovered = new FileCommandReplayStore(ledgerPath)
        await recovered.initialize()
        expect(recovered.getGeneration()).toBe(first.getGeneration())
        await expect(recovered.claimAll([claim], Date.now())).resolves.toBe(false)
    })
})
