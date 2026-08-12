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

    it('migrates an existing runtime epoch to generation one without changing the epoch', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-runtime-migration-'))
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
                    revisionEpoch: 'legacy-runtime-epoch',
                    replayGeneration: 'ledger-generation-1',
                    stateVersion: 7,
                    currentSessionId: 'legacy-session',
                    appSessions: [{
                        id: 'legacy-session',
                        title: 'Legacy session',
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

        const migrated = new FileGatewayRuntimeStateStore(path)
        await migrated.initialize([room], 'ledger-generation-1')
        expect(migrated.getRoom(room.roomId)).toMatchObject({
            revisionEpoch: 'legacy-runtime-epoch',
            revisionEpochGeneration: 1,
            stateVersion: 7,
            workspace: {
                projectName: 'repo',
                reasoningEffort: null,
            },
            appSessions: [{
                id: 'legacy-session',
                projectName: 'repo',
                cwd: 'C:\\repo',
                reasoningEffort: null,
                permissionMode: 'default',
                archivedAt: null,
                extensions: [],
            }],
        })
        expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
            rooms: {
                [room.roomId]: {
                    revisionEpochGeneration: 1,
                    appSessions: [{ extensions: [] }],
                },
            },
        })
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

    it('recovers an expired command from a ledger written before recovery metadata existed', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-replay-command-recovery-'))
        temporaryDirectories.push(directory)
        const ledgerPath = join(directory, 'replay.jsonl')
        const now = 2_000_000
        const command: CodeverCommand = {
            kind: 'codever.command',
            version: 1,
            commandId: 'legacy-command-1',
            gatewayId: 'gateway-1',
            deviceId: 'device-1',
            sequenceEpoch: 'certificate-1',
            conversationId: 'conversation-1',
            revisionEpoch: 'revision-epoch-1',
            sequence: 1,
            baseRevision: 0,
            operation: 'prompt',
            issuedAt: now,
            expiresAt: now + 60_000,
            nonce: '0123456789abcdef-legacy-command',
            payload: {
                operation: 'prompt',
                sessionId: 'session-1',
                text: 'recover me',
            },
        }
        const first = new FileCommandReplayStore(ledgerPath)
        await first.initialize(now)
        await expect(
            first.claimCommandInOrder(command, now, command.sequenceEpoch),
        ).resolves.toEqual({ status: 'accepted', revision: 1 })
        await expect(
            first.claimCommandInOrder(
                {
                    ...command,
                    payload: {
                        operation: 'prompt',
                        sessionId: 'session-1',
                        text: 'different payload',
                    },
                },
                now + 1,
                command.sequenceEpoch,
            ),
        ).rejects.toMatchObject({ code: 'replay' })

        const records = (await readFile(ledgerPath, 'utf8'))
            .trim()
            .split('\n')
            .map(line => JSON.parse(line) as Record<string, unknown>)
        for (const record of records) {
            const revision = record.revision as Record<string, unknown> | undefined
            if (!revision) continue
            delete revision.commandSequence
            delete revision.commandNonceKey
            delete revision.commandBaseRevision
            delete revision.commandFingerprint
        }
        await writeFile(
            ledgerPath,
            `${records.map(record => JSON.stringify(record)).join('\n')}\n`,
            'utf8',
        )

        const afterExpiry = now + 2 * 60_000
        const recovered = new FileCommandReplayStore(ledgerPath)
        await recovered.initialize(afterExpiry)
        await expect(
            recovered.claimCommandInOrder(
                command,
                afterExpiry,
                command.sequenceEpoch,
            ),
        ).resolves.toEqual({ status: 'duplicate', revision: 1 })
    })
})

describe('FileCommandReplayStore terminal results', () => {
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
            sequenceEpoch: 'legacy-v1',
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

    it('retrieves a legacy Android result after authentication fields change on upgrade', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-command-result-upgrade-'))
        temporaryDirectories.push(directory)
        const path = join(directory, 'replay.jsonl')
        const command: CodeverCommand = {
            kind: 'codever.command',
            version: 1,
            commandId: 'legacy-android-command',
            gatewayId: 'gateway-1',
            deviceId: 'device-1',
            sequenceEpoch: 'certificate-1',
            conversationId: 'conversation-1',
            revisionEpoch: 'runtime-epoch-1',
            sequence: 1,
            baseRevision: 0,
            operation: 'session.delete',
            issuedAt: 1_000,
            expiresAt: 61_000,
            nonce: '0123456789abcdef-original-auth',
            payload: {
                operation: 'session.delete',
                sessionId: 'session-1',
            },
        }
        const terminal = {
            revision: 1,
            outcome: 'succeeded' as const,
            sessionId: 'session-1',
        }
        const original = new FileCommandReplayStore(path)
        await original.initialize(1_000)
        await original.claimCommandInOrder(command, 1_000, command.sequenceEpoch)
        await original.recordCommandResult(command, terminal, command.sequenceEpoch)

        // Fingerprints written before this change were raw SHA-256 strings.
        const records = (await readFile(path, 'utf8'))
            .trim()
            .split('\n')
            .map(line => JSON.parse(line) as Record<string, unknown>)
        for (const record of records) {
            const revision = record.revision as Record<string, unknown> | undefined
            if (typeof revision?.commandFingerprint === 'string') {
                revision.commandFingerprint = revision.commandFingerprint.replace(/^v2:/u, '')
            }
            if (typeof record.fingerprint === 'string') {
                record.fingerprint = record.fingerprint.replace(/^v2:/u, '')
            }
        }
        await writeFile(
            path,
            `${records.map(record => JSON.stringify(record)).join('\n')}\n`,
            'utf8',
        )

        const recoveredCommand: CodeverCommand = {
            ...command,
            issuedAt: 2_000,
            expiresAt: 62_000,
            nonce: '0123456789abcdef-refreshed-auth',
        }
        const recovered = new FileCommandReplayStore(path)
        await recovered.initialize(2_000)
        await expect(
            recovered.claimCommandInOrder(
                recoveredCommand,
                2_000,
                recoveredCommand.sequenceEpoch,
            ),
        ).resolves.toEqual({
            status: 'duplicate',
            revision: 1,
            legacyFingerprintRecovery: true,
        })
        await expect(
            recovered.getCommandResult(recoveredCommand, recoveredCommand.sequenceEpoch),
        ).rejects.toMatchObject({ code: 'replay' })
        await expect(
            recovered.getCommandResult(
                recoveredCommand,
                recoveredCommand.sequenceEpoch,
                true,
            ),
        ).resolves.toEqual(terminal)
    })
})
