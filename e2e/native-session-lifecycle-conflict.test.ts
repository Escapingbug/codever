import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
    NATIVE_BRIDGE_LIMITS,
    type BridgeMethodParams,
    type CapabilityName,
    type ClientSnapshot,
    type HelloResult,
    type RequestMethod,
} from '@codever/native-bridge'
import {
    type CodeverCommand,
    type CommandPayload,
} from '@codever/protocol'
import {
    generateDeviceKeyPair,
    signCommand,
} from '@codever/security'
import {
    FileCommandReplayStore,
    RevisionConflictError,
    StrictMatrixCommandAuthorizer,
    type MatrixGatewayTrustedDevice,
} from '@/gateway/matrix'
import {
    NativeBridgeClient,
    OPTIONAL_NATIVE_CAPABILITIES,
    REQUIRED_NATIVE_CAPABILITIES,
} from '../apps/pwa/app/client/native/NativeBridgeClient'
import {
    acquireNativeRpcBridge,
    type NativeBridgePort,
} from '../apps/pwa/app/client/native/NativeRpcBridge'

const temporaryDirectories: string[] = []
const now = Date.now()

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory =>
        rm(directory, { recursive: true, force: true })))
})

describe('native session lifecycle revision recovery', () => {
    it('rebases a stale deletion and accepts a new session immediately afterwards', async () => {
        const directory = await temporaryDirectory()
        const first = await generateDeviceKeyPair()
        const native = await generateDeviceKeyPair()
        const policies: MatrixGatewayTrustedDevice[] = [
            trustedDevice('other-device', first.publicJwk, ['prompt']),
            trustedDevice(
                'native-device-1',
                native.publicJwk,
                ['session.delete', 'session.create'],
            ),
        ]
        const replayStore = new FileCommandReplayStore(join(directory, 'commands.jsonl'))
        const authorizer = new StrictMatrixCommandAuthorizer(
            'gateway-1',
            policies,
            replayStore,
        )
        await authorizer.initialize(now)

        // Another device advances the shared conversation while the native
        // client still has revision zero cached.
        await expect(authorizer.authorizeDelivery(
            await signedCommand(first, {
                deviceId: 'other-device',
                commandId: 'other-command-1',
                sequence: 1,
                baseRevision: 0,
                payload: {
                    operation: 'prompt',
                    sessionId: 'existing-session',
                    text: 'advance the shared revision',
                },
            }),
            commandContext('other-device'),
            now,
        )).resolves.toMatchObject({ duplicate: false, revision: 1 })

        const port = new LifecycleNativePort(authorizer, replayStore, native)
        const bridge = await acquireNativeRpcBridge(port)
        const hello = await bridge.hello({
            webBuild: 'session-lifecycle-e2e',
            requiredCapabilities: [],
            optionalCapabilities: [
                ...REQUIRED_NATIVE_CAPABILITIES,
                ...OPTIONAL_NATIVE_CAPABILITIES,
            ].map(name => ({ name, versions: [1] })),
        })
        const reviews: Array<string | null> = []
        const client = new NativeBridgeClient(bridge, hello, {
            onMessage() {},
            onStatus() {},
            onCommandReviewRequired(review) {
                reviews.push(review?.commandId ?? null)
            },
        })
        await client.ready

        const deletion = await within(
            client.send({
                operation: 'session.delete',
                sessionId: 'existing-session',
            }),
            5_000,
        )
        expect(port.failures).toEqual([])
        await expect(within(deletion.completion, 5_000)).resolves.toMatchObject({
            commandId: deletion.commandId,
            sequence: 1,
            revision: 2,
            outcome: 'succeeded',
            sessionId: 'existing-session',
        })

        const deletionAttempts = port.attempts.filter(
            attempt => attempt.operation === 'session.delete',
        )
        expect(deletionAttempts).toHaveLength(2)
        expect(deletionAttempts.map(attempt => attempt.baseRevision)).toEqual([0, 1])
        expect(new Set(deletionAttempts.map(attempt => attempt.commandId)).size).toBe(2)
        expect(new Set(deletionAttempts.map(attempt => attempt.operationId)).size).toBe(1)
        expect(new Set(deletionAttempts.map(attempt => attempt.idempotencyKey)).size).toBe(1)
        expect(deletionAttempts.map(attempt => attempt.sequence)).toEqual([1, 1])
        expect(port.conflicts).toEqual([{
            operation: 'session.delete',
            expectedRevision: 1,
            receivedBaseRevision: 0,
        }])
        expect(reviews).toEqual([])

        // The terminal deletion must no longer occupy the durable single-writer
        // slot. This is the user-visible regression that previously blocked
        // Create session with "The previous Codever action needs review".
        const creation = await within(
            client.send({
                operation: 'session.create',
                cwd: '/workspace/codever',
                projectName: 'codever',
            }),
            5_000,
        )
        await expect(within(creation.completion, 5_000)).resolves.toMatchObject({
            commandId: creation.commandId,
            sequence: 2,
            revision: 3,
            outcome: 'succeeded',
            sessionId: 'created-session',
        })
        expect(port.attempts.at(-1)).toMatchObject({
            operation: 'session.create',
            sequence: 2,
            baseRevision: 2,
        })
        expect(reviews).toEqual([])
        await expect(replayStore.getConversationRevision(
            'gateway-1',
            'conversation-1',
            'runtime-epoch-1',
        )).resolves.toBe(3)
        expect(port.failures).toEqual([])

        client.dispose()
    })
})

type RpcRequest = {
    jsonrpc: '2.0'
    id: string
    method: RequestMethod
    params: BridgeMethodParams[RequestMethod]
}

type PendingOperation = {
    operationId: string
    commandId: string
    idempotencyKey: string
    sequence: number
    baseRevision: number
    payload: CommandPayload
    submittedAt: number
}

type CommandAttempt = PendingOperation & {
    operation: CommandPayload['operation']
}

class LifecycleNativePort implements NativeBridgePort {
    onmessage: NativeBridgePort['onmessage'] = null
    readonly attempts: CommandAttempt[] = []
    readonly conflicts: Array<{
        operation: CommandPayload['operation']
        expectedRevision: number
        receivedBaseRevision: number
    }> = []
    readonly failures: string[] = []
    private knownRevision = 0
    private nextSequence = 1
    private nextIdentity = 1
    private nextCursor = 1

    constructor(
        private readonly authorizer: StrictMatrixCommandAuthorizer,
        private readonly replayStore: FileCommandReplayStore,
        private readonly keys: Awaited<ReturnType<typeof generateDeviceKeyPair>>,
    ) {}

    postMessage(message: string): void {
        const request = JSON.parse(message) as RpcRequest
        void this.respond(request).catch(error => {
            this.failures.push(error instanceof Error ? error.message : String(error))
        })
    }

    private async respond(request: RpcRequest): Promise<void> {
        switch (request.method) {
            case 'codever.bridge.hello':
                this.result(request, helloResult())
                return
            case 'codever.client.start':
                this.result(request, {
                    deviceId: 'native-device-1',
                    snapshot: snapshot(),
                })
                return
            case 'codever.events.subscribe':
                this.result(request, {
                    subscriptionId: 'subscription-1',
                    barrierCursor: 'cursor-barrier-1',
                    mode: 'replay',
                    events: [],
                })
                return
            case 'codever.events.activate':
            case 'codever.events.ack':
                this.result(request, {
                    subscriptionId: 'subscription-1',
                    throughCursor: request.params.throughCursor,
                })
                return
            case 'codever.events.unsubscribe':
                this.result(request, {
                    subscriptionId: 'subscription-1',
                    unsubscribed: true,
                })
                return
            case 'codever.command.send': {
                const operation: PendingOperation = {
                    operationId: `native-operation-${this.nextIdentity++}`,
                    commandId: `native-command-${this.nextIdentity++}`,
                    idempotencyKey: request.params.idempotencyKey,
                    sequence: this.nextSequence++,
                    baseRevision: this.knownRevision,
                    payload: request.params.payload as CommandPayload,
                    submittedAt: now + this.nextIdentity,
                }
                this.result(request, commandReceipt(operation, 'transmitting'))
                queueMicrotask(() => {
                    void this.execute(operation).catch(error => {
                        this.failures.push(error instanceof Error ? error.message : String(error))
                    })
                })
                return
            }
            default:
                throw new Error(`Unexpected native E2E method: ${request.method}`)
        }
    }

    private async execute(initial: PendingOperation): Promise<void> {
        let pending = initial
        let accepted: Awaited<ReturnType<StrictMatrixCommandAuthorizer['authorizeDelivery']>>
        while (true) {
            this.attempts.push({ ...pending, operation: pending.payload.operation })
            try {
                accepted = await this.authorizer.authorizeDelivery(
                    await signedCommand(this.keys, {
                        deviceId: 'native-device-1',
                        commandId: pending.commandId,
                        sequence: pending.sequence,
                        baseRevision: pending.baseRevision,
                        payload: pending.payload,
                    }),
                    commandContext('native-device-1'),
                    now,
                )
                break
            } catch (error) {
                if (!(error instanceof RevisionConflictError)) throw error
                this.conflicts.push({
                    operation: pending.payload.operation,
                    expectedRevision: error.expectedRevision,
                    receivedBaseRevision: error.receivedBaseRevision,
                })
                if (!isDesiredStateLifecycleOperation(pending.payload.operation)) throw error
                pending = {
                    ...pending,
                    commandId: `native-command-${this.nextIdentity++}`,
                    baseRevision: error.expectedRevision,
                }
                this.deliverCommand(commandView(pending, 'queued'))
            }
        }

        this.knownRevision = accepted.revision
        this.deliverCommand(commandView(pending, 'accepted', accepted.revision))
        const sessionId = pending.payload.operation === 'session.create'
            ? 'created-session'
            : 'sessionId' in pending.payload
                ? pending.payload.sessionId
                : undefined
        await this.replayStore.recordCommandResult(accepted.command, {
            revision: accepted.revision,
            outcome: 'succeeded',
            ...(sessionId === undefined ? {} : { sessionId }),
        }, 'certificate-native-device-1')
        this.deliverCommand({
            ...commandView(pending, 'succeeded', accepted.revision),
            completion: {
                commandId: pending.commandId,
                sequence: pending.sequence,
                revision: accepted.revision,
                outcome: 'succeeded',
                ...(sessionId === undefined ? {} : { sessionId }),
            },
        })
    }

    private deliverCommand(payload: Record<string, unknown>): void {
        const cursor = `cursor-${this.nextCursor++}`
        this.onmessage?.({
            data: JSON.stringify({
                jsonrpc: '2.0',
                method: 'codever.events.deliver',
                params: {
                    subscriptionId: 'subscription-1',
                    events: [{
                        schemaVersion: 1,
                        eventId: `event-${cursor}`,
                        cursor,
                        occurredAt: now + this.nextCursor,
                        type: 'command.changed',
                        payload,
                    }],
                },
            }),
        })
    }

    private result(request: RpcRequest, result: unknown): void {
        this.onmessage?.({
            data: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
        })
    }
}

function commandReceipt(operation: PendingOperation, state: 'transmitting') {
    return {
        operationId: operation.operationId,
        commandId: operation.commandId,
        idempotencyKey: operation.idempotencyKey,
        state,
        submittedAt: operation.submittedAt,
        updatedAt: operation.submittedAt,
        ...('sessionId' in operation.payload
            ? { sessionId: operation.payload.sessionId }
            : {}),
        sequence: operation.sequence,
    }
}

function commandView(
    operation: PendingOperation,
    state: 'queued' | 'accepted' | 'succeeded',
    revision?: number,
) {
    return {
        ...commandReceipt(operation, 'transmitting'),
        state,
        updatedAt: operation.submittedAt + 1,
        ...(revision === undefined ? {} : { revision }),
    }
}

function isDesiredStateLifecycleOperation(operation: CommandPayload['operation']): boolean {
    return operation === 'session.create'
        || operation === 'session.archive'
        || operation === 'session.restore'
        || operation === 'session.delete'
}

async function signedCommand(
    keys: Awaited<ReturnType<typeof generateDeviceKeyPair>>,
    input: {
        deviceId: string
        commandId: string
        sequence: number
        baseRevision: number
        payload: CommandPayload
    },
) {
    const command: CodeverCommand = {
        kind: 'codever.command',
        version: 1,
        commandId: input.commandId,
        gatewayId: 'gateway-1',
        deviceId: input.deviceId,
        sequenceEpoch: `certificate-${input.deviceId}`,
        conversationId: 'conversation-1',
        revisionEpoch: 'runtime-epoch-1',
        sequence: input.sequence,
        baseRevision: input.baseRevision,
        operation: input.payload.operation,
        issuedAt: now,
        expiresAt: now + 60_000,
        nonce: randomBytes(18).toString('base64url'),
        payload: input.payload,
    }
    return signCommand(command, keys.privateKey, keys.keyId)
}

function trustedDevice(
    deviceId: string,
    publicKey: JsonWebKey,
    allowedOperations: MatrixGatewayTrustedDevice['allowedOperations'],
): MatrixGatewayTrustedDevice {
    const matrixDeviceId = deviceId.toUpperCase()
    return {
        deviceId,
        deviceName: deviceId,
        publicKey,
        allowedRoomIds: ['!room:localhost'],
        allowedOperations,
        matrixUserId: `@${deviceId}:localhost`,
        matrixDeviceId,
        matrixDeviceKeys: [`${matrixDeviceId}-ed25519`],
        certificateExpiresAt: now + 60_000,
        sequenceEpoch: `certificate-${deviceId}`,
    }
}

function commandContext(deviceId: string) {
    return {
        roomId: '!room:localhost',
        conversationId: 'conversation-1',
        revisionEpoch: 'runtime-epoch-1',
        matrixSender: `@${deviceId}:localhost`,
        matrixDeviceKey: 'application-envelope',
        applicationDeviceId: deviceId,
    }
}

function helloResult(): HelloResult {
    const capabilities = Object.fromEntries(
        [...REQUIRED_NATIVE_CAPABILITIES, ...OPTIONAL_NATIVE_CAPABILITIES]
            .map(name => [name, { version: 1 }]),
    ) as Record<CapabilityName, { version: number }>
    return {
        protocolVersion: 1,
        bridgeSessionId: 'bridge-session-lifecycle-e2e',
        native: {
            runtimeVersion: '0.1.0',
            runtimeBuild: 'android-lifecycle-e2e',
            platform: 'android',
        },
        capabilities,
        limits: NATIVE_BRIDGE_LIMITS,
    }
}

function snapshot(): ClientSnapshot {
    return {
        schemaVersion: 1,
        deviceId: 'native-device-1',
        cursor: 'cursor-snapshot-1',
        generatedAt: now,
        lifecycle: { phase: 'ready', since: now },
        foregroundService: {
            required: true,
            active: true,
            notificationVisible: true,
        },
        trust: { state: 'unpaired' },
        commands: [],
    }
}

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'codever-lifecycle-e2e-'))
    temporaryDirectories.push(directory)
    return directory
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(
                    () => reject(new Error(`E2E operation exceeded ${timeoutMs}ms`)),
                    timeoutMs,
                )
            }),
        ])
    } finally {
        if (timeout !== undefined) clearTimeout(timeout)
    }
}
