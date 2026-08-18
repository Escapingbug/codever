import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    ClientEvent,
    MatrixScheduler,
    SyncState,
    type MatrixClient,
    type MatrixEvent,
} from 'matrix-js-sdk'
import {
    CODEVER_MATRIX_APPLICATION_CONTROL_EVENT_TYPE,
    CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE,
    CODEVER_MATRIX_SESSION_DIRECTORY_EVENT_TYPE,
    CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE,
    capabilityRenewalRequestSchema,
    type CodeverCommand,
    type SignedCommand,
} from '@codever/protocol'
import {
    exportDeviceKeyPair,
    generateDeviceKeyPair,
    InMemoryReplayStore,
    openSecureEnvelope,
    openSecureEnvelopeBundle,
    openMatrixStateEnvelope,
    openMatrixTimelineEnvelope,
    base64UrlDecode,
    sealSecureEnvelope,
    signCommand,
} from '@codever/security'
import type { AgentProvider, AgentQueryHandle } from '@/providers/provider'
import type { TopicSession } from '@/bridge/channelPort'
import type { SessionInput } from '@/runtime/semantic'
import {
    normalizeDeclarativeExtensionConfig,
    SessionExtensionRegistry,
    type SessionExtensionProvider,
} from '@/runtime/sessionExtensions'
import {
    CODEVER_MATRIX_EXTENSION,
    type MatrixIncomingEvent,
    type MatrixApplicationControlEventRequest,
    type MatrixApplicationStateEventRequest,
    type MatrixApplicationTimelineEventRequest,
    type MatrixSendEventRequest,
    type MatrixSendEventResult,
} from '@/channel/matrix'
import {
    FileCommandReplayStore,
    createGatewayMatrixScheduler,
    gatewayProjectIdentity,
    MatrixGatewayRunner,
    MatrixJsSdkGatewayClient,
    StrictMatrixCommandAuthorizer,
    validateMatrixGatewayConfig,
    watchMatrixSyncHealth,
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

    it('recovers accepted commands and executes a durable retry authenticated by a fresh app envelope', async () => {
        const fixture = await securityFixture()
        const signed = await signedPrompt(fixture.keys, fixture.now)
        const context = {
            roomId: '!room:example.org',
            conversationId: 'conversation-1',
            revisionEpoch: REVISION_EPOCH,
            matrixSender: '@alice:example.org',
            matrixDeviceKey: 'matrix-ed25519-key',
            applicationDeviceId: 'pwa-device-1',
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
            0,
        )
        await expect(
            restarted.authorizeDelivery(unknownExpired, {
                ...context,
                applicationDeviceId: undefined,
            }, afterExpiry),
        ).rejects.toMatchObject({ code: 'expired' })
        const durableRetry = await restarted.authorizeDelivery(
            unknownExpired,
            context,
            afterExpiry,
        )
        expect(durableRetry).toMatchObject({
            duplicate: false,
            revision: 2,
        })
        expect(durableRetry).not.toHaveProperty('terminal')
        await expect(
            restarted.authorizeDelivery(unknownExpired, context, afterExpiry),
        ).resolves.toMatchObject({
            duplicate: true,
            revision: 2,
            command: { commandId: unknownExpired.command.commandId },
        })

        const fresh = await signedPrompt(fixture.keys, afterExpiry, 3, 2)
        await expect(
            restarted.authorizeDelivery(fresh, context, afterExpiry),
        ).resolves.toMatchObject({ duplicate: false, revision: 3 })
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
            fixture.config.trustedDevices.map(device => ({
                ...device,
                sequenceEpoch: 'replacement-gateway-key',
            })),
            new FileCommandReplayStore(fixture.config.replayLedgerPath),
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
    it('starts without a trusted device and publishes state only after pairing provisioning', async () => {
        const fixture = await securityFixture()
        const client = new FakeMatrixGatewayClient()
        let activeDevices: MatrixGatewayConfig['trustedDevices'] = []
        fixture.config.trustedDevices = []
        const runner = new MatrixGatewayRunner(fixture.config, {
            client,
            sessionFactory: () => fakeTopicSession([]),
            listTrustedDevices: async () => activeDevices,
            now: () => fixture.now,
        })

        await runner.start()
        expect(runner.getState()).toBe('running')
        expect(client.sent).toHaveLength(0)
        expect(client.state.size).toBe(0)

        activeDevices = [{
            deviceId: 'new-device',
            publicKey: fixture.keys.publicJwk,
            allowedRoomIds: ['!room:example.org'],
            allowedOperations: ['prompt', 'session.create'],
            matrixUserId: '@new-device:example.org',
            matrixDeviceId: 'NEW_MATRIX_DEVICE',
            matrixDeviceKeys: ['new-matrix-ed25519-key'],
            certificateExpiresAt: Date.now() + 60_000,
            sequenceEpoch: 'new-device-certificate',
        }]
        await runner.provisionCurrentState()

        expect(client.sent).toHaveLength(1)
        expect(client.sent[0]?.transactionId).toBe('codever.session.root.app-session-1')
        expect(client.state.size).toBe(3)
        expect([...client.state.keys()].some(key =>
            key.includes(CODEVER_MATRIX_SESSION_DIRECTORY_EVENT_TYPE)
        )).toBe(true)
        const publishedStateTypes = [...client.state.values()].map(value => value.eventType)
        expect(publishedStateTypes).toEqual([
            CODEVER_MATRIX_SESSION_DIRECTORY_EVENT_TYPE,
            CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE,
            CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE,
        ])
        expect(client.state.has(JSON.stringify([
            '!room:example.org',
            CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE,
            'gateway-1',
        ]))).toBe(true)
        expect(client.state.has(JSON.stringify([
            '!room:example.org',
            CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE,
            'app-session-1',
        ]))).toBe(true)
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
            sequenceEpoch: 'certificate-pwa-1',
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
            commandId: 'invite-device',
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

    it('renews an authenticated legacy device certificate outside the command queue', async () => {
        const fixture = await securityFixture()
        fixture.config.trustedDevices[0]!.allowedOperations = [
            ...(fixture.config.trustedDevices[0]!.allowedOperations ?? []),
            'device.invite',
        ]
        const client = new FakeMatrixGatewayClient()
        const createDeviceInvitation = vi.fn(async () => ({
            pairingLink: 'codever://pair?data=renewed-signed-offer',
            expiresAt: fixture.now + 60_000,
        }))
        const rejected: unknown[] = []
        const runner = new MatrixGatewayRunner(fixture.config, {
            client,
            createDeviceInvitation,
            now: () => fixture.now,
            sessionFactory: () => fakeTopicSession([]),
            onRejected: (_event, error) => rejected.push(error),
        })
        await runner.start()
        const request = capabilityRenewalRequestSchema.parse({
            version: 1,
            kind: 'capability_renewal_request',
            request_id: 'renewal-1',
            gateway_id: fixture.config.gatewayId,
            device_id: 'pwa-device-1',
            certificate_id: 'certificate-pwa-1',
            requested_operations: ['session.delete'],
            issued_at: fixture.now,
            expires_at: fixture.now + 60_000,
        })
        const envelope = await sealSecureEnvelope({
            plaintext: {
                msgtype: 'm.notice',
                body: 'Encrypted Codever device permission renewal',
                [CODEVER_MATRIX_EXTENSION]: request,
            },
            senderPrivateKey: fixture.keys.privateKey,
            recipientPublicKey: fixture.gatewayKeys.publicKey,
            gatewayId: fixture.config.gatewayId,
            conversationId: fixture.config.rooms[0]!.conversationId,
            direction: 'device_to_gateway',
            senderDeviceId: 'pwa-device-1',
            recipientDeviceId: fixture.config.gatewayId,
            senderKeyId: fixture.keys.keyId,
            recipientKeyId: fixture.gatewayKeys.keyId,
            now: fixture.now,
        })

        client.emit({
            roomId: fixture.config.rooms[0]!.roomId,
            eventId: '$capability-renewal-request',
            eventType: CODEVER_MATRIX_APPLICATION_CONTROL_EVENT_TYPE,
            sender: '@alice:example.org',
            encrypted: false,
            content: {
                msgtype: 'm.notice',
                body: 'Encrypted Codever device permission renewal',
                [CODEVER_MATRIX_EXTENSION]: {
                    version: 1,
                    kind: 'secure_envelope',
                    secure_envelope: envelope,
                },
            },
        })

        await vi.waitFor(() => expect(createDeviceInvitation).toHaveBeenCalledOnce())
        expect(createDeviceInvitation).toHaveBeenCalledWith({
            requestedByDeviceId: 'pwa-device-1',
            commandId: 'capability-renewal.renewal-1',
        })
        await vi.waitFor(() => expect(
            client.sent.some(candidate =>
                candidate.transactionId.includes('codever.capability-renewal.renewal-1'),
            ) || rejected.length > 0,
        ).toBe(true))
        expect(rejected).toEqual([])
        const response = client.sent.find(candidate =>
            candidate.transactionId.includes('codever.capability-renewal.renewal-1'),
        )!
        const extension = response.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
        const opened = await openSecureEnvelope(extension.secure_envelope, {
            recipientPrivateKey: fixture.keys.privateKey,
            senderPublicKey: fixture.gatewayKeys.publicKey,
            expected: {
                gatewayId: fixture.config.gatewayId,
                conversationId: fixture.config.rooms[0]!.conversationId,
                direction: 'gateway_to_device',
                senderDeviceId: fixture.config.gatewayId,
                recipientDeviceId: 'pwa-device-1',
                senderKeyId: fixture.gatewayKeys.keyId,
                recipientKeyId: fixture.keys.keyId,
            },
            replayStore: new InMemoryReplayStore(),
            now: Date.now(),
        })
        expect(opened.plaintext).toMatchObject({
            [CODEVER_MATRIX_EXTENSION]: {
                version: 1,
                kind: 'capability_renewal_offer',
                request_id: 'renewal-1',
                certificate_id: 'certificate-pwa-1',
                pairing_link: 'codever://pair?data=renewed-signed-offer',
            },
        })
        expect(rejected).toEqual([])
        await runner.stop()
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
        const extensionProvider: SessionExtensionProvider = {
            descriptor: {
                id: 'has-privacy',
                name: 'HaS privacy',
                description: 'Local prompt privacy',
                version: '1',
                settings: [{
                    id: 'contextId',
                    type: 'text',
                    label: 'Privacy context',
                    required: true,
                }],
            },
            normalizeConfig(config) {
                return normalizeDeclarativeExtensionConfig(this.descriptor, config)
            },
            create() {
                throw new Error('sessionFactory owns this test runtime')
            },
        }
        const runner = new MatrixGatewayRunner(fixture.config, {
            client: new FakeMatrixGatewayClient(),
            sessionExtensionRegistry: new SessionExtensionRegistry([extensionProvider]),
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
            sequenceEpoch: 'certificate-pwa-1',
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
                extensions: [{
                    id: 'has-privacy',
                    config: { contextId: ' metapp-system-1 ' },
                }],
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
                extensions: [{
                    id: 'has-privacy',
                    config: { contextId: 'metapp-system-1' },
                }],
            }),
        ])
        const advertisedState = await (runner as unknown as {
            gatewayStateSnapshot(roomRuntime: typeof runtime): Promise<{
                sessions: Array<{ extensions: Array<{ id: string }> }>
                capabilities: { sessionExtensions: Array<{ id: string }> }
            }>
        }).gatewayStateSnapshot(runtime)
        expect(advertisedState.sessions[0]?.extensions).toEqual([
            expect.objectContaining({ id: 'has-privacy' }),
        ])
        expect(advertisedState.capabilities.sessionExtensions).toEqual([
            expect.objectContaining({ id: 'has-privacy' }),
        ])
        const persistedExtensions = (Reflect.get(runner, 'runtimeStateStore') as {
            getRoom(roomId: string): { appSessions: Array<{ extensions: unknown[] }> }
        }).getRoom(fixture.config.rooms[0]!.roomId).appSessions[0]?.extensions
        expect(persistedExtensions).toEqual([{
            id: 'has-privacy',
            config: { contextId: 'metapp-system-1' },
        }])

        await expect((runner as unknown as {
            execute(
                roomRuntime: typeof runtime,
                command: CodeverCommand,
            ): Promise<{ sessionId: string | null }>
        }).execute(runtime, {
            ...command,
            commandId: 'create-missing-extension',
            sequence: 2,
            nonce: '0123456789abcdef-missing-extension',
            payload: {
                operation: 'session.create',
                extensions: [{ id: 'not-installed' }],
            },
        })).rejects.toThrow('not installed')
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
            sequenceEpoch: 'certificate-pwa-1',
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
        await expect(execute(command('session.archive', 2))).resolves.toEqual({
            sessionId: 'app-session-1',
        })
        expect(session.destroy).toHaveBeenCalledTimes(1)

        await expect(execute(command('session.restore', 3))).resolves.toEqual({
            sessionId: 'app-session-1',
        })
        expect(runtime.archivedSessions.size).toBe(0)
        expect(runtime.appSessions.get('app-session-1')?.record.archivedAt).toBeNull()
        const restoredRuntime = runtime.appSessions.get('app-session-1')
        await expect(execute(command('session.restore', 4))).resolves.toEqual({
            sessionId: 'app-session-1',
        })
        expect(runtime.appSessions.get('app-session-1')).toBe(restoredRuntime)

        await expect(execute(command('session.delete', 5))).resolves.toEqual({
            sessionId: 'app-session-1',
            nativeRevisionPublished: true,
        })
        expect(runtime.appSessions.size).toBe(0)
        expect(runtime.archivedSessions.size).toBe(0)
        const runtimeStateStore = Reflect.get(runner, 'runtimeStateStore') as {
            getRoom(roomId: string): { appSessions: unknown[] }
        }
        expect(runtimeStateStore.getRoom(fixture.config.rooms[0]!.roomId).appSessions)
            .toEqual([])
        await expect(execute(command('session.delete', 6))).resolves.toEqual({
            sessionId: 'app-session-1',
            nativeRevisionPublished: false,
        })
        expect(runtimeStateStore.getRoom(fixture.config.rooms[0]!.roomId).appSessions)
            .toEqual([])
    })

    it('does not hold a durable lifecycle command result behind Matrix publication', async () => {
        const fixture = await securityFixture()
        const session = fakeTopicSession([])
        const runtime = directRoomRuntime(fixture.config.rooms[0]!, session)
        Reflect.set(runtime.appSessions.get('app-session-1')!.record, 'matrixThreadRootEventId', '$root')
        const runner = new MatrixGatewayRunner(fixture.config, {
            client: new FakeMatrixGatewayClient(),
            sessionFactory: () => session,
            now: () => fixture.now,
        })
        await initializeDirectRuntime(runner, fixture.config)
        let finishLifecycle!: (value: MatrixSendEventResult) => void
        const lifecycleDelivery = new Promise<MatrixSendEventResult>(resolve => {
            finishLifecycle = resolve
        })
        const sendNativeContent = vi.fn((..._arguments: unknown[]) => lifecycleDelivery)
        Reflect.set(runner, 'secureContent', { sendNativeContent })

        const execution = (runner as unknown as {
            execute(
                roomRuntime: typeof runtime,
                command: CodeverCommand,
            ): Promise<{ sessionId: string | null }>
        }).execute(runtime, {
            kind: 'codever.command',
            version: 1,
            commandId: 'archive-with-slow-matrix',
            gatewayId: fixture.config.gatewayId,
            deviceId: 'pwa-device-1',
            sequenceEpoch: 'certificate-pwa-1',
            conversationId: fixture.config.rooms[0]!.conversationId,
            revisionEpoch: REVISION_EPOCH,
            sequence: 1,
            baseRevision: 0,
            operation: 'session.archive',
            issuedAt: fixture.now,
            expiresAt: fixture.now + 60_000,
            nonce: '0123456789abcdef-slow-lifecycle',
            payload: { operation: 'session.archive', sessionId: 'app-session-1' },
        })

        let timeout: ReturnType<typeof setTimeout> | undefined
        const result = await Promise.race([
            execution,
            new Promise<never>((_, reject) => {
                timeout = setTimeout(
                    () => reject(new Error('Lifecycle command result waited for Matrix publication.')),
                    250,
                )
            }),
        ]).finally(() => clearTimeout(timeout))
        expect(result).toEqual({ sessionId: 'app-session-1' })
        await vi.waitFor(() => expect(sendNativeContent).toHaveBeenCalledOnce())
        expect(sendNativeContent.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
            kind: 'session_lifecycle',
            state: 'archived',
            source_command_id: 'archive-with-slow-matrix',
        }))
        finishLifecycle({ eventId: '$lifecycle' })
        await vi.waitFor(() => {
            const tasks = Reflect.get(runner, 'executionTasks') as Set<Promise<void>>
            expect(tasks.size).toBe(0)
        })
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
            activity: { phase: 'idle' },
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

        client.emit(await incomingSecureSigned(
            await signedPrompt(fixture.keys, fixture.now),
            fixture.keys,
            fixture.gatewayKeys,
            fixture.now,
            'signed-prompt',
        ))
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
        const firstGatewayState = client.state.get(JSON.stringify([
            '!room:example.org',
            CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE,
            'gateway-1',
        ]))!
        const opened = await openNativeState(firstGatewayState, fixture.keys, gatewayKeys)
        expect(opened).toMatchObject({
            kind: 'gateway_state',
            revision: 0,
            revision_epoch: REVISION_EPOCH,
            revision_epoch_generation: 1,
            state_version: 1,
            workspace: {
                provider: 'mock-provider',
                permission_mode: 'default',
            },
            capabilities: {
                models: [],
                permission_modes: [{ id: 'default', name: 'Default' }],
                can_create_session: true,
                can_select_session: false,
            },
        })
        await runner.syncState()
        const secondGatewayState = client.state.get(JSON.stringify([
            '!room:example.org',
            CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE,
            'gateway-1',
        ]))!
        expect(secondGatewayState.eventId).not.toBe(firstGatewayState.eventId)
        await expect(openNativeState(secondGatewayState, fixture.keys, gatewayKeys))
            .resolves.toMatchObject({ state_version: 2 })
        await runner.stop()
    })

    it('republishes an unchanged session directory inside a rotated replay epoch', async () => {
        const fixture = await securityFixture()
        const client = new FakeMatrixGatewayClient()
        const createRunner = () => new MatrixGatewayRunner(fixture.config, {
            client,
            now: () => fixture.now,
            sessionFactory: () => fakeTopicSession([]),
        })
        const gatewayStateKey = JSON.stringify([
            '!room:example.org',
            CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE,
            'gateway-1',
        ])

        const firstRunner = createRunner()
        await firstRunner.start()
        const firstGatewayRequest = client.state.get(gatewayStateKey)!
        const firstGateway = await openNativeState(
            firstGatewayRequest,
            fixture.keys,
            fixture.gatewayKeys,
        ) as {
            revision_epoch: string
            revision_epoch_generation: number
            session_directory: {
                generation: number
                slot: number
                state_key_prefix: string
                digest: string
            }
        }
        const firstDirectoryRequest = client.state.get(JSON.stringify([
            '!room:example.org',
            CODEVER_MATRIX_SESSION_DIRECTORY_EVENT_TYPE,
            `${firstGateway.session_directory.state_key_prefix}.`
                + `${firstGateway.session_directory.slot}.0`,
        ]))!
        const firstStateKey = await openNativeStateKey(
            firstGatewayRequest,
            fixture.keys,
            fixture.gatewayKeys,
        )
        await expect(openNativeState(
            firstDirectoryRequest,
            fixture.keys,
            fixture.gatewayKeys,
            firstStateKey,
        )).resolves.toMatchObject({
            revision_epoch: firstGateway.revision_epoch,
            revision_epoch_generation: 1,
            directory_digest: firstGateway.session_directory.digest,
        })
        await firstRunner.stop()

        await writeFile(
            fixture.config.replayLedgerPath,
            `${JSON.stringify({
                version: 2,
                kind: 'generation',
                generation: 'replay-generation-2',
            })}\n`,
            'utf8',
        )

        const secondRunner = createRunner()
        await secondRunner.start()
        const secondGatewayRequest = client.state.get(gatewayStateKey)!
        const secondGateway = await openNativeState(
            secondGatewayRequest,
            fixture.keys,
            fixture.gatewayKeys,
        ) as typeof firstGateway
        expect(secondGateway.revision_epoch_generation).toBe(2)
        expect(secondGateway.revision_epoch).not.toBe(firstGateway.revision_epoch)
        expect(secondGateway.session_directory.digest).toBe(firstGateway.session_directory.digest)
        expect(secondGateway.session_directory.generation)
            .toBeGreaterThan(firstGateway.session_directory.generation)

        const secondDirectoryRequest = client.state.get(JSON.stringify([
            '!room:example.org',
            CODEVER_MATRIX_SESSION_DIRECTORY_EVENT_TYPE,
            `${secondGateway.session_directory.state_key_prefix}.`
                + `${secondGateway.session_directory.slot}.0`,
        ]))!
        const secondStateKey = await openNativeStateKey(
            secondGatewayRequest,
            fixture.keys,
            fixture.gatewayKeys,
        )
        await expect(openNativeState(
            secondDirectoryRequest,
            fixture.keys,
            fixture.gatewayKeys,
            secondStateKey,
        )).resolves.toMatchObject({
            revision_epoch: secondGateway.revision_epoch,
            revision_epoch_generation: 2,
            directory_generation: secondGateway.session_directory.generation,
            directory_digest: secondGateway.session_directory.digest,
        })
        await secondRunner.stop()
    })

    it('refreshes signed Gateway liveness without advancing semantic state', async () => {
        const fixture = await securityFixture()
        const gatewayKeys = await generateDeviceKeyPair()
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
        fixture.config.gatewayHeartbeatIntervalMs = 5
        const client = new FakeMatrixGatewayClient()
        const runner = new MatrixGatewayRunner(fixture.config, {
            client,
            sessionFactory: () => fakeTopicSession([]),
        })

        await runner.start()
        const key = JSON.stringify([
            '!room:example.org',
            CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE,
            'gateway-1',
        ])
        const first = client.state.get(key)!
        const firstState = await openNativeState(first, fixture.keys, gatewayKeys)
        await vi.waitFor(() => expect(client.state.get(key)?.eventId).not.toBe(first.eventId))
        const heartbeat = await openNativeState(client.state.get(key)!, fixture.keys, gatewayKeys)

        expect(heartbeat).toMatchObject({
            state_version: firstState.state_version,
            revision: firstState.revision,
        })
        expect(heartbeat.updated_at).toBeGreaterThanOrEqual(firstState.updated_at as number)
        await runner.stop()
    })

    it('restores persisted sessions, provider session, workspace, epoch, and state version before first sync', async () => {
        const fixture = await securityFixture()
        const gatewayKeys = await generateDeviceKeyPair()
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
                version: 2,
                rooms: {
                    '!room:example.org': {
                        revisionEpoch: REVISION_EPOCH,
                        revisionEpochGeneration: 1,
                        replayGeneration: REPLAY_GENERATION,
                        stateVersion: 4,
                        currentSessionId: 'app-session-1',
                        deletedSessionIds: [],
                        appSessions: [{
                            id: 'app-session-1',
                            title: 'Restored work',
                            createdAt: fixture.now - 1_000,
                            updatedAt: fixture.now - 1_000,
                            matrixThreadRootEventId: null,
                            projectId: gatewayProjectIdentity('D:\\restored').id,
                            projectName: gatewayProjectIdentity('D:\\restored').name,
                            cwd: 'D:\\restored',
                            provider: 'mock-provider',
                            model: null,
                            reasoningEffort: null,
                            permissionMode: 'default',
                            providerSessionId: 'provider-session-1',
                            archivedAt: null,
                            extensions: [],
                        }],
                        workspace: {
                            projectId: gatewayProjectIdentity('D:\\restored').id,
                            projectName: gatewayProjectIdentity('D:\\restored').name,
                            cwd: 'D:\\restored',
                            provider: 'mock-provider',
                            model: null,
                            reasoningEffort: null,
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
        const rootRequest = client.sent.find(request =>
            request.transactionId === 'codever.session.root.app-session-1'
        )!
        const openedRoot = await openNativeTimeline(rootRequest, fixture.keys, gatewayKeys)
        expect(openedRoot.plaintext).toMatchObject({
            [CODEVER_MATRIX_EXTENSION]: {
                kind: 'session_root',
                session_id: 'app-session-1',
                title: 'Restored work',
            },
        })
        const gatewayState = client.state.get(JSON.stringify([
            '!room:example.org',
            CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE,
            'gateway-1',
        ]))!
        await expect(openNativeState(gatewayState, fixture.keys, gatewayKeys))
            .resolves.toMatchObject({
                kind: 'gateway_state',
                revision_epoch: REVISION_EPOCH,
                revision_epoch_generation: 1,
                state_version: 5,
                workspace: { project: { cwd: 'D:\\restored' } },
            })
        const sessionState = client.state.get(JSON.stringify([
            '!room:example.org',
            CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE,
            'app-session-1',
        ]))!
        const stateKey = await openNativeStateKey(gatewayState, fixture.keys, gatewayKeys)
        expect((sessionState.content as Record<string, unknown>).timeline_key_ring_bundle)
            .toBeUndefined()
        await expect(openNativeState(sessionState, fixture.keys, gatewayKeys, stateKey))
            .resolves.toMatchObject({
                kind: 'session_state',
                session: {
                    session_id: 'app-session-1',
                    thread_root_event_id: expect.any(String),
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
        client.onStartEvent = await incomingSecureSigned(
            await signedPrompt(fixture.keys, fixture.now),
            fixture.keys,
            fixture.gatewayKeys,
            fixture.now,
            'startup-prompt',
        )
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

    it('executes an expired durable session creation resent in a fresh authenticated envelope', async () => {
        const fixture = await securityFixture()
        const gatewayKeys = await generateDeviceKeyPair()
        const afterExpiry = fixture.now + 2 * 60_000
        fixture.config.applicationSecurity = {
            gatewayDeviceId: fixture.config.gatewayId,
            gatewayKeyPair: await exportDeviceKeyPair(gatewayKeys),
            envelopeReplayLedgerPath: join(
                await temporaryDirectory(),
                'expired-command-envelope-replay.json',
            ),
        }
        fixture.config.trustedDevices[0]!.certificateExpiresAt = Date.now() + 60_000
        fixture.config.trustedDevices[0]!.sequenceEpoch = 'certificate-pwa-1'
        fixture.config.trustedDevices[0]!.allowedOperations = [
            ...(fixture.config.trustedDevices[0]!.allowedOperations ?? []),
            'session.create',
        ]
        const client = new FakeMatrixGatewayClient()
        const runner = new MatrixGatewayRunner(fixture.config, {
            client,
            now: () => afterExpiry,
            providerFactory: () => fakeProvider([]),
        })
        await runner.start()
        const runtime = (Reflect.get(runner, 'rooms') as Map<string, {
            capabilityProvider: AgentProvider | null
        }>).get('!room:example.org')!
        runtime.capabilityProvider = fakeProvider([])

        const projectDirectory = await temporaryDirectory()
        const expired = await signedSessionCreate(
            fixture.keys,
            fixture.now,
            1,
            0,
            'certificate-pwa-1',
            projectDirectory,
        )
        client.emit(await incomingSecureSigned(
            expired,
            fixture.keys,
            gatewayKeys,
            afterExpiry,
            'expired-session-create',
        ))

        await vi.waitFor(() => expect(client.sent.some(request =>
            request.transactionId.includes(
                `codever.command.result.${expired.command.commandId}`,
            )
        )).toBe(true))
        const resultRequest = client.sent.find(request =>
            request.transactionId.includes(
                `codever.command.result.${expired.command.commandId}`,
            ),
        )!
        const resultExtension = resultRequest.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
        const openedResult = await openSecureEnvelope(resultExtension.secure_envelope, {
            recipientPrivateKey: fixture.keys.privateKey,
            senderPublicKey: gatewayKeys.publicKey,
            expected: {
                gatewayId: fixture.config.gatewayId,
                conversationId: fixture.config.rooms[0]!.conversationId,
                direction: 'gateway_to_device',
                senderDeviceId: fixture.config.gatewayId,
                recipientDeviceId: 'pwa-device-1',
                senderKeyId: gatewayKeys.keyId,
                recipientKeyId: fixture.keys.keyId,
            },
            replayStore: new InMemoryReplayStore(),
            now: Date.now(),
        })
        expect(openedResult.plaintext).toMatchObject({
            [CODEVER_MATRIX_EXTENSION]: {
                kind: 'command_result',
                command_id: expired.command.commandId,
                sequence: 1,
                revision: 1,
                outcome: 'succeeded',
                session_id: expect.any(String),
            },
        })

        await runner.stop()
    })

    it('keeps cancel responsive while a previously accepted prompt is still running', async () => {
        const fixture = await securityFixture()
        const gatewayKeys = await generateDeviceKeyPair()
        fixture.config.applicationSecurity = {
            gatewayDeviceId: fixture.config.gatewayId,
            gatewayKeyPair: await exportDeviceKeyPair(gatewayKeys),
            envelopeReplayLedgerPath: join(
                await temporaryDirectory(),
                'cancel-envelope-replay.json',
            ),
        }
        fixture.config.trustedDevices[0]!.certificateExpiresAt = Date.now() + 60_000
        fixture.config.trustedDevices[0]!.sequenceEpoch = 'certificate-pwa-1'
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

        client.emit(await incomingSecureSigned(
            await signedPrompt(
                fixture.keys,
                fixture.now,
                1,
                0,
                'certificate-pwa-1',
            ),
            fixture.keys,
            gatewayKeys,
            fixture.now,
            'prompt',
        ))
        await vi.waitFor(() => expect(dispatched).toHaveLength(1))
        client.emit(await incomingSecureSigned(
            await signedCancel(
                fixture.keys,
                fixture.now,
                2,
                'certificate-pwa-1',
            ),
            fixture.keys,
            gatewayKeys,
            fixture.now,
            'cancel',
        ))

        await vi.waitFor(() => expect(dispatched).toHaveLength(2))
        expect(dispatched[1]).toMatchObject({ kind: 'cancel', reason: 'user' })
        await vi.waitFor(() => expect(client.sent.some(request =>
            request.transactionId === `codever.gateway.revision.${REVISION_EPOCH}.2`
        )).toBe(true))
        const revisionRequest = client.sent.find(request =>
            request.transactionId === `codever.gateway.revision.${REVISION_EPOCH}.2`
        )!
        const openedRevision = await openNativeTimeline(
            revisionRequest,
            fixture.keys,
            gatewayKeys,
        )
        expect(openedRevision.plaintext).toMatchObject({
            [CODEVER_MATRIX_EXTENSION]: {
                kind: 'gateway_revision',
                revision: 2,
                revision_epoch: REVISION_EPOCH,
                source_command_id: expect.stringContaining('cancel-2-'),
            },
        })
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
        client.emit(await incomingSecureSigned(
            tampered,
            fixture.keys,
            fixture.gatewayKeys,
            fixture.now,
            'tampered',
        ))
        client.emit(incomingSigned(signed, 'unencrypted-legacy-command'))

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
            ...await incomingSecureSigned(
                await signedPrompt(fixture.keys, fixture.now),
                fixture.keys,
                fixture.gatewayKeys,
                fixture.now,
                'own-echo',
            ),
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

        client.emit(await incomingSecureSigned(
            await signedPrompt(fixture.keys, fixture.now),
            fixture.keys,
            fixture.gatewayKeys,
            fixture.now,
            'revoked-device',
        ))
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

        client.emit(await incomingSecureSigned(
            await signedPrompt(fixture.keys, fixture.now),
            fixture.keys,
            fixture.gatewayKeys,
            fixture.now,
            'daemon-prompt',
        ))

        await vi.waitFor(() => expect(provider.startQuery).toHaveBeenCalledOnce())
        expect(provider.startQuery).toHaveBeenCalledWith(
            {
                parts: [{ type: 'text', text: 'hello from PWA' }],
            },
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
    it('leaves delivery ordering to the durable Codever scheduler instead of the SDK message FIFO', () => {
        const message = {
            getType: () => 'm.room.message',
            hasAssociation: () => false,
        } as unknown as MatrixEvent

        expect(MatrixScheduler.QUEUE_MESSAGES(message)).toBe('message')
        expect(createGatewayMatrixScheduler().queueAlgorithm(message)).toBeNull()
    })

    it('rehydrates a persisted thread root that was omitted from initial sync', async () => {
        const rootEvent = { getId: () => '$persisted-root' } as unknown as MatrixEvent
        const createThread = vi.fn()
        const room = {
            findEventById: vi.fn(() => undefined),
            getThread: vi.fn(() => undefined),
            createThread,
        }
        const sdk = {
            getRoom: vi.fn(() => room),
            fetchRoomEvent: vi.fn(async () => ({
                event_id: '$persisted-root',
                type: 'm.room.message',
                sender: '@gateway:example.org',
                origin_server_ts: 1,
                content: { msgtype: 'm.notice', body: 'session root' },
            })),
            getEventMapper: vi.fn(() => (event: { room_id?: string }) => {
                expect(event.room_id).toBe('!room:example.org')
                return rootEvent
            }),
        } as unknown as MatrixClient
        const client = new MatrixJsSdkGatewayClient(sdk)

        await client.prepareRoomThread('!room:example.org', '$persisted-root')

        expect(sdk.fetchRoomEvent).toHaveBeenCalledWith(
            '!room:example.org',
            '$persisted-root',
        )
        expect(createThread).toHaveBeenCalledWith(
            '$persisted-root',
            rootEvent,
            [],
            false,
        )
    })

    it('waits for an already trusted Matrix device to become visible after initial sync', async () => {
        const visibleDevice = { getFingerprint: () => 'matrix-ed25519-key' }
        const crypto = {
            getUserDeviceInfo: vi.fn()
                .mockResolvedValueOnce(new Map())
                .mockResolvedValueOnce(new Map([
                    ['@alice:example.org', new Map([['PWA1', visibleDevice]])],
                ])),
            setDeviceVerified: vi.fn(async () => undefined),
        }
        const sdk = {
            getCrypto: vi.fn(() => crypto),
        } as unknown as MatrixClient
        const onLog = vi.fn()
        const client = new MatrixJsSdkGatewayClient(sdk, 30_000, onLog, {
            trustedDeviceVisibilityTimeoutMs: 1_000,
            trustedDeviceVisibilityRetryMs: 0,
        })

        await client.pinTrustedDevices([{
            matrixUserId: '@alice:example.org',
            matrixDeviceId: 'PWA1',
            matrixDeviceKeys: ['matrix-ed25519-key'],
        }])

        expect(crypto.getUserDeviceInfo).toHaveBeenCalledTimes(2)
        expect(crypto.setDeviceVerified).toHaveBeenCalledWith(
            '@alice:example.org',
            'PWA1',
            true,
        )
        expect(onLog).toHaveBeenCalledWith(
            '[matrix-sdk] waiting for 1 trusted Matrix device(s) to become visible',
        )
    })

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
            http: {
                authedRequest: vi.fn(async () => ({ event_id: '$control' })),
            },
            sendTyping: vi.fn(async () => ({})),
            decryptEventIfNeeded: vi.fn(async () => undefined),
        } as unknown as MatrixClient
        const client = new MatrixJsSdkGatewayClient(sdk)

        await expect(client.start()).rejects.toThrow('crypto must be initialized')
        await client.initializeCrypto({
            backend: 'indexeddb',
            databasePrefix: 'codever-device',
            storageKey: new Uint8Array(32),
        })
        await client.start()
        await client.waitUntilReady()
        await client.assertRoomEncrypted('!room:example.org')
        await client.pinTrustedDevices([{
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
        await expect(client.sendApplicationTimelineEvent({
            roomId: '!room:example.org',
            eventType: 'm.room.message',
            content: {
                msgtype: 'm.notice',
                body: 'invalid timeline',
                [CODEVER_MATRIX_EXTENSION]: {
                    version: 2,
                    kind: 'session_root',
                },
            },
            transactionId: 'rejected-timeline',
        })).rejects.toThrow('must contain a Codever timeline envelope')
        await expect(client.sendApplicationControlEvent({
            roomId: '!room:example.org',
            eventType: 'io.codever.secure_control.v1',
            content: {
                msgtype: 'm.notice',
                body: 'plaintext result',
                [CODEVER_MATRIX_EXTENSION]: {
                    version: 1,
                    kind: 'command_result',
                    command_id: 'must-not-send',
                },
            },
            transactionId: 'rejected-control',
        })).rejects.toThrow('must contain a Codever secure envelope')
        expect(sdk.http.authedRequest).not.toHaveBeenCalled()
        await client.sendApplicationTimelineEvent({
            roomId: '!room:example.org',
            eventType: 'm.room.message',
            content: {
                msgtype: 'm.notice',
                body: 'Encrypted Codever timeline event',
                [CODEVER_MATRIX_EXTENSION]: {
                    version: 2,
                    kind: 'timeline_envelope',
                    timeline_envelope: { envelope: {}, signature: {} },
                    timeline_key_ring_bundle: { bundle: {}, signature: {} },
                },
            },
            transactionId: 'timeline/txn',
        })
        expect(sdk.http.authedRequest).toHaveBeenCalledWith(
            'PUT',
            '/rooms/!room%3Aexample.org/send/m.room.message/timeline%2Ftxn',
            undefined,
            expect.objectContaining({ body: 'Encrypted Codever timeline event' }),
        )
        await client.sendApplicationControlEvent({
            roomId: '!room:example.org',
            eventType: 'io.codever.secure_control.v1',
            content: {
                msgtype: 'm.notice',
                body: 'Encrypted Codever message',
                [CODEVER_MATRIX_EXTENSION]: {
                    version: 1,
                    kind: 'secure_envelope',
                    secure_envelope: { envelope: {}, signature: {} },
                },
            },
            transactionId: 'control/txn',
        })
        expect(sdk.http.authedRequest).toHaveBeenCalledWith(
            'PUT',
            '/rooms/!room%3Aexample.org/send/io.codever.secure_control.v1/control%2Ftxn',
            undefined,
            expect.objectContaining({ body: 'Encrypted Codever message' }),
        )
        await client.setApplicationRoomState({
            roomId: '!room:example.org',
            eventType: CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE,
            stateKey: 'session-1',
            content: {
                version: 2,
                kind: 'state_envelope',
                state_envelope: {
                    envelope: {
                        eventType: CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE,
                        stateKey: 'session-1',
                    },
                    signature: {},
                },
            },
        })
        expect(sdk.http.authedRequest).toHaveBeenCalledWith(
            'PUT',
            '/rooms/!room%3Aexample.org/state/io.codever.session.current.v2/session-1',
            undefined,
            expect.objectContaining({ kind: 'state_envelope' }),
            expect.any(Object),
        )
        await client.setApplicationRoomState({
            roomId: '!room:example.org',
            eventType: CODEVER_MATRIX_SESSION_DIRECTORY_EVENT_TYPE,
            stateKey: 'codever.directory.1.0',
            content: {
                version: 2,
                kind: 'state_envelope',
                state_envelope: {
                    envelope: {
                        eventType: CODEVER_MATRIX_SESSION_DIRECTORY_EVENT_TYPE,
                        stateKey: 'codever.directory.1.0',
                    },
                    signature: {},
                },
            },
        })
        expect(sdk.http.authedRequest).toHaveBeenCalledWith(
            'PUT',
            '/rooms/!room%3Aexample.org/state/io.codever.session.directory.v2/codever.directory.1.0',
            undefined,
            expect.objectContaining({ kind: 'state_envelope' }),
            expect.any(Object),
        )
        await expect(client.setApplicationRoomState({
            roomId: '!room:example.org',
            eventType: CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE,
            stateKey: 'gateway-1',
            content: {
                version: 2,
                kind: 'state_envelope',
                state_envelope: {
                    envelope: {
                        eventType: CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE,
                        stateKey: 'gateway-1',
                    },
                    signature: {},
                },
            },
        })).rejects.toThrow('must contain a Codever state envelope')
        expect(sdk.sendMessage).toHaveBeenCalledTimes(1)
        expect(sdk.http.authedRequest).toHaveBeenCalledTimes(4)
        await client.stop()
        expect(sdk.stopClient).toHaveBeenCalledOnce()
    })

    it('detects a silent sync stall and resets the deadline after progress', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-08-05T00:00:00.000Z'))
        try {
            let syncListener: ((state: SyncState) => void) | undefined
            const sdk = {
                getSyncState: vi.fn(() => SyncState.Syncing),
                on: vi.fn((event: ClientEvent, listener: (state: SyncState) => void) => {
                    if (event === ClientEvent.Sync) syncListener = listener
                }),
                off: vi.fn(),
            } as unknown as MatrixClient
            const onStalled = vi.fn()
            const stop = watchMatrixSyncHealth(sdk, {
                stallTimeoutMs: 120_000,
                checkIntervalMs: 10_000,
            }, onStalled)

            await vi.advanceTimersByTimeAsync(110_000)
            expect(onStalled).not.toHaveBeenCalled()
            syncListener?.(SyncState.Syncing)
            await vi.advanceTimersByTimeAsync(110_000)
            expect(onStalled).not.toHaveBeenCalled()
            await vi.advanceTimersByTimeAsync(10_000)

            expect(onStalled).toHaveBeenCalledOnce()
            expect(onStalled.mock.calls[0]?.[0]).toMatchObject({
                message: 'Matrix sync made no progress for 120000ms (state=SYNCING)',
            })
            expect(sdk.off).toHaveBeenCalledWith(ClientEvent.Sync, syncListener)
            stop()
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('Matrix gateway configuration', () => {
    it('requires application-layer security unless a test explicitly opts out', async () => {
        const fixture = await securityFixture()
        Reflect.deleteProperty(fixture.config, 'applicationSecurity')

        expect(() => validateMatrixGatewayConfig(fixture.config)).toThrow(
            'Application-layer Matrix security is required',
        )
    })

    it('forbids accidental in-memory production crypto', async () => {
        const fixture = await securityFixture()
        fixture.config.crypto = {
            backend: 'memory',
            databasePrefix: 'codever-test',
            allowInMemoryForTesting: false,
        } as unknown as MatrixGatewayConfig['crypto']

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
    readonly state = new Map<string, MatrixApplicationStateEventRequest & { eventId: string }>()
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

    async sendApplicationTimelineEvent(
        request: MatrixApplicationTimelineEventRequest,
    ): Promise<MatrixSendEventResult> {
        this.sent.push(structuredClone(request))
        return { eventId: `$outgoing-${++this.nextEventId}` }
    }

    async sendApplicationControlEvent(
        request: MatrixApplicationControlEventRequest,
    ): Promise<MatrixSendEventResult> {
        this.sent.push(structuredClone(request) as unknown as MatrixSendEventRequest)
        return { eventId: `$outgoing-${++this.nextEventId}` }
    }

    async setApplicationRoomState(
        request: MatrixApplicationStateEventRequest,
    ): Promise<MatrixSendEventResult> {
        const eventId = `$state-${++this.nextEventId}`
        this.state.set(
            JSON.stringify([request.roomId, request.eventType, request.stateKey]),
            { ...structuredClone(request), eventId },
        )
        return { eventId }
    }

    async setTyping(): Promise<void> {}

    emit(event: MatrixIncomingEvent): void {
        this.listener?.(event)
    }
}

async function securityFixture() {
    const keys = await generateDeviceKeyPair()
    const gatewayKeys = await generateDeviceKeyPair()
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
            backend: 'memory',
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
            matrixDeviceId: 'PWA1',
            matrixDeviceKeys: ['matrix-ed25519-key'],
            certificateExpiresAt: Date.now() + 60 * 60_000,
            sequenceEpoch: 'certificate-pwa-1',
        }],
        replayLedgerPath: join(directory, 'replay.jsonl'),
        applicationSecurity: {
            gatewayDeviceId: 'gateway-1',
            gatewayKeyPair: await exportDeviceKeyPair(gatewayKeys),
            envelopeReplayLedgerPath: join(directory, 'envelope-replay.json'),
        },
    }
    await writeFile(
        config.replayLedgerPath,
        `${JSON.stringify({
            version: 2,
            kind: 'generation',
            generation: REPLAY_GENERATION,
        })}\n`,
        'utf8',
    )
    await writeFile(
        `${config.replayLedgerPath}.runtime-state.json`,
        `${JSON.stringify({
            version: 2,
            rooms: {
                '!room:example.org': {
                    revisionEpoch: REVISION_EPOCH,
                    revisionEpochGeneration: 1,
                    replayGeneration: REPLAY_GENERATION,
                    stateVersion: 0,
                    currentSessionId: null,
                    deletedSessionIds: [],
                    appSessions: [{
                        id: 'app-session-1',
                        title: 'Existing session',
                        createdAt: now - 1_000,
                        updatedAt: now - 1_000,
                        matrixThreadRootEventId: null,
                        projectId: gatewayProjectIdentity('C:\\repo').id,
                        projectName: gatewayProjectIdentity('C:\\repo').name,
                        cwd: 'C:\\repo',
                        provider: 'mock-provider',
                        model: null,
                        reasoningEffort: null,
                        permissionMode: 'default',
                        providerSessionId: null,
                        archivedAt: null,
                        extensions: [],
                    }],
                    workspace: {
                        projectId: gatewayProjectIdentity('C:\\repo').id,
                        projectName: gatewayProjectIdentity('C:\\repo').name,
                        cwd: 'C:\\repo',
                        provider: 'mock-provider',
                        model: null,
                        reasoningEffort: null,
                        permissionMode: 'default',
                    },
                },
            },
        })}\n`,
        'utf8',
    )
    return { keys, gatewayKeys, config, now }
}

async function signedPrompt(
    keys: Awaited<ReturnType<typeof generateDeviceKeyPair>>,
    now: number,
    sequence = 1,
    baseRevision = sequence - 1,
    sequenceEpoch = 'certificate-pwa-1',
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
    sequenceEpoch = 'certificate-pwa-1',
): Promise<SignedCommand> {
    const command: CodeverCommand = {
        kind: 'codever.command',
        version: 1,
        commandId: `cancel-${sequence}-${Math.random()}`,
        gatewayId: 'gateway-1',
        deviceId: 'pwa-device-1',
        sequenceEpoch,
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

async function signedSessionCreate(
    keys: Awaited<ReturnType<typeof generateDeviceKeyPair>>,
    now: number,
    sequence: number,
    baseRevision: number,
    sequenceEpoch = 'certificate-pwa-1',
    cwd = 'C:\\repo',
): Promise<SignedCommand> {
    const command: CodeverCommand = {
        kind: 'codever.command',
        version: 1,
        commandId: `session-create-${sequence}-${Math.random()}`,
        gatewayId: 'gateway-1',
        deviceId: 'pwa-device-1',
        sequenceEpoch,
        conversationId: 'conversation-1',
        revisionEpoch: REVISION_EPOCH,
        sequence,
        baseRevision,
        operation: 'session.create',
        issuedAt: now,
        expiresAt: now + 60_000,
        nonce: `0123456789abcdef-create-${sequence}-${Math.random()}`,
        payload: {
            operation: 'session.create',
            cwd,
            projectName: 'repo',
        },
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

async function incomingSecureSigned(
    signedCommand: SignedCommand,
    deviceKeys: Awaited<ReturnType<typeof generateDeviceKeyPair>>,
    gatewayKeys: Awaited<ReturnType<typeof generateDeviceKeyPair>>,
    now: number,
    suffix: string,
): Promise<MatrixIncomingEvent> {
    const envelope = await sealSecureEnvelope({
        plaintext: {
            msgtype: 'm.notice',
            body: 'Encrypted Codever command',
            [CODEVER_MATRIX_EXTENSION]: {
                version: 1,
                kind: 'signed_command',
                signed_command: signedCommand,
            },
        },
        senderPrivateKey: deviceKeys.privateKey,
        recipientPublicKey: gatewayKeys.publicKey,
        gatewayId: 'gateway-1',
        conversationId: 'conversation-1',
        direction: 'device_to_gateway',
        senderDeviceId: 'pwa-device-1',
        recipientDeviceId: 'gateway-1',
        senderKeyId: deviceKeys.keyId,
        recipientKeyId: gatewayKeys.keyId,
        now,
    })
    return {
        roomId: '!room:example.org',
        eventId: `$secure-${suffix}`,
        eventType: CODEVER_MATRIX_APPLICATION_CONTROL_EVENT_TYPE,
        sender: '@alice:example.org',
        encrypted: false,
        content: {
            msgtype: 'm.notice',
            body: 'Encrypted Codever command',
            [CODEVER_MATRIX_EXTENSION]: {
                version: 1,
                kind: 'secure_envelope',
                secure_envelope: envelope,
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
                activity: { phase: 'idle' },
            }]]
            : []),
        archivedSessions: new Map(),
        deletedSessionIds: new Set<string>(),
        revisionEpoch: REVISION_EPOCH,
        revisionEpochGeneration: 1,
        replayGeneration: REPLAY_GENERATION,
        stateVersion: 0,
    }
}

async function openNativeTimeline(
    request: MatrixSendEventRequest,
    recipient: Awaited<ReturnType<typeof generateDeviceKeyPair>>,
    gateway: Awaited<ReturnType<typeof generateDeviceKeyPair>>,
) {
    const extension = request.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
    const openedGrant = await openSecureEnvelopeBundle(
        extension.timeline_key_ring_bundle,
        {
            recipientPrivateKey: recipient.privateKey,
            senderPublicKey: gateway.publicKey,
            expected: {
                gatewayId: 'gateway-1',
                conversationId: 'conversation-1',
                direction: 'gateway_to_device',
                senderDeviceId: 'gateway-1',
                recipientDeviceId: 'pwa-device-1',
                senderKeyId: gateway.keyId,
                recipientKeyId: recipient.keyId,
            },
            replayStore: new InMemoryReplayStore(),
        },
    )
    const grant = openedGrant.plaintext as {
        active_epoch_id: string
        epochs: Array<{ epoch_id: string; key: string }>
    }
    const active = grant.epochs.find(epoch => epoch.epoch_id === grant.active_epoch_id)!
    const signed = extension.timeline_envelope as {
        envelope: { sessionId?: string; threadRootEventId?: string }
    }
    return openMatrixTimelineEnvelope(extension.timeline_envelope, {
        timelineKey: base64UrlDecode(active.key),
        gatewayPublicKey: gateway.publicKey,
        expected: {
            gatewayId: 'gateway-1',
            conversationId: 'conversation-1',
            roomId: '!room:example.org',
            epochId: active.epoch_id,
            ...(signed.envelope.sessionId ? { sessionId: signed.envelope.sessionId } : {}),
            ...(signed.envelope.threadRootEventId
                ? { threadRootEventId: signed.envelope.threadRootEventId }
                : {}),
        },
    })
}

async function openNativeState(
    request: MatrixApplicationStateEventRequest,
    recipient: Awaited<ReturnType<typeof generateDeviceKeyPair>>,
    gateway: Awaited<ReturnType<typeof generateDeviceKeyPair>>,
    knownKey?: Uint8Array,
) {
    const content = request.content as {
        state_envelope: {
            envelope: { epochId: string; stateVersion: number }
        }
        timeline_key_ring_bundle?: unknown
    }
    const key = knownKey ?? await openNativeStateKey(request, recipient, gateway)
    return openMatrixStateEnvelope(content.state_envelope, {
        timelineKey: key,
        gatewayPublicKey: gateway.publicKey,
        expected: {
            gatewayId: 'gateway-1',
            conversationId: 'conversation-1',
            roomId: request.roomId,
            eventType: request.eventType,
            stateKey: request.stateKey,
            epochId: content.state_envelope.envelope.epochId,
            stateVersion: content.state_envelope.envelope.stateVersion,
        },
    })
}

async function openNativeStateKey(
    request: MatrixApplicationStateEventRequest,
    recipient: Awaited<ReturnType<typeof generateDeviceKeyPair>>,
    gateway: Awaited<ReturnType<typeof generateDeviceKeyPair>>,
): Promise<Uint8Array> {
    const content = request.content as {
        state_envelope: { envelope: { epochId: string } }
        timeline_key_ring_bundle?: unknown
    }
    if (!content.timeline_key_ring_bundle) {
        throw new Error('Gateway Room State key ring is missing')
    }
    const openedGrant = await openSecureEnvelopeBundle(
        content.timeline_key_ring_bundle,
        {
            recipientPrivateKey: recipient.privateKey,
            senderPublicKey: gateway.publicKey,
            expected: {
                gatewayId: 'gateway-1',
                conversationId: 'conversation-1',
                direction: 'gateway_to_device',
                senderDeviceId: 'gateway-1',
                recipientDeviceId: 'pwa-device-1',
                senderKeyId: gateway.keyId,
                recipientKeyId: recipient.keyId,
            },
            replayStore: new InMemoryReplayStore(),
        },
    )
    const grant = openedGrant.plaintext as {
        epochs: Array<{ epoch_id: string; key: string }>
    }
    const epoch = grant.epochs.find(candidate =>
        candidate.epoch_id === content.state_envelope.envelope.epochId,
    )!
    return base64UrlDecode(epoch.key)
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
    const secureContent = Reflect.get(runner, 'secureContent') as {
        initialize(now?: number): Promise<void>
    }
    await secureContent.initialize()
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
