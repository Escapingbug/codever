import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { CodeverCommand } from '@codever/protocol'
import {
    FileCommandReplayStore,
    FileGatewayRuntimeStateStore,
    gatewayProjectIdentity,
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
    it('allows duplicate project names while keeping cwd-scoped identities distinct', () => {
        const first = gatewayProjectIdentity('/work/client/app', 'Client')
        const second = gatewayProjectIdentity('/archive/client/app', 'Client')

        expect(first.name).toBe(second.name)
        expect(first.id).not.toBe(second.id)
    })

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
        expect(initial.revisionEpochGeneration).toBe(1)

        await Promise.all([
            store.incrementStateVersion(room.roomId, {
                revisionEpoch: initial.revisionEpoch,
                revisionEpochGeneration: initial.revisionEpochGeneration,
                replayGeneration: initial.replayGeneration,
                currentSessionId: null,
                appSessions: [],
                deletedSessionIds: [],
                workspace: initial.workspace,
            }),
            store.saveRoom(room.roomId, {
                ...initial,
                appSessions: [{
                    id: 'app-session-1',
                    title: 'Persisted session',
                    createdAt: 1,
                    updatedAt: 1,
                    matrixThreadRootEventId: '$root:example.org',
                    projectId: initial.workspace.projectId,
                    projectName: initial.workspace.projectName,
                    cwd: initial.workspace.cwd,
                    provider: 'mock-provider',
                    model: null,
                    reasoningEffort: null,
                    permissionMode: 'default',
                    providerSessionId: 'provider-session-1',
                    archivedAt: null,
                    extensions: [],
                }],
                currentSessionId: 'app-session-1',
            }),
        ])

        const restarted = new FileGatewayRuntimeStateStore(path)
        await restarted.initialize([room], 'ledger-generation-1')
        expect(restarted.getRoom(room.roomId)).toMatchObject({
            revisionEpoch: initial.revisionEpoch,
            revisionEpochGeneration: 1,
            replayGeneration: 'ledger-generation-1',
            stateVersion: 1,
            currentSessionId: 'app-session-1',
            appSessions: [{
                id: 'app-session-1',
                providerSessionId: 'provider-session-1',
                archivedAt: null,
                extensions: [],
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
        expect(firstState.revisionEpochGeneration).toBe(1)
        await firstRuntime.saveRoom(room.roomId, {
            ...firstState,
            currentSessionId: 'app-session-1',
            appSessions: [{
                id: 'app-session-1',
                title: 'Survives ledger recovery',
                createdAt: 1,
                updatedAt: 1,
                matrixThreadRootEventId: null,
                projectId: firstState.workspace.projectId,
                projectName: firstState.workspace.projectName,
                cwd: firstState.workspace.cwd,
                provider: 'mock-provider',
                model: null,
                reasoningEffort: null,
                permissionMode: 'default',
                providerSessionId: 'provider-session-1',
                archivedAt: null,
                extensions: [],
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
            revisionEpochGeneration: 2,
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
        const thirdState = afterEmpty.getRoom(room.roomId)
        expect(thirdState.revisionEpoch).not.toBe(secondState.revisionEpoch)
        expect(thirdState.revisionEpochGeneration).toBe(3)

        const stableRestart = new FileGatewayRuntimeStateStore(runtimePath)
        await stableRestart.initialize([room], thirdGeneration)
        expect(stableRestart.getRoom(room.roomId)).toMatchObject({
            revisionEpoch: thirdState.revisionEpoch,
            revisionEpochGeneration: 3,
        })
    })

    it('rejects the removed pre-release runtime-state schema', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-runtime-v1-'))
        temporaryDirectories.push(directory)
        const path = join(directory, 'runtime-state.json')
        const room = {
            roomId: '!room:example.org',
            conversationId: 'conversation-1',
            cwd: 'C:\\repo',
            providerName: 'mock-provider',
        }
        await writeFile(path, `${JSON.stringify({
            version: 1,
            rooms: {
                [room.roomId]: {
                    revisionEpoch: 'old-runtime-epoch',
                    replayGeneration: 'ledger-generation-1',
                    stateVersion: 7,
                    currentSessionId: 'legacy-session',
                    appSessions: [{
                        id: 'legacy-session',
                        title: 'Old session',
                        updatedAt: 1,
                        provider: 'mock-provider',
                        model: null,
                        providerSessionId: null,
                    }],
                    workspace: {
                        cwd: room.cwd,
                        provider: room.providerName,
                        model: null,
                        permissionMode: 'default',
                    },
                },
            },
        })}\n`, 'utf8')

        const store = new FileGatewayRuntimeStateStore(path)
        await expect(store.initialize([room], 'ledger-generation-1'))
            .rejects.toThrow('Invalid Gateway runtime state version')
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

    it('rejects the removed pre-release replay-ledger schema', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-replay-v1-'))
        temporaryDirectories.push(directory)
        const ledgerPath = join(directory, 'replay.jsonl')
        await writeFile(ledgerPath, `${JSON.stringify({
            version: 1,
            kind: 'generation',
            generation: 'old-generation',
        })}\n`, 'utf8')

        const store = new FileCommandReplayStore(ledgerPath)
        await expect(store.initialize()).rejects.toThrow(
            'Invalid command replay ledger entry at line 1',
        )
    })

})

describe('FileCommandReplayStore terminal results', () => {
    it('atomically persists an expired next command as a failed terminal result', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-expired-command-result-'))
        temporaryDirectories.push(directory)
        const path = join(directory, 'replay.jsonl')
        const command: CodeverCommand = {
            kind: 'codever.command',
            version: 1,
            commandId: 'expired-session-create',
            gatewayId: 'gateway-1',
            deviceId: 'device-1',
            sequenceEpoch: 'certificate-1',
            conversationId: 'conversation-1',
            revisionEpoch: 'runtime-epoch-1',
            sequence: 1,
            baseRevision: 0,
            operation: 'session.create',
            issuedAt: 1_000,
            expiresAt: 61_000,
            nonce: '0123456789abcdef-expired-command',
            payload: {
                operation: 'session.create',
                cwd: '/workspace/codever',
                projectName: 'Codever',
            },
        }
        const first = new FileCommandReplayStore(path)
        await first.initialize(121_000)
        await expect(
            first.claimCommandInOrder(command, 121_000),
        ).resolves.toMatchObject({
            status: 'accepted',
            revision: 1,
            terminal: {
                revision: 1,
                outcome: 'failed',
                error: expect.stringContaining('expired before the Gateway accepted it'),
            },
        })

        const restarted = new FileCommandReplayStore(path)
        await restarted.initialize(121_001)
        await expect(
            restarted.claimCommandInOrder(command, 121_001),
        ).resolves.toEqual({ status: 'duplicate', revision: 1 })
        await expect(
            restarted.getCommandResult(command),
        ).resolves.toMatchObject({
            revision: 1,
            outcome: 'failed',
            error: expect.stringContaining('expired before the Gateway accepted it'),
        })

        const ledger = await readFile(path, 'utf8')
        expect(ledger.trim().split('\n')).toHaveLength(2)
        expect(ledger).toContain('"kind":"command_result"')
    })

    it('does not treat a retired expired state command as a business mutation barrier', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-expired-state-command-'))
        temporaryDirectories.push(directory)
        const path = join(directory, 'replay.jsonl')
        const original: CodeverCommand = {
            kind: 'codever.command',
            version: 1,
            commandId: 'original-prompt',
            gatewayId: 'gateway-1',
            deviceId: 'device-1',
            sequenceEpoch: 'certificate-1',
            conversationId: 'conversation-1',
            revisionEpoch: 'runtime-epoch-1',
            sequence: 1,
            baseRevision: 0,
            operation: 'prompt',
            issuedAt: 1_000,
            expiresAt: 61_000,
            nonce: '0123456789abcdef-original-prompt',
            payload: {
                operation: 'prompt',
                sessionId: 'session-1',
                text: 'first',
            },
        }
        const expiredStateCommand: CodeverCommand = {
            ...original,
            commandId: 'expired-delete',
            deviceId: 'device-2',
            sequenceEpoch: 'certificate-2',
            nonce: '0123456789abcdef-expired-delete',
            operation: 'session.delete',
            payload: {
                operation: 'session.delete',
                sessionId: 'session-1',
            },
        }
        const stalePrompt: CodeverCommand = {
            ...original,
            commandId: 'stale-follow-up',
            sequence: 2,
            baseRevision: 1,
            issuedAt: 121_000,
            expiresAt: 181_000,
            nonce: '0123456789abcdef-stale-follow-up',
            payload: {
                operation: 'prompt',
                sessionId: 'session-1',
                text: 'still append-only',
            },
        }
        const store = new FileCommandReplayStore(path)
        await store.initialize(1_000)
        await expect(store.claimCommandInOrder(
            original,
            1_000,
        )).resolves.toMatchObject({ revision: 1 })
        await expect(store.claimCommandInOrder(
            expiredStateCommand,
            121_000,
        )).resolves.toMatchObject({
            revision: 2,
            terminal: { outcome: 'failed' },
        })

        const restarted = new FileCommandReplayStore(path)
        await restarted.initialize(121_000)
        await expect(restarted.claimCommandInOrder(
            stalePrompt,
            121_000,
        )).resolves.toMatchObject({ status: 'accepted', revision: 3 })
    })

    it('recovers an exact terminal result after restart and rejects conflicts', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-command-result-'))
        temporaryDirectories.push(directory)
        const path = join(directory, 'replay.jsonl')
        const command: CodeverCommand = {
            kind: 'codever.command',
            version: 1,
            commandId: 'device-invite-command',
            gatewayId: 'gateway-1',
            deviceId: 'device-1',
            sequenceEpoch: 'certificate-1',
            conversationId: 'conversation-1',
            revisionEpoch: 'runtime-epoch-1',
            sequence: 1,
            baseRevision: 0,
            operation: 'device.invite',
            issuedAt: 1_000,
            expiresAt: 61_000,
            nonce: '0123456789abcdef-command-result',
            payload: {
                operation: 'device.invite',
                lifetimeMs: 300_000,
            },
        }
        const store = new FileCommandReplayStore(path)
        await store.initialize(1_000)
        await expect(store.claimCommandInOrder(command, 1_000)).resolves.toEqual({
            status: 'accepted',
            revision: 1,
        })
        const terminal = {
            revision: 1,
            outcome: 'succeeded' as const,
            sessionId: null,
            result: {
                pairingLink: 'codever://pair?data=stable',
                expiresAt: 301_000,
            },
        }
        await store.recordCommandResult(command, terminal)
        await store.recordCommandResult(command, terminal)

        const restarted = new FileCommandReplayStore(path)
        await restarted.initialize(2_000)
        await expect(restarted.getCommandResult(command)).resolves.toEqual(terminal)
        await expect(restarted.claimCommandInOrder(command, 2_000)).resolves.toEqual({
            status: 'duplicate',
            revision: 1,
        })
        await expect(restarted.recordCommandResult(command, {
            ...terminal,
            result: {
                pairingLink: 'codever://pair?data=different',
                expiresAt: 301_000,
            },
        })).rejects.toThrow('different durable terminal result')

        const ledger = await readFile(path, 'utf8')
        expect(ledger.match(/"kind":"command_result"/gu)).toHaveLength(1)
    })

})
