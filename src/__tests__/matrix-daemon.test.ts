import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClientEvent, SyncState, type MatrixClient, type MatrixEvent } from 'matrix-js-sdk'
import type { CodeverCommand, SignedCommand } from '@codever/protocol'
import {
    exportDeviceKeyPair,
    generateDeviceKeyPair,
    InMemoryReplayStore,
    openSecureEnvelope,
    sealSecureEnvelope,
    signCommand,
} from '@codever/security'
import type { AgentProvider, AgentQueryHandle } from '@/providers/provider'
import type { TopicSession } from '@/bridge/channelPort'
import type { SessionInput } from '@/runtime/semantic'
import {
    CODEVER_MATRIX_EXTENSION,
    type MatrixIncomingEvent,
    type MatrixSendEventRequest,
    type MatrixSendEventResult,
} from '@/channel/matrix'
import {
    FileCommandReplayStore,
    gatewayProjectIdentity,
    MatrixGatewayRunner,
    MatrixJsSdkGatewayClient,
    StrictMatrixCommandAuthorizer,
    validateMatrixGatewayConfig,
    type MatrixGatewayClient,
    type MatrixGatewayConfig,
    type MatrixGatewayCryptoConfig,
    type MatrixGatewayEventListener,
} from '@/gateway/matrix'
import { startMatrixDaemon } from '@/matrix-daemon'

const temporaryDirectories: string[] = []
const REVISION_EPOCH = 'runtime-epoch-1'
const REPLAY_GENERATION = 'replay-generation-1'

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('strict Matrix command authorization', () => {
    it('requires the app signature, conversation binding, Matrix sender pin, and durable nonce claim', async () => {
        const fixture = await securityFixture()
        const signed = await signedPrompt(fixture.keys, fixture.now)
        const authorizer = new StrictMatrixCommandAuthorizer(
            fixture.config.gatewayId,
            fixture.config.trustedDevices,
            new FileCommandReplayStore(fixture.config.replayLedgerPath),
        )
        await authorizer.initialize(fixture.now)

        await expect(authorizer.authorize(signed, {
            roomId: '!room:example.org',
            conversationId: 'conversation-1',
            revisionEpoch: REVISION_EPOCH,
            matrixSender: '@alice:example.org',
            matrixDeviceKey: 'matrix-ed25519-key',
        }, fixture.now)).resolves.toMatchObject({
            operation: 'prompt',
            payload: { text: 'hello from PWA' },
        })

        const restarted = new StrictMatrixCommandAuthorizer(
            fixture.config.gatewayId,
            fixture.config.trustedDevices,
            new FileCommandReplayStore(fixture.config.replayLedgerPath),
        )
        await restarted.initialize(fixture.now)
        await expect(restarted.authorize(signed, {
            roomId: '!room:example.org',
            conversationId: 'conversation-1',
            revisionEpoch: REVISION_EPOCH,
            matrixSender: '@alice:example.org',
            matrixDeviceKey: 'matrix-ed25519-key',
        }, fixture.now)).rejects.toMatchObject({ code: 'replay' })
        await expect(restarted.authorizeDelivery(signed, {
            roomId: '!room:example.org',
            conversationId: 'conversation-1',
            revisionEpoch: REVISION_EPOCH,
            matrixSender: '@alice:example.org',
            matrixDeviceKey: 'matrix-ed25519-key',
        }, fixture.now)).resolves.toMatchObject({
            duplicate: true,
            command: { commandId: signed.command.commandId },
        })
    })

    it('recovers an expired command only when the durable ledger already accepted it', async () => {
        const fixture = await securityFixture()
        const signed = await signedPrompt(fixture.keys, fixture.now)
        const context = {
            roomId: '!room:example.org',
            conversationId: 'conversation-1',
            revisionEpoch: REVISION_EPOCH,
            matrixSender: '@alice:example.org',
            matrixDeviceKey: 'matrix-ed25519-key',
        }
        const authorizer = new StrictMatrixCommandAuthorizer(
            fixture.config.gatewayId,
            fixture.config.trustedDevices,
            new FileCommandReplayStore(fixture.config.replayLedgerPath),
        )
        await authorizer.initialize(fixture.now)
        await expect(
            authorizer.authorizeDelivery(signed, context, fixture.now),
        ).resolves.toMatchObject({ duplicate: false, revision: 1 })

        const afterExpiry = fixture.now + 2 * 60_000
        const restarted = new StrictMatrixCommandAuthorizer(
            fixture.config.gatewayId,
            fixture.config.trustedDevices,
            new FileCommandReplayStore(fixture.config.replayLedgerPath),
        )
        await restarted.initialize(afterExpiry)
        await expect(
            restarted.authorizeDelivery(signed, context, afterExpiry),
        ).resolves.toMatchObject({
            duplicate: true,
            revision: 1,
            command: { commandId: signed.command.commandId },
        })

        const unknownExpired = await signedPrompt(
            fixture.keys,
            fixture.now,
            2,
            1,
        )
        await expect(
            restarted.authorizeDelivery(unknownExpired, context, afterExpiry),
        ).rejects.toMatchObject({ code: 'expired' })
    })

    it('rejects a valid app signature arriving through a non-pinned Matrix device', async () => {
        const fixture = await securityFixture()
        const authorizer = new StrictMatrixCommandAuthorizer(
            fixture.config.gatewayId,
            fixture.config.trustedDevices,
            new FileCommandReplayStore(fixture.config.replayLedgerPath),
        )
        await authorizer.initialize(fixture.now)

        await expect(authorizer.authorize(
            await signedPrompt(fixture.keys, fixture.now),
            {
                roomId: '!room:example.org',
                conversationId: 'conversation-1',
                revisionEpoch: REVISION_EPOCH,
                matrixSender: '@alice:example.org',
                matrixDeviceKey: 'server-substituted-key',
            },
            fixture.now,
        )).rejects.toMatchObject({ code: 'matrix-device-mismatch' })
    })

    it('rejects command gaps and persists the next sequence across restarts', async () => {
        const fixture = await securityFixture()
        const context = {
            roomId: '!room:example.org',
            conversationId: 'conversation-1',
            revisionEpoch: REVISION_EPOCH,
            matrixSender: '@alice:example.org',
            matrixDeviceKey: 'matrix-ed25519-key',
        }
        const authorizer = new StrictMatrixCommandAuthorizer(
            fixture.config.gatewayId,
            fixture.config.trustedDevices,
            new FileCommandReplayStore(fixture.config.replayLedgerPath),
        )
        await authorizer.initialize(fixture.now)

        await expect(authorizer.authorize(
            await signedPrompt(fixture.keys, fixture.now, 2),
            context,
            fixture.now,
        )).rejects.toMatchObject({ code: 'sequence' })
        await expect(authorizer.authorize(
            await signedPrompt(fixture.keys, fixture.now, 1),
            context,
            fixture.now,
        )).resolves.toMatchObject({ sequence: 1 })
        await expect(authorizer.authorize(
            await signedPrompt(fixture.keys, fixture.now, 2),
            context,
            fixture.now,
        )).resolves.toMatchObject({ sequence: 2 })

        const restarted = new StrictMatrixCommandAuthorizer(
            fixture.config.gatewayId,
            fixture.config.trustedDevices,
            new FileCommandReplayStore(fixture.config.replayLedgerPath),
        )
        await restarted.initialize(fixture.now)
        await expect(restarted.authorize(
            await signedPrompt(fixture.keys, fixture.now, 4),
            context,
            fixture.now,
        )).rejects.toMatchObject({ code: 'sequence' })
        await expect(restarted.authorize(
            await signedPrompt(fixture.keys, fixture.now, 3),
            context,
            fixture.now,
        )).resolves.toMatchObject({ sequence: 3 })

        const replacementGatewayIdentity = new StrictMatrixCommandAuthorizer(
            fixture.config.gatewayId,
            fixture.config.trustedDevices,
            new FileCommandReplayStore(fixture.config.replayLedgerPath),
            'replacement-gateway-key',
        )
        await replacementGatewayIdentity.initialize(fixture.now)
        await expect(replacementGatewayIdentity.authorize(
            await signedPrompt(
                fixture.keys,
                fixture.now,
                1,
                3,
                'replacement-gateway-key',
            ),
            context,
            fixture.now,
        )).resolves.toMatchObject({ sequence: 1 })
    })

    it('fails closed when the persisted replay ledger is corrupt', async () => {
        const directory = await temporaryDirectory()
        const path = join(directory, 'replay.jsonl')
        await writeFile(path, '{"version":1,"claims":', 'utf8')

        await expect(new FileCommandReplayStore(path).initialize()).rejects.toThrow(
            'Corrupt command replay ledger at line 1',
        )
    })
})

describe('MatrixGatewayRunner', () => {
    it('serves authenticated history without consuming command revision or sequence', async () => {
        const fixture = await securityFixture()
        const gatewayKeys = await generateDeviceKeyPair()
        const requestNow = Date.now()
        delete fixture.config.allowInsecureLegacyForTesting
        fixture.config.applicationSecurity = {
            gatewayDeviceId: fixture.config.gatewayId,
            gatewayKeyPair: await exportDeviceKeyPair(gatewayKeys),
            envelopeReplayLedgerPath: join(
                await temporaryDirectory(),
                'envelope-replay.json',
            ),
        }
        fixture.config.trustedDevices[0]!.certificateExpiresAt = requestNow + 60_000
        fixture.config.trustedDevices[0]!.sequenceEpoch = 'certificate-pwa-1'
        const client = new FakeMatrixGatewayClient()
        const runner = new MatrixGatewayRunner(fixture.config, {
            client,
            now: () => requestNow,
            sessionFactory: () => fakeTopicSession([]),
        })
        await runner.start()

        const historyRequest = {
            kind: 'codever.history.request' as const,
            version: 1 as const,
            requestId: 'history-read-only',
            gatewayId: 'gateway-1',
            conversationId: 'conversation-1',
            deviceId: 'pwa-device-1',
            sessionId: 'app-session-1',
            limit: 30,
            issuedAt: requestNow,
            expiresAt: requestNow + 60_000,
        }
        const secureEnvelope = await sealSecureEnvelope({
            plaintext: {
                msgtype: 'm.notice',
                body: 'Encrypted Codever history request',
                [CODEVER_MATRIX_EXTENSION]: {
                    version: 1,
                    kind: 'history_request',
                    history_request: historyRequest,
                },
            },
            senderPrivateKey: fixture.keys.privateKey,
            recipientPublicKey: gatewayKeys.publicKey,
            gatewayId: 'gateway-1',
            conversationId: 'conversation-1',
            direction: 'device_to_gateway',
            senderDeviceId: 'pwa-device-1',
            recipientDeviceId: 'gateway-1',
            senderKeyId: fixture.keys.keyId,
            recipientKeyId: gatewayKeys.keyId,
            now: requestNow,
        })
        client.emit({
            roomId: '!room:example.org',
            eventId: '$history-request',
            eventType: 'm.room.message',
            sender: '@alice:example.org',
            senderDeviceId: 'matrix-ed25519-key',
            encrypted: true,
            encryptedPayloadFingerprint: 'history-request-ciphertext',
            content: {
                msgtype: 'm.notice',
                body: 'Encrypted Codever message',
                [CODEVER_MATRIX_EXTENSION]: {
                    version: 1,
                    kind: 'secure_envelope',
                    secure_envelope: secureEnvelope,
                },
            },
        })

        await vi.waitFor(() => expect(client.sent).toHaveLength(2))
        const responseOuter = client.sent[1]!.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
        const response = await openSecureEnvelope(responseOuter.secure_envelope, {
            recipientPrivateKey: fixture.keys.privateKey,
            senderPublicKey: gatewayKeys.publicKey,
            expected: {
                gatewayId: 'gateway-1',
                conversationId: 'conversation-1',
                direction: 'gateway_to_device',
                senderDeviceId: 'gateway-1',
                recipientDeviceId: 'pwa-device-1',
                senderKeyId: gatewayKeys.keyId,
                recipientKeyId: fixture.keys.keyId,
            },
            replayStore: new InMemoryReplayStore(),
            now: requestNow,
        })
        expect(response.plaintext).toMatchObject({
            [CODEVER_MATRIX_EXTENSION]: {
                kind: 'history_page',
                history_page: {
                    requestId: 'history-read-only',
                    sessionId: 'app-session-1',
                    hasMore: false,
                    replayed: 0,
                },
            },
        })
        const replayStore = Reflect.get(runner, 'replayStore') as FileCommandReplayStore
        await expect(replayStore.getConversationRevision(
            'gateway-1',
            'conversation-1',
            REVISION_EPOCH,
        )).resolves.toBe(0)
        await runner.stop()
    })

    it('lets an authenticated device create a short-lived pairing invitation', async () => {
        const fixture = await securityFixture()
        const session = fakeTopicSession([])
        const runtime = directRoomRuntime(fixture.config.rooms[0]!, session)
        const createDeviceInvitation = vi.fn(async () => ({
            pairingLink: 'codever://pair?data=signed-offer',
            expiresAt: fixture.now + 5 * 60_000,
        }))
        const runner = new MatrixGatewayRunner(fixture.config, {
            client: new FakeMatrixGatewayClient(),
            createDeviceInvitation,
        })
        await initializeDirectRuntime(runner, fixture.config)
        const command: CodeverCommand = {
            kind: 'codever.command',
            version: 1,
            commandId: 'invite-device',
            gatewayId: fixture.config.gatewayId,
            deviceId: 'pwa-device-1',
            sequenceEpoch: 'legacy-v1',
            conversationId: fixture.config.rooms[0]!.conversationId,
            revisionEpoch: REVISION_EPOCH,
            sequence: 1,
            baseRevision: 0,
            operation: 'device.invite',
            issuedAt: fixture.now,
            expiresAt: fixture.now + 60_000,
            nonce: '0123456789abcdef-invite-device',
            payload: {
                operation: 'device.invite',
                lifetimeMs: 5 * 60_000,
            },
        }

        const result = await (runner as unknown as {
            execute(
                roomRuntime: typeof runtime,
                command: CodeverCommand,
            ): Promise<{
                sessionId: string | null
                result?: {
                    pairingLink: string
                    expiresAt: number
                }
            }>
        }).execute(runtime, command)

        expect(createDeviceInvitation).toHaveBeenCalledWith({
            requestedByDeviceId: 'pwa-device-1',
            lifetimeMs: 5 * 60_000,
        })
        expect(result).toEqual({
            sessionId: null,
            result: {
                pairingLink: 'codever://pair?data=signed-offer',
                expiresAt: fixture.now + 5 * 60_000,
            },
        })
    })

    it('creates a session atomically in a Gateway-scoped project with reasoning settings', async () => {
        const fixture = await securityFixture()
        const projectDirectory = await temporaryDirectory()
        const dispatched: SessionInput[] = []
        const session = fakeTopicSession(dispatched)
        const provider = fakeProvider([{
            id: 'gpt-project',
            name: 'GPT Project',
            provider: 'mock-provider',
            defaultReasoningLevel: 'medium',
            supportedReasoningLevels: [
                { effort: 'medium' },
                { effort: 'high' },
            ],
        }])
        const runtime = {
            ...directRoomRuntime(fixture.config.rooms[0]!, session, false),
            capabilityProvider: provider as AgentProvider | null,
        }
        let createdRoom: MatrixGatewayConfig['rooms'][number] | undefined
        let createdSessionId: string | undefined
        const runner = new MatrixGatewayRunner(fixture.config, {
            client: new FakeMatrixGatewayClient(),
            sessionFactory: (room, _port, appSession) => {
                createdRoom = room
                createdSessionId = appSession?.id
                return session
            },
        })
        await initializeDirectRuntime(runner, fixture.config)
        const command: CodeverCommand = {
            kind: 'codever.command',
            version: 1,
            commandId: 'create-project-session',
            gatewayId: fixture.config.gatewayId,
            deviceId: 'pwa-device-1',
            sequenceEpoch: 'legacy-v1',
            conversationId: fixture.config.rooms[0]!.conversationId,
            revisionEpoch: REVISION_EPOCH,
            sequence: 1,
            baseRevision: 0,
            operation: 'session.create',
            issuedAt: fixture.now,
            expiresAt: fixture.now + 60_000,
            nonce: '0123456789abcdef-create-project',
            payload: {
                operation: 'session.create',
                cwd: projectDirectory,
                projectName: 'Same name is allowed',
                model: 'gpt-project',
                reasoningEffort: 'high',
            },
        }

        const executionResult = await (runner as unknown as {
            execute(
                roomRuntime: typeof runtime,
                command: CodeverCommand,
            ): Promise<{ sessionId: string | null }>
        }).execute(runtime, command)

        expect(dispatched).toEqual([])
        expect(executionResult.sessionId).toBe(createdSessionId)
        expect(createdRoom).toMatchObject({
            cwd: projectDirectory,
            providerName: 'mock-provider',
            model: 'gpt-project',
            providerSettings: expect.objectContaining({
                reasoningEffort: 'high',
            }),
        })
        expect([...runtime.appSessions.values()].map(appSession => appSession.record)).toEqual([
            expect.objectContaining({
                projectName: 'Same name is allowed',
                cwd: projectDirectory,
                model: 'gpt-project',
                reasoningEffort: 'high',
            }),
        ])
    })

    it('archives, restores, and permanently removes an app session', async () => {
        const fixture = await securityFixture()
        const dispatched: SessionInput[] = []
        const session = fakeTopicSession(dispatched)
        session.sessionRecord.setConversationId('provider-session-1')
        const runtime = directRoomRuntime(fixture.config.rooms[0]!, session)
        const runner = new MatrixGatewayRunner(fixture.config, {
            client: new FakeMatrixGatewayClient(),
            sessionFactory: () => session,
            now: () => fixture.now,
        })
        await initializeDirectRuntime(runner, fixture.config)
        const command = (
            operation: 'session.archive' | 'session.restore' | 'session.delete',
            sequence: number,
        ): CodeverCommand => ({
            kind: 'codever.command',
            version: 1,
            commandId: `${operation}-${sequence}`,
            gatewayId: fixture.config.gatewayId,
            deviceId: 'pwa-device-1',
            sequenceEpoch: 'legacy-v1',
            conversationId: fixture.config.rooms[0]!.conversationId,
            revisionEpoch: REVISION_EPOCH,
            sequence,
            baseRevision: sequence - 1,
            operation,
            issuedAt: fixture.now,
            expiresAt: fixture.now + 60_000,
            nonce: `0123456789abcdef-${operation}-${sequence}`,
            payload: { operation, sessionId: 'app-session-1' },
        })
        const execute = (lifecycleCommand: CodeverCommand) =>
            (runner as unknown as {
                execute(
                    roomRuntime: typeof runtime,
                    command: CodeverCommand,
                ): Promise<{ sessionId: string | null }>
            }).execute(runtime, lifecycleCommand)

        await expect(execute(command('session.archive', 1))).resolves.toEqual({
            sessionId: 'app-session-1',
        })
        expect(runtime.appSessions.size).toBe(0)
        expect(runtime.archivedSessions.get('app-session-1')).toMatchObject({
            archivedAt: fixture.now,
            providerSessionId: 'provider-session-1',
        })
        expect(session.destroy).toHaveBeenCalledTimes(1)

        await expect(execute(command('session.restore', 2))).resolves.toEqual({
            sessionId: 'app-session-1',
        })
        expect(runtime.archivedSessions.size).toBe(0)
        expect(runtime.appSessions.get('app-session-1')?.record.archivedAt).toBeNull()

        await expect(execute(command('session.delete', 3))).resolves.toEqual({
            sessionId: 'app-session-1',
        })
        expect(runtime.appSessions.size).toBe(0)
        expect(runtime.archivedSessions.size).toBe(0)
        const runtimeStateStore = Reflect.get(runner, 'runtimeStateStore') as {
            getRoom(roomId: string): { appSessions: unknown[] }
        }
        expect(runtimeStateStore.getRoom(fixture.config.rooms[0]!.roomId).appSessions)
            .toEqual([])
    })

    it('routes two concurrently running prompts to independent app session runtimes', async () => {
        const fixture = await securityFixture()
        const firstDispatches: SessionInput[] = []
        const secondDispatches: SessionInput[] = []
        const firstSession = fakeTopicSession(firstDispatches)
        const secondSession = fakeTopicSession(secondDispatches)
        const entered = new Set<string>()
        let releasePrompts!: () => void
        const promptsMayFinish = new Promise<void>(resolve => {
            releasePrompts = resolve
        })
        firstSession.dispatch = vi.fn(async (input: SessionInput) => {
            firstDispatches.push(input)
            entered.add('app-session-1')
            await promptsMayFinish
        })
        secondSession.dispatch = vi.fn(async (input: SessionInput) => {
            secondDispatches.push(input)
            entered.add('app-session-2')
            await promptsMayFinish
        })
        const runtime = directRoomRuntime(fixture.config.rooms[0]!, firstSession)
        const firstRuntime = runtime.appSessions.get('app-session-1')!
        runtime.appSessions.set('app-session-2', {
            record: {
                ...firstRuntime.record,
                id: 'app-session-2',
                title: 'Second session',
            },
            port: secondSession.channelPort,
            session: secondSession,
            capabilityProvider: null,
        })
        const runner = new MatrixGatewayRunner(fixture.config, {
            client: new FakeMatrixGatewayClient(),
        })
        await initializeDirectRuntime(runner, fixture.config)
        const firstCommand = (await signedPrompt(fixture.keys, fixture.now)).command
        const secondCommand: CodeverCommand = {
            ...structuredClone(firstCommand),
            commandId: 'second-session-prompt',
            payload: {
                operation: 'prompt',
                sessionId: 'app-session-2',
                text: 'second prompt',
            },
        }
        const execute = (command: CodeverCommand) =>
            (runner as unknown as {
                execute(
                    roomRuntime: typeof runtime,
                    command: CodeverCommand,
                ): Promise<{ sessionId: string | null }>
            }).execute(runtime, command)

        const firstExecution = execute(firstCommand)
        const secondExecution = execute(secondCommand)
        await vi.waitFor(() => expect(entered).toEqual(new Set([
            'app-session-1',
            'app-session-2',
        ])))
        expect(firstDispatches).toEqual([
            expect.objectContaining({ kind: 'user_message', text: 'hello from PWA' }),
        ])
        expect(secondDispatches).toEqual([
            expect.objectContaining({ kind: 'user_message', text: 'second prompt' }),
        ])

        releasePrompts()
        await expect(Promise.all([firstExecution, secondExecution])).resolves.toEqual([
            { sessionId: 'app-session-1' },
            { sessionId: 'app-session-2' },
        ])
    })

    it('initializes crypto before sync, verifies room encryption, and routes a signed prompt to TopicSession', async () => {
        const fixture = await securityFixture()
        const client = new FakeMatrixGatewayClient()
        const dispatched: SessionInput[] = []
        const session = fakeTopicSession(dispatched)
        const runner = new MatrixGatewayRunner(fixture.config, {
            client,
            now: () => fixture.now,
            sessionFactory: () => session,
        })

        await runner.start()
        expect(runner.getState()).toBe('running')
        expect(client.lifecycle).toEqual([
            'crypto',
            'start',
            'ready',
            'encrypted:!room:example.org',
        ])

        client.emit(incomingSigned(await signedPrompt(fixture.keys, fixture.now)))
        await vi.waitFor(() => expect(dispatched).toHaveLength(1))
        expect(dispatched[0]).toMatchObject({
            kind: 'user_message',
            text: 'hello from PWA',
            source: 'channel',
            user: { id: 'pwa-device-1' },
        })

        await runner.stop()
        expect(runner.getState()).toBe('stopped')
        expect(client.lifecycle.at(-1)).toBe('stop')
        expect(session.destroy).toHaveBeenCalledOnce()
    })

    it('broadcasts an encrypted revision-zero authoritative state and supports explicit resync', async () => {
        const fixture = await securityFixture()
        const gatewayKeys = await generateDeviceKeyPair()
        delete fixture.config.allowInsecureLegacyForTesting
        fixture.config.applicationSecurity = {
            gatewayDeviceId: fixture.config.gatewayId,
            gatewayKeyPair: await exportDeviceKeyPair(gatewayKeys),
            envelopeReplayLedgerPath: join(
                await temporaryDirectory(),
                'envelope-replay.json',
            ),
        }
        fixture.config.trustedDevices[0]!.certificateExpiresAt = Date.now() + 60_000
        fixture.config.trustedDevices[0]!.sequenceEpoch = 'certificate-pwa-1'
        const client = new FakeMatrixGatewayClient()
        const runner = new MatrixGatewayRunner(fixture.config, {
            client,
            sessionFactory: () => fakeTopicSession([]),
        })

        await runner.start()
        expect(client.sent).toHaveLength(1)
        await runner.syncState()
        expect(client.sent).toHaveLength(2)
        expect(client.sent[0]!.transactionId).not.toBe(client.sent[1]!.transactionId)

        const outer = client.sent[0]!.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
        const opened = await openSecureEnvelope(outer.secure_envelope, {
            recipientPrivateKey: fixture.keys.privateKey,
            senderPublicKey: gatewayKeys.publicKey,
            expected: {
                gatewayId: 'gateway-1',
                conversationId: 'conversation-1',
                direction: 'gateway_to_device',
                senderDeviceId: 'gateway-1',
                recipientDeviceId: 'pwa-device-1',
                senderKeyId: gatewayKeys.keyId,
                recipientKeyId: fixture.keys.keyId,
            },
            replayStore: new InMemoryReplayStore(),
        })
        expect(opened.plaintext).toMatchObject({
            [CODEVER_MATRIX_EXTENSION]: {
                kind: 'gateway_state',
                revision: 0,
                revision_epoch: REVISION_EPOCH,
                revision_epoch_generation: 1,
                state_version: 1,
                current_session_id: null,
                workspace: {
                    cwd: 'C:\\repo',
                    provider: 'mock-provider',
                    permission_mode: 'default',
                },
                capabilities: {
                    models: [],
                    permission_modes: [{ id: 'default', name: 'Default' }],
                    can_create_session: true,
                    can_select_session: false,
                },
            },
        })
        await runner.stop()
    })

    it('restores persisted sessions, provider session, workspace, epoch, and state version before first sync', async () => {
        const fixture = await securityFixture()
        const gatewayKeys = await generateDeviceKeyPair()
        delete fixture.config.allowInsecureLegacyForTesting
        fixture.config.applicationSecurity = {
            gatewayDeviceId: fixture.config.gatewayId,
            gatewayKeyPair: await exportDeviceKeyPair(gatewayKeys),
            envelopeReplayLedgerPath: join(
                await temporaryDirectory(),
                'envelope-replay.json',
            ),
        }
        fixture.config.trustedDevices[0]!.certificateExpiresAt = Date.now() + 60_000
        fixture.config.trustedDevices[0]!.sequenceEpoch = 'certificate-pwa-1'
        await writeFile(
            `${fixture.config.replayLedgerPath}.runtime-state.json`,
            `${JSON.stringify({
                version: 1,
                rooms: {
                    '!room:example.org': {
                        revisionEpoch: REVISION_EPOCH,
                        replayGeneration: REPLAY_GENERATION,
                        stateVersion: 4,
                        currentSessionId: 'app-session-1',
                        appSessions: [{
                            id: 'app-session-1',
                            title: 'Restored work',
                            updatedAt: fixture.now - 1_000,
                            provider: 'mock-provider',
                            model: null,
                            providerSessionId: 'provider-session-1',
                        }],
                        workspace: {
                            cwd: 'D:\\restored',
                            provider: 'mock-provider',
                            model: null,
                            permissionMode: 'default',
                        },
                    },
                },
            })}\n`,
            'utf8',
        )
        const client = new FakeMatrixGatewayClient()
        const session = fakeTopicSession([])
        let restoredRoom: MatrixGatewayConfig['rooms'][number] | undefined
        const runner = new MatrixGatewayRunner(fixture.config, {
            client,
            sessionFactory: (room) => {
                restoredRoom = room
                return session
            },
        })

        await runner.start()
        expect(restoredRoom?.cwd).toBe('D:\\restored')
        expect(session.sessionRecord.conversationId).toBe('provider-session-1')
        const outer = client.sent[0]!.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
        const opened = await openSecureEnvelope(outer.secure_envelope, {
            recipientPrivateKey: fixture.keys.privateKey,
            senderPublicKey: gatewayKeys.publicKey,
            expected: {
                gatewayId: 'gateway-1',
                conversationId: 'conversation-1',
                direction: 'gateway_to_device',
                senderDeviceId: 'gateway-1',
                recipientDeviceId: 'pwa-device-1',
                senderKeyId: gatewayKeys.keyId,
                recipientKeyId: fixture.keys.keyId,
            },
            replayStore: new InMemoryReplayStore(),
        })
        expect(opened.plaintext).toMatchObject({
            [CODEVER_MATRIX_EXTENSION]: {
                kind: 'gateway_state',
                revision_epoch: REVISION_EPOCH,
                revision_epoch_generation: 1,
                state_version: 5,
                current_session_id: null,
                sessions: [{
                    id: 'app-session-1',
                    title: 'Restored work',
                    status: 'idle',
                }],
                workspace: { cwd: 'D:\\restored' },
            },
        })
        const persisted = JSON.parse(
            await readFile(`${fixture.config.replayLedgerPath}.runtime-state.json`, 'utf8'),
        ) as { rooms: Record<string, { stateVersion: number }> }
        expect(persisted.rooms['!room:example.org']?.stateVersion).toBe(5)
        await runner.stop()
    })

    it('queues initial-sync commands until crypto and room encryption checks complete', async () => {
        const fixture = await securityFixture()
        const client = new FakeMatrixGatewayClient()
        const dispatched: SessionInput[] = []
        client.onStartEvent = incomingSigned(await signedPrompt(fixture.keys, fixture.now))
        const runner = new MatrixGatewayRunner(fixture.config, {
            client,
            now: () => fixture.now,
            sessionFactory: () => fakeTopicSession(dispatched),
        })

        await runner.start()

        await vi.waitFor(() => expect(dispatched).toHaveLength(1))
        expect(client.lifecycle).toEqual([
            'crypto',
            'start',
            'ready',
            'encrypted:!room:example.org',
        ])
        await runner.stop()
    })

    it('keeps cancel responsive while a previously accepted prompt is still running', async () => {
        const fixture = await securityFixture()
        const client = new FakeMatrixGatewayClient()
        const dispatched: SessionInput[] = []
        let finishPrompt!: () => void
        const promptFinished = new Promise<void>(resolve => {
            finishPrompt = resolve
        })
        const session = fakeTopicSession(dispatched)
        session.dispatch = vi.fn(async (input: SessionInput) => {
            dispatched.push(input)
            if (input.kind === 'user_message') await promptFinished
        })
        const runner = new MatrixGatewayRunner(fixture.config, {
            client,
            now: () => fixture.now,
            sessionFactory: () => session,
        })
        await runner.start()

        client.emit(incomingSigned(await signedPrompt(fixture.keys, fixture.now, 1), 'prompt'))
        await vi.waitFor(() => expect(dispatched).toHaveLength(1))
        client.emit(incomingSigned(await signedCancel(fixture.keys, fixture.now, 2), 'cancel'))

        await vi.waitFor(() => expect(dispatched).toHaveLength(2))
        expect(dispatched[1]).toMatchObject({ kind: 'cancel', reason: 'user' })
        finishPrompt()
        await runner.stop()
    })

    it('never turns a successful execution into a failed result when result delivery fails', async () => {
        const fixture = await securityFixture()
        const client = new FakeMatrixGatewayClient()
        const dispatched: SessionInput[] = []
        const rejected: unknown[] = []
        const logs: string[] = []
        const session = fakeTopicSession(dispatched)
        const runner = new MatrixGatewayRunner(fixture.config, {
            client,
            sessionFactory: () => session,
            onRejected: (_event, error) => rejected.push(error),
            onLog: message => logs.push(message),
        })
        await initializeDirectRuntime(runner, fixture.config)
        const sendCommandResult = vi.fn(async (
            _room: MatrixGatewayConfig['rooms'][number],
            _deviceId: string,
            _commandId: string,
            _sequence: number,
            _revision: number,
            _revisionEpoch: string,
            _outcome: 'succeeded' | 'failed',
            _transport: MatrixGatewayClient,
            _error?: string,
        ) => {
            throw new Error('homeserver unavailable after execution')
        })
        Reflect.set(runner, 'secureContent', { sendCommandResult })
        const signed = await signedPrompt(fixture.keys, fixture.now)
        const internals = runner as unknown as {
            scheduleExecution(
                event: MatrixIncomingEvent,
                runtime: ReturnType<typeof directRoomRuntime>,
                command: CodeverCommand,
                revision: number,
            ): void
        }

        internals.scheduleExecution(
            incomingSigned(signed),
            directRoomRuntime(fixture.config.rooms[0]!, session),
            signed.command,
            1,
        )

        await vi.waitFor(() => expect(sendCommandResult).toHaveBeenCalledOnce())
        expect(sendCommandResult.mock.calls[0]?.[3]).toBe(signed.command.sequence)
        expect(sendCommandResult.mock.calls[0]?.[6]).toBe('succeeded')
        expect(dispatched).toHaveLength(1)
        expect(rejected).toEqual([])
        expect(logs).toContainEqual(expect.stringContaining('succeeded result delivery failed'))
    })

    it('does not start prompt execution before its collaboration fan-out attempt completes', async () => {
        const fixture = await securityFixture()
        const client = new FakeMatrixGatewayClient()
        const dispatched: SessionInput[] = []
        const session = fakeTopicSession(dispatched)
        const runner = new MatrixGatewayRunner(fixture.config, {
            client,
            sessionFactory: () => session,
        })
        await initializeDirectRuntime(runner, fixture.config)
        Reflect.set(runner, 'secureContent', {
            sendCommandResult: vi.fn(async () => ({ eventId: '$result' })),
        })
        let releaseFanOut!: () => void
        const fanOutAttempt = new Promise<void>(resolve => {
            releaseFanOut = resolve
        })
        const signed = await signedPrompt(fixture.keys, fixture.now)
        const internals = runner as unknown as {
            scheduleExecution(
                event: MatrixIncomingEvent,
                runtime: ReturnType<typeof directRoomRuntime>,
                command: CodeverCommand,
                revision: number,
                beforeExecute?: Promise<unknown>,
            ): void
        }

        internals.scheduleExecution(
            incomingSigned(signed),
            directRoomRuntime(fixture.config.rooms[0]!, session),
            signed.command,
            1,
            fanOutAttempt,
        )

        await Promise.resolve()
        expect(dispatched).toHaveLength(0)
        releaseFanOut()
        await vi.waitFor(() => expect(dispatched).toHaveLength(1))
    })

    it('rejects clear-text and tampered commands without invoking a session', async () => {
        const fixture = await securityFixture()
        const client = new FakeMatrixGatewayClient()
        const dispatched: SessionInput[] = []
        const rejected: unknown[] = []
        const runner = new MatrixGatewayRunner(fixture.config, {
            client,
            now: () => fixture.now,
            sessionFactory: () => fakeTopicSession(dispatched),
            onRejected: (_event, error) => rejected.push(error),
        })
        await runner.start()

        const signed = await signedPrompt(fixture.keys, fixture.now)
        const tampered = structuredClone(signed)
        tampered.command.payload = {
            operation: 'prompt',
            sessionId: 'app-session-1',
            text: 'malicious',
        }
        client.emit(incomingSigned(tampered))
        client.emit({ ...incomingSigned(signed, 'clear-event'), encrypted: false })

        await vi.waitFor(() => expect(rejected).toHaveLength(2))
        expect(dispatched).toHaveLength(0)
        await runner.stop()
    })

    it('ignores the Gateway Matrix account own timeline echoes', async () => {
        const fixture = await securityFixture()
        const client = new FakeMatrixGatewayClient()
        const dispatched: SessionInput[] = []
        const rejected: unknown[] = []
        const runner = new MatrixGatewayRunner(fixture.config, {
            client,
            now: () => fixture.now,
            sessionFactory: () => fakeTopicSession(dispatched),
            onRejected: (_event, error) => rejected.push(error),
        })
        await runner.start()

        client.emit({
            ...incomingSigned(await signedPrompt(fixture.keys, fixture.now)),
            sender: fixture.config.connection.userId,
        })
        await runner.stop()

        expect(dispatched).toEqual([])
        expect(rejected).toEqual([])
    })

    it('consults the live registry before a previously trusted device can execute', async () => {
        const fixture = await securityFixture()
        const client = new FakeMatrixGatewayClient()
        const dispatched: SessionInput[] = []
        const rejected: unknown[] = []
        const runner = new MatrixGatewayRunner(fixture.config, {
            client,
            now: () => fixture.now,
            sessionFactory: () => fakeTopicSession(dispatched),
            isTrustedDeviceActive: async () => false,
            onRejected: (_event, error) => rejected.push(error),
        })
        await runner.start()

        client.emit(incomingSigned(await signedPrompt(fixture.keys, fixture.now)))
        await vi.waitFor(() => expect(rejected).toHaveLength(1))
        expect(dispatched).toEqual([])
        expect(rejected[0]).toEqual(expect.objectContaining({
            message: expect.stringContaining('has been revoked'),
        }))
        await runner.stop()
    })

    it('wires the default TopicSession and SemanticSessionRuntime to a provider and MatrixPort', async () => {
        const fixture = await securityFixture()
        const client = new FakeMatrixGatewayClient()
        const provider = fakeProvider()
        const runner = await startMatrixDaemon(fixture.config, {
            client,
            now: () => fixture.now,
            providerFactory: () => provider,
        })

        client.emit(incomingSigned(await signedPrompt(fixture.keys, fixture.now)))

        await vi.waitFor(() => expect(provider.startQuery).toHaveBeenCalledOnce())
        expect(provider.startQuery).toHaveBeenCalledWith(
            'hello from PWA',
            expect.objectContaining({ cwd: 'C:\\repo' }),
        )
        await vi.waitFor(() => expect(client.sent.length).toBeGreaterThan(0))
        expect(client.sent.some(request =>
            request.content[CODEVER_MATRIX_EXTENSION] !== undefined
            && request.content.msgtype === 'm.notice',
        )).toBe(true)
        await runner.stop()
    })

    it('fails startup and destroys room sessions if a configured room is not encrypted', async () => {
        const fixture = await securityFixture()
        const client = new FakeMatrixGatewayClient()
        client.encryptedRooms.clear()
        const session = fakeTopicSession([])
        const runner = new MatrixGatewayRunner(fixture.config, {
            client,
            sessionFactory: () => session,
        })

        await expect(runner.start()).rejects.toThrow('is not encrypted')

        expect(runner.getState()).toBe('stopped')
        expect(client.lifecycle).toContain('stop')
        expect(session.destroy).toHaveBeenCalledOnce()
    })
})

describe('MatrixJsSdkGatewayClient', () => {
    it('enforces crypto-before-sync and maps the v41 SDK send/decrypt surface', async () => {
        let sdkEventListener: ((event: MatrixEvent) => void) | undefined
        const crypto = {
            isEncryptionEnabledInRoom: vi.fn(async () => true),
            setDeviceIsolationMode: vi.fn(),
            getUserDeviceInfo: vi.fn(async () => new Map([
                ['@alice:example.org', new Map([
                    ['PWA1', { getFingerprint: () => 'matrix-ed25519-key' }],
                ])],
            ])),
            setDeviceVerified: vi.fn(async () => undefined),
        }
        const sdk = {
            initRustCrypto: vi.fn(async () => undefined),
            getCrypto: vi.fn(() => crypto),
            on: vi.fn((event: ClientEvent, listener: (event: MatrixEvent) => void) => {
                if (event === ClientEvent.Event) sdkEventListener = listener
            }),
            off: vi.fn(),
            startClient: vi.fn(async () => undefined),
            stopClient: vi.fn(),
            getSyncState: vi.fn(() => SyncState.Prepared),
            sendMessage: vi.fn(async () => ({ event_id: '$sent' })),
            sendTyping: vi.fn(async () => ({})),
            decryptEventIfNeeded: vi.fn(async () => undefined),
        } as unknown as MatrixClient
        const client = new MatrixJsSdkGatewayClient(sdk)

        await expect(client.start()).rejects.toThrow('crypto must be initialized')
        await client.initializeCrypto({
            useIndexedDB: true,
            databasePrefix: 'codever-device',
            storageKey: new Uint8Array(32),
        })
        await client.start()
        await client.waitUntilReady()
        await client.assertRoomEncrypted('!room:example.org')
        await client.pinTrustedDevices([{
            deviceId: 'pwa-device-1',
            publicKey: {},
            allowedRoomIds: ['!room:example.org'],
            matrixUserId: '@alice:example.org',
            matrixDeviceId: 'PWA1',
            matrixDeviceKeys: ['matrix-ed25519-key'],
        }])
        expect(crypto.setDeviceVerified).toHaveBeenCalledWith(
            '@alice:example.org',
            'PWA1',
            true,
        )

        const mapped: MatrixIncomingEvent[] = []
        client.onRoomEvent(event => mapped.push(event))
        sdkEventListener?.({
            getRoomId: () => '!room:example.org',
            getId: () => '$incoming',
            getSender: () => '@alice:example.org',
            getType: () => 'm.room.message',
            getTs: () => 123,
            isEncrypted: () => true,
            getWireContent: () => ({ algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'cipher' }),
            getClaimedEd25519Key: () => 'matrix-ed25519-key',
            getSenderKey: () => 'curve25519-key',
            getContent: () => ({ msgtype: 'm.text', body: 'hello' }),
        } as unknown as MatrixEvent)
        await vi.waitFor(() => expect(mapped).toHaveLength(1))

        expect(sdk.initRustCrypto).toHaveBeenCalledWith(expect.objectContaining({
            useIndexedDB: true,
            cryptoDatabasePrefix: 'codever-device',
        }))
        expect(mapped[0]).toMatchObject({
            encrypted: true,
            senderDeviceId: 'matrix-ed25519-key',
            eventType: 'm.room.message',
            content: { body: 'hello' },
        })
        expect(mapped[0].encryptedPayloadFingerprint).toMatch(/^[a-f0-9]{64}$/)

        await client.sendEncryptedRoomEvent({
            roomId: '!room:example.org',
            eventType: 'm.room.message',
            content: { msgtype: 'm.text', body: 'outgoing' },
            transactionId: 'txn-1',
        })
        expect(sdk.sendMessage).toHaveBeenCalledWith(
            '!room:example.org',
            expect.objectContaining({ body: 'outgoing' }),
            'txn-1',
        )
        await client.stop()
        expect(sdk.stopClient).toHaveBeenCalledOnce()
    })
})

describe('Matrix gateway configuration', () => {
    it('requires application-layer security unless a test explicitly opts out', async () => {
        const fixture = await securityFixture()
        fixture.config.allowInsecureLegacyForTesting = false

        expect(() => validateMatrixGatewayConfig(fixture.config)).toThrow(
            'Application-layer Matrix security is required',
        )
    })

    it('forbids accidental in-memory production crypto', async () => {
        const fixture = await securityFixture()
        fixture.config.crypto = {
            ...fixture.config.crypto,
            useIndexedDB: false,
            allowInMemoryForTesting: false,
        }

        expect(() => validateMatrixGatewayConfig(fixture.config)).toThrow('In-memory Matrix crypto is forbidden')
    })

    it('rejects two application device IDs backed by the same public key', async () => {
        const fixture = await securityFixture()
        const original = fixture.config.trustedDevices[0]!
        fixture.config.trustedDevices.push({
            ...structuredClone(original),
            deviceId: 'pwa-device-2',
            matrixDeviceId: 'PWA2',
            matrixDeviceKeys: ['matrix-ed25519-key-2'],
        })

        expect(() => validateMatrixGatewayConfig(fixture.config)).toThrow(
            'Duplicate trusted application public key',
        )
    })
})

class FakeMatrixGatewayClient implements MatrixGatewayClient {
    readonly lifecycle: string[] = []
    readonly sent: MatrixSendEventRequest[] = []
    readonly encryptedRooms = new Set(['!room:example.org'])
    onStartEvent?: MatrixIncomingEvent
    private listener: MatrixGatewayEventListener | null = null
    private nextEventId = 0

    async initializeCrypto(_config: MatrixGatewayCryptoConfig): Promise<void> {
        this.lifecycle.push('crypto')
    }

    onRoomEvent(listener: MatrixGatewayEventListener): () => void {
        this.listener = listener
        return () => {
            if (this.listener === listener) this.listener = null
        }
    }

    async start(): Promise<void> {
        this.lifecycle.push('start')
        if (this.onStartEvent) this.emit(this.onStartEvent)
    }

    async waitUntilReady(): Promise<void> {
        this.lifecycle.push('ready')
    }

    async assertRoomEncrypted(roomId: string): Promise<void> {
        this.lifecycle.push(`encrypted:${roomId}`)
        if (!this.encryptedRooms.has(roomId)) throw new Error(`Matrix room ${roomId} is not encrypted`)
    }

    async stop(): Promise<void> {
        this.lifecycle.push('stop')
    }

    async sendEncryptedRoomEvent(request: MatrixSendEventRequest): Promise<MatrixSendEventResult> {
        this.sent.push(structuredClone(request))
        return { eventId: `$outgoing-${++this.nextEventId}` }
    }

    async setTyping(): Promise<void> {}

    emit(event: MatrixIncomingEvent): void {
        this.listener?.(event)
    }
}

async function securityFixture() {
    const keys = await generateDeviceKeyPair()
    const directory = await temporaryDirectory()
    const now = 2_000_000
    const config: MatrixGatewayConfig = {
        gatewayId: 'gateway-1',
        connection: {
            baseUrl: 'https://matrix.example.org',
            accessToken: 'secret-token',
            userId: '@gateway:example.org',
            deviceId: 'GATEWAY1',
        },
        crypto: {
            useIndexedDB: false,
            databasePrefix: 'codever-test',
            allowInMemoryForTesting: true,
        },
        rooms: [{
            roomId: '!room:example.org',
            conversationId: 'conversation-1',
            cwd: 'C:\\repo',
            providerName: 'mock-provider',
        }],
        trustedDevices: [{
            deviceId: 'pwa-device-1',
            publicKey: keys.publicJwk,
            allowedRoomIds: ['!room:example.org'],
            allowedOperations: ['prompt', 'cancel', 'decision', 'session.settings'],
            matrixUserId: '@alice:example.org',
            matrixDeviceKeys: ['matrix-ed25519-key'],
        }],
        replayLedgerPath: join(directory, 'replay.jsonl'),
        allowInsecureLegacyForTesting: true,
    }
    await writeFile(
        config.replayLedgerPath,
        `${JSON.stringify({
            version: 1,
            kind: 'generation',
            generation: REPLAY_GENERATION,
        })}\n`,
        'utf8',
    )
    await writeFile(
        `${config.replayLedgerPath}.runtime-state.json`,
        `${JSON.stringify({
            version: 1,
            rooms: {
                '!room:example.org': {
                    revisionEpoch: REVISION_EPOCH,
                    replayGeneration: REPLAY_GENERATION,
                    stateVersion: 0,
                    currentSessionId: null,
                    appSessions: [{
                        id: 'app-session-1',
                        title: 'Existing session',
                        updatedAt: now - 1_000,
                        projectId: gatewayProjectIdentity('C:\\repo').id,
                        projectName: gatewayProjectIdentity('C:\\repo').name,
                        cwd: 'C:\\repo',
                        provider: 'mock-provider',
                        model: null,
                        reasoningEffort: null,
                        permissionMode: 'default',
                        providerSessionId: null,
                    }],
                    workspace: {
                        cwd: 'C:\\repo',
                        provider: 'mock-provider',
                        model: null,
                        permissionMode: 'default',
                    },
                },
            },
        })}\n`,
        'utf8',
    )
    return { keys, config, now }
}

async function signedPrompt(
    keys: Awaited<ReturnType<typeof generateDeviceKeyPair>>,
    now: number,
    sequence = 1,
    baseRevision = sequence - 1,
    sequenceEpoch = 'legacy-v1',
): Promise<SignedCommand> {
    const command: CodeverCommand = {
        kind: 'codever.command',
        version: 1,
        commandId: `command-${sequence}-${Math.random()}`,
        gatewayId: 'gateway-1',
        deviceId: 'pwa-device-1',
        sequenceEpoch,
        conversationId: 'conversation-1',
        revisionEpoch: REVISION_EPOCH,
        sequence,
        baseRevision,
        operation: 'prompt',
        issuedAt: now,
        expiresAt: now + 60_000,
        nonce: `0123456789abcdef-${sequence}-${Math.random()}`,
        payload: {
            operation: 'prompt',
            sessionId: 'app-session-1',
            text: 'hello from PWA',
        },
    }
    return signCommand(command, keys.privateKey, keys.keyId)
}

async function signedCancel(
    keys: Awaited<ReturnType<typeof generateDeviceKeyPair>>,
    now: number,
    sequence: number,
): Promise<SignedCommand> {
    const command: CodeverCommand = {
        kind: 'codever.command',
        version: 1,
        commandId: `cancel-${sequence}-${Math.random()}`,
        gatewayId: 'gateway-1',
        deviceId: 'pwa-device-1',
        sequenceEpoch: 'legacy-v1',
        conversationId: 'conversation-1',
        revisionEpoch: REVISION_EPOCH,
        sequence,
        baseRevision: sequence - 1,
        operation: 'cancel',
        issuedAt: now,
        expiresAt: now + 60_000,
        nonce: `fedcba9876543210-${sequence}-${Math.random()}`,
        payload: { operation: 'cancel', sessionId: 'app-session-1' },
    }
    return signCommand(command, keys.privateKey, keys.keyId)
}

function incomingSigned(signedCommand: SignedCommand, suffix = 'event'): MatrixIncomingEvent {
    return {
        roomId: '!room:example.org',
        eventId: `$${suffix}`,
        eventType: 'm.room.message',
        sender: '@alice:example.org',
        senderDeviceId: 'matrix-ed25519-key',
        encrypted: true,
        encryptedPayloadFingerprint: `ciphertext-${suffix}`,
        content: {
            msgtype: 'm.text',
            body: 'Codever command',
            [CODEVER_MATRIX_EXTENSION]: {
                version: 1,
                kind: 'signed_command',
                signed_command: signedCommand,
            },
        },
    }
}

function fakeTopicSession(dispatched: SessionInput[]): TopicSession {
    const sessionRecord = {
        conversationId: null as string | null,
        setConversationId(value: string | null) {
            this.conversationId = value
        },
    } as TopicSession['sessionRecord']
    return {
        dispatch: vi.fn(async (input: SessionInput) => {
            dispatched.push(input)
        }),
        receiveInput: vi.fn(),
        destroy: vi.fn(async () => undefined),
        state: 'idle',
        sessionRecord,
        channelPort: { close: vi.fn() } as unknown as TopicSession['channelPort'],
        getProgress: vi.fn(() => null),
        getDeliveryStatus: vi.fn(() => ({ deliveries: [] })),
        retryDelivery: vi.fn(async deliveryId => ({
            status: 'not_found' as const,
            deliveryId,
            message: 'not found',
        })),
    }
}

function directRoomRuntime(
    config: MatrixGatewayConfig['rooms'][number],
    session: TopicSession,
    includeDefaultSession = true,
) {
    const project = gatewayProjectIdentity(config.cwd)
    const record = {
        id: 'app-session-1',
        title: 'Existing session',
        updatedAt: 1,
        projectId: project.id,
        projectName: project.name,
        cwd: project.cwd,
        provider: config.providerName,
        model: config.model ?? null,
        reasoningEffort: null,
        permissionMode: 'default',
        providerSessionId: null,
        archivedAt: null,
    }
    return {
        config,
        capabilityProvider: null,
        workspace: {
            projectId: project.id,
            projectName: project.name,
            cwd: config.cwd,
            provider: config.providerName,
            model: config.model ?? null,
            reasoningEffort: null,
            permissionMode: 'default',
        },
        appSessions: new Map(includeDefaultSession
            ? [[record.id, {
                record,
                port: session.channelPort,
                session,
                capabilityProvider: null,
            }]]
            : []),
        archivedSessions: new Map(),
        revisionEpoch: REVISION_EPOCH,
        revisionEpochGeneration: 1,
        replayGeneration: REPLAY_GENERATION,
        stateVersion: 0,
    }
}

async function initializeDirectRuntime(
    runner: MatrixGatewayRunner,
    config: MatrixGatewayConfig,
): Promise<void> {
    const store = Reflect.get(runner, 'runtimeStateStore') as {
        initialize(
            rooms: MatrixGatewayConfig['rooms'],
            replayGeneration: string,
        ): Promise<void>
    }
    await store.initialize(config.rooms, REPLAY_GENERATION)
}

function fakeProvider(
    models: ReturnType<AgentProvider['getAvailableModels']> = [],
): AgentProvider {
    return {
        name: 'mock-provider',
        startQuery: vi.fn((): AgentQueryHandle => ({
            events: (async function* () {
                yield { kind: 'text' as const, text: 'agent response' }
                yield { kind: 'result' as const, status: 'success' as const }
            })(),
            interrupt: vi.fn(async () => undefined),
        })),
        isReady: vi.fn(() => true),
        getInitError: vi.fn(() => null),
        getAvailableModels: vi.fn(() => models),
        getAvailablePermissionModes: vi.fn(() => []),
    }
}

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'codever-matrix-daemon-'))
    temporaryDirectories.push(directory)
    return directory
}
