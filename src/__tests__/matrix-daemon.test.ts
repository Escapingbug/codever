import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClientEvent, SyncState, type MatrixClient, type MatrixEvent } from 'matrix-js-sdk'
import type { CodeverCommand, SignedCommand } from '@codever/protocol'
import { generateDeviceKeyPair, signCommand } from '@codever/security'
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
            matrixSender: '@alice:example.org',
            matrixDeviceKey: 'matrix-ed25519-key',
        }, fixture.now)).rejects.toMatchObject({ code: 'replay' })
        await expect(restarted.authorizeDelivery(signed, {
            roomId: '!room:example.org',
            conversationId: 'conversation-1',
            matrixSender: '@alice:example.org',
            matrixDeviceKey: 'matrix-ed25519-key',
        }, fixture.now)).resolves.toMatchObject({
            duplicate: true,
            command: { commandId: signed.command.commandId },
        })
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
            await signedPrompt(fixture.keys, fixture.now, 1, 3),
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

        expect(dispatched).toHaveLength(1)
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
        const sendCommandResult = vi.fn(async (
            _room: MatrixGatewayConfig['rooms'][number],
            _deviceId: string,
            _commandId: string,
            _sequence: number,
            _revision: number,
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
                runtime: {
                    config: MatrixGatewayConfig['rooms'][number]
                    session: TopicSession
                },
                command: CodeverCommand,
                revision: number,
            ): void
        }

        internals.scheduleExecution(
            incomingSigned(signed),
            { config: fixture.config.rooms[0]!, session },
            signed.command,
            1,
        )

        await vi.waitFor(() => expect(sendCommandResult).toHaveBeenCalledOnce())
        expect(sendCommandResult.mock.calls[0]?.[3]).toBe(signed.command.sequence)
        expect(sendCommandResult.mock.calls[0]?.[5]).toBe('succeeded')
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
                runtime: {
                    config: MatrixGatewayConfig['rooms'][number]
                    session: TopicSession
                },
                command: CodeverCommand,
                revision: number,
                beforeExecute?: Promise<unknown>,
            ): void
        }

        internals.scheduleExecution(
            incomingSigned(signed),
            { config: fixture.config.rooms[0]!, session },
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
        tampered.command.payload = { operation: 'prompt', text: 'malicious' }
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
    return { keys, config, now }
}

async function signedPrompt(
    keys: Awaited<ReturnType<typeof generateDeviceKeyPair>>,
    now: number,
    sequence = 1,
    baseRevision = sequence - 1,
): Promise<SignedCommand> {
    const command: CodeverCommand = {
        kind: 'codever.command',
        version: 1,
        commandId: `command-${sequence}-${Math.random()}`,
        gatewayId: 'gateway-1',
        deviceId: 'pwa-device-1',
        conversationId: 'conversation-1',
        sequence,
        baseRevision,
        operation: 'prompt',
        issuedAt: now,
        expiresAt: now + 60_000,
        nonce: `0123456789abcdef-${sequence}-${Math.random()}`,
        payload: { operation: 'prompt', text: 'hello from PWA' },
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
        conversationId: 'conversation-1',
        sequence,
        baseRevision: sequence - 1,
        operation: 'cancel',
        issuedAt: now,
        expiresAt: now + 60_000,
        nonce: `fedcba9876543210-${sequence}-${Math.random()}`,
        payload: { operation: 'cancel' },
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
    return {
        dispatch: vi.fn(async (input: SessionInput) => {
            dispatched.push(input)
        }),
        receiveInput: vi.fn(),
        destroy: vi.fn(async () => undefined),
        state: 'idle',
        sessionRecord: {} as TopicSession['sessionRecord'],
        channelPort: {} as TopicSession['channelPort'],
        getProgress: vi.fn(() => null),
        getDeliveryStatus: vi.fn(() => ({ deliveries: [] })),
        retryDelivery: vi.fn(async deliveryId => ({
            status: 'not_found' as const,
            deliveryId,
            message: 'not found',
        })),
    }
}

function fakeProvider(): AgentProvider {
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
        getAvailableModels: vi.fn(() => []),
        getAvailablePermissionModes: vi.fn(() => []),
    }
}

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'codever-matrix-daemon-'))
    temporaryDirectories.push(directory)
    return directory
}
