import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodeverCommand } from '@codever/protocol'
import {
    exportDeviceKeyPair,
    generateDeviceKeyPair,
    InMemoryReplayStore,
    openSecureEnvelope,
    signCommand,
} from '@codever/security'
import {
    CODEVER_MATRIX_EXTENSION,
    type MatrixSendEventRequest,
    type MatrixTransport,
} from '@/channel/matrix'
import {
    FileCommandReplayStore,
    FileMatrixDeliveryOutbox,
    GatewaySecureContentLayer,
    StrictMatrixCommandAuthorizer,
    type MatrixGatewayTrustedDevice,
} from '@/gateway/matrix'

const temporaryDirectories: string[] = []
const now = Date.now()

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(directory =>
            rm(directory, { recursive: true, force: true }),
        ),
    )
})

describe('multi-device Matrix collaboration', () => {
    it('fans out independently, rewrites edit targets, and stops revoked recipients immediately', async () => {
        const directory = await temporaryDirectory()
        const gateway = await generateDeviceKeyPair()
        const first = await generateDeviceKeyPair()
        const second = await generateDeviceKeyPair()
        const firstPolicy = trusted('device-a', 'Alice phone', first.publicJwk, 'MATRIX_A')
        const secondPolicy = trusted('device-b', 'Bob laptop', second.publicJwk, 'MATRIX_B')
        let active: MatrixGatewayTrustedDevice[] = [firstPolicy, secondPolicy]
        const layer = new GatewaySecureContentLayer(
            'gateway-1',
            {
                gatewayDeviceId: 'gateway-1',
                gatewayKeyPair: await exportDeviceKeyPair(gateway),
                envelopeReplayLedgerPath: join(directory, 'envelopes.json'),
            },
            active,
            async () => active,
        )
        await layer.initialize(now)
        const sent: MatrixSendEventRequest[] = []
        let failSecondEditOnce = true
        const transport: MatrixTransport = {
            async sendEncryptedRoomEvent(request) {
                sent.push(request)
                if (
                    request.transactionId.startsWith('logical-edit.')
                    && envelopeRecipient(request) === 'device-b'
                    && failSecondEditOnce
                ) {
                    failSecondEditOnce = false
                    throw new Error('temporary device-b edit failure')
                }
                return { eventId: `$event-${sent.length}` }
            },
        }
        const room = {
            roomId: '!room:localhost',
            conversationId: 'conversation-1',
            cwd: 'C:\\repo',
            providerName: 'test',
        }
        const secureTransport = layer.transportForRoom(room, transport)

        const original = await secureTransport.sendEncryptedRoomEvent({
            roomId: room.roomId,
            eventType: 'm.room.message',
            transactionId: 'logical-send',
            content: {
                msgtype: 'm.text',
                body: 'shared answer',
                [CODEVER_MATRIX_EXTENSION]: { version: 1, kind: 'message' },
            },
        })
        expect(sent).toHaveLength(2)
        expect(new Set(sent.map(item => item.transactionId)).size).toBe(2)
        const originalA = sent.find(item => envelopeRecipient(item) === 'device-a')!
        const originalB = sent.find(item => envelopeRecipient(item) === 'device-b')!
        const physicalA = `$event-${sent.indexOf(originalA) + 1}`
        const physicalB = `$event-${sent.indexOf(originalB) + 1}`
        expect(original.eventId).toBe(physicalA)
        await expect(openFor(originalA, first, gateway, 'device-a'))
            .resolves.toMatchObject({
                body: 'shared answer',
                [CODEVER_MATRIX_EXTENSION]: { active_device_count: 2 },
            })
        await expect(openFor(originalB, second, gateway, 'device-b'))
            .resolves.toMatchObject({
                body: 'shared answer',
                [CODEVER_MATRIX_EXTENSION]: { active_device_count: 2 },
            })

        await expect(secureTransport.sendEncryptedRoomEvent({
            roomId: room.roomId,
            eventType: 'm.room.message',
            transactionId: 'logical-edit',
            content: {
                msgtype: 'm.text',
                body: '* edited answer',
                'm.relates_to': { rel_type: 'm.replace', event_id: original.eventId },
                'm.new_content': {
                    msgtype: 'm.text',
                    body: 'edited answer',
                    [CODEVER_MATRIX_EXTENSION]: {
                        version: 1,
                        kind: 'message',
                        replaces_event_id: original.eventId,
                    },
                },
                [CODEVER_MATRIX_EXTENSION]: {
                    version: 1,
                    kind: 'message',
                    replaces_event_id: original.eventId,
                },
            },
        })).resolves.toBeDefined()
        await layer.retryPendingForRoom(room, transport)
        const editAttempts = sent.filter(item => item.transactionId.startsWith('logical-edit.'))
        const editARequests = editAttempts.filter(item => envelopeRecipient(item) === 'device-a')
        const editBRequests = editAttempts.filter(item => envelopeRecipient(item) === 'device-b')
        expect(editARequests).toHaveLength(1)
        expect(editBRequests).toHaveLength(2)
        expect(new Set(editBRequests.map(item => item.transactionId))).toHaveLength(1)
        const editA = editARequests[0]!
        const editB = editBRequests.at(-1)!
        const firstEdit = await openFor(editA, first, gateway, 'device-a')
        const secondEdit = await openFor(editB, second, gateway, 'device-b')
        expect(firstEdit['m.relates_to']).toMatchObject({ event_id: physicalA })
        expect(secondEdit['m.relates_to']).toMatchObject({ event_id: physicalB })
        expect(
            (secondEdit['m.new_content'] as Record<string, unknown>)[CODEVER_MATRIX_EXTENSION],
        ).toMatchObject({ replaces_event_id: physicalB })

        active = [firstPolicy]
        await secureTransport.sendEncryptedRoomEvent({
            roomId: room.roomId,
            eventType: 'm.room.message',
            transactionId: 'after-revoke',
            content: {
                msgtype: 'm.text',
                body: 'after revoke',
                [CODEVER_MATRIX_EXTENSION]: { version: 1, kind: 'message' },
            },
        })
        expect(sent).toHaveLength(6)
        const afterRevoke = await openFor(sent[5]!, first, gateway, 'device-a')
        expect(afterRevoke[CODEVER_MATRIX_EXTENSION]).toMatchObject({
            active_device_count: 1,
        })
    })

    it('returns partial fan-out success, retries only the missing recipient, and downgrades edits for a newly joined device', async () => {
        const directory = await temporaryDirectory()
        const gateway = await generateDeviceKeyPair()
        const first = await generateDeviceKeyPair()
        const second = await generateDeviceKeyPair()
        const third = await generateDeviceKeyPair()
        const firstPolicy = trusted('device-a', 'Alice phone', first.publicJwk, 'MATRIX_A')
        const secondPolicy = trusted('device-b', 'Bob laptop', second.publicJwk, 'MATRIX_B')
        const thirdPolicy = trusted('device-c', 'Carol tablet', third.publicJwk, 'MATRIX_C')
        let active: MatrixGatewayTrustedDevice[] = [firstPolicy, secondPolicy]
        const layer = new GatewaySecureContentLayer(
            'gateway-1',
            {
                gatewayDeviceId: 'gateway-1',
                gatewayKeyPair: await exportDeviceKeyPair(gateway),
                envelopeReplayLedgerPath: join(directory, 'envelopes.json'),
            },
            active,
            async () => active,
        )
        await layer.initialize(now)
        const sent: MatrixSendEventRequest[] = []
        const eventIds = new Map<string, string>()
        let failSecondOnce = true
        const transport: MatrixTransport = {
            async sendEncryptedRoomEvent(request) {
                sent.push(request)
                if (envelopeRecipient(request) === 'device-b' && failSecondOnce) {
                    failSecondOnce = false
                    throw new Error('temporary device-b delivery failure')
                }
                const existing = eventIds.get(request.transactionId)
                if (existing) return { eventId: existing }
                const eventId = `$physical-${eventIds.size + 1}`
                eventIds.set(request.transactionId, eventId)
                return { eventId }
            },
        }
        const room = {
            roomId: '!room:localhost',
            conversationId: 'conversation-1',
            cwd: 'C:\\repo',
            providerName: 'test',
        }
        const secureTransport = layer.transportForRoom(room, transport)
        const originalRequest: MatrixSendEventRequest = {
            roomId: room.roomId,
            eventType: 'm.room.message',
            transactionId: 'logical-retry',
            content: {
                msgtype: 'm.text',
                body: 'shared retry',
                [CODEVER_MATRIX_EXTENSION]: { version: 1, kind: 'message' },
            },
        }

        const original = await secureTransport.sendEncryptedRoomEvent(originalRequest)
        await vi.waitFor(() => expect(eventIds).toHaveLength(2))
        const attemptsByRecipient = sent.reduce<Record<string, number>>((counts, request) => {
            const recipient = envelopeRecipient(request)!
            counts[recipient] = (counts[recipient] ?? 0) + 1
            return counts
        }, {})
        expect(attemptsByRecipient).toEqual({ 'device-a': 1, 'device-b': 2 })
        const secondTransactions = sent
            .filter(request => envelopeRecipient(request) === 'device-b')
            .map(request => request.transactionId)
        expect(new Set(secondTransactions)).toHaveLength(1)
        expect(eventIds).toHaveLength(2)

        active = [firstPolicy, secondPolicy, thirdPolicy]
        await secureTransport.sendEncryptedRoomEvent({
            roomId: room.roomId,
            eventType: 'm.room.message',
            transactionId: 'logical-edit-after-join',
            content: {
                msgtype: 'm.text',
                body: '* updated',
                'm.relates_to': { rel_type: 'm.replace', event_id: original.eventId },
                'm.new_content': {
                    msgtype: 'm.text',
                    body: 'updated',
                    [CODEVER_MATRIX_EXTENSION]: {
                        version: 1,
                        kind: 'message',
                        replaces_event_id: original.eventId,
                    },
                },
                [CODEVER_MATRIX_EXTENSION]: {
                    version: 1,
                    kind: 'message',
                    replaces_event_id: original.eventId,
                },
            },
        })
        const thirdEditRequest = sent
            .slice(-3)
            .find(request => envelopeRecipient(request) === 'device-c')!
        const thirdEdit = await openFor(thirdEditRequest, third, gateway, 'device-c')
        expect(thirdEdit).not.toHaveProperty('m.relates_to')
        expect(thirdEdit[CODEVER_MATRIX_EXTENSION]).not.toHaveProperty('replaces_event_id')
        expect(
            (thirdEdit['m.new_content'] as Record<string, unknown>)[CODEVER_MATRIX_EXTENSION],
        ).not.toHaveProperty('replaces_event_id')
    })

    it('persists collaboration/result gaps and recovers only the missing command recipient after restart', async () => {
        const directory = await temporaryDirectory()
        const gateway = await generateDeviceKeyPair()
        const first = await generateDeviceKeyPair()
        const second = await generateDeviceKeyPair()
        const policies = [
            trusted('device-a', 'Alice phone', first.publicJwk, 'MATRIX_A'),
            trusted('device-b', 'Bob laptop', second.publicJwk, 'MATRIX_B'),
        ]
        let firstActive: MatrixGatewayTrustedDevice[] = policies
        const security = {
            gatewayDeviceId: 'gateway-1',
            gatewayKeyPair: await exportDeviceKeyPair(gateway),
            envelopeReplayLedgerPath: join(directory, 'envelopes.json'),
        }
        const room = {
            roomId: '!room:localhost',
            conversationId: 'conversation-1',
            cwd: 'C:\\repo',
            providerName: 'test',
        }
        const firstLayer = new GatewaySecureContentLayer(
            'gateway-1',
            security,
            policies,
            async () => firstActive,
        )
        await firstLayer.initialize(now)
        const firstAttempts: MatrixSendEventRequest[] = []
        const failingTransport: MatrixTransport = {
            async sendEncryptedRoomEvent(request) {
                firstAttempts.push(request)
                if (envelopeRecipient(request) === 'device-b') throw new Error('device-b offline')
                return { eventId: `$first-${firstAttempts.length}` }
            },
        }

        await firstLayer.sendCollaborationPrompt(room, {
            commandId: 'command-durable',
            revision: 7,
            sessionId: 'session-durable',
            originDeviceId: 'device-a',
            originDeviceName: 'Alice phone',
            text: 'durable prompt',
        }, failingTransport)
        await expect(firstLayer.sendCommandResult(
            room,
            'device-b',
            'command-durable',
            3,
            7,
            'runtime-epoch-1',
            'succeeded',
            failingTransport,
            undefined,
            'session-durable',
        )).rejects.toThrow('device-b offline')
        await vi.waitFor(() => {
            expect(firstAttempts.filter(request =>
                request.transactionId.startsWith('codever.command.result.command-durable.'),
            ).length).toBeGreaterThanOrEqual(2)
        })
        firstActive = []

        const restarted = new GatewaySecureContentLayer(
            'gateway-1',
            security,
            policies,
            async () => policies,
        )
        await restarted.initialize(now)
        const recovered: MatrixSendEventRequest[] = []
        const recoveredTransport: MatrixTransport = {
            async sendEncryptedRoomEvent(request) {
                recovered.push(request)
                return { eventId: `$recovered-${recovered.length}` }
            },
        }
        await restarted.retryPendingForRoom(room, recoveredTransport, 'command-durable')

        expect(recovered).toHaveLength(2)
        expect(new Set(recovered.map(envelopeRecipient))).toEqual(new Set(['device-b']))
        const plaintext = await Promise.all(
            recovered.map(request => openFor(request, second, gateway, 'device-b')),
        )
        expect(plaintext.map(content =>
            (content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>).kind,
        )).toEqual(expect.arrayContaining(['collaboration_command', 'command_result']))
        const recoveredResult = plaintext
            .map(content => content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>)
            .find(extension => extension.kind === 'command_result')
        expect(recoveredResult).toMatchObject({
            command_id: 'command-durable',
            sequence: 3,
            revision: 7,
            session_id: 'session-durable',
            outcome: 'succeeded',
        })
        expect(
            plaintext
                .map(content => content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>)
                .find(extension => extension.kind === 'collaboration_command'),
        ).toMatchObject({ session_id: 'session-durable' })
        expect(recovered.map(request => request.transactionId)).toEqual(
            expect.arrayContaining(
                firstAttempts
                    .filter(request => envelopeRecipient(request) === 'device-b')
                    .map(request => request.transactionId),
            ),
        )
    })

    it('tombstones an old pending copy instead of encrypting its plaintext to a rotated device key', async () => {
        const directory = await temporaryDirectory()
        const gateway = await generateDeviceKeyPair()
        const first = await generateDeviceKeyPair()
        const oldSecond = await generateDeviceKeyPair()
        const rotatedSecond = await generateDeviceKeyPair()
        const firstPolicy = trusted('device-a', 'Alice phone', first.publicJwk, 'MATRIX_A')
        const oldPolicy = trusted(
            'device-b',
            'Bob old laptop',
            oldSecond.publicJwk,
            'MATRIX_B',
            'certificate-old',
        )
        const rotatedPolicy = trusted(
            'device-b',
            'Bob new laptop',
            rotatedSecond.publicJwk,
            'MATRIX_B_NEW',
            'certificate-new',
        )
        let originalActive: MatrixGatewayTrustedDevice[] = [firstPolicy, oldPolicy]
        const security = {
            gatewayDeviceId: 'gateway-1',
            gatewayKeyPair: await exportDeviceKeyPair(gateway),
            envelopeReplayLedgerPath: join(directory, 'envelopes.json'),
        }
        const room = {
            roomId: '!room:localhost',
            conversationId: 'conversation-1',
            cwd: 'C:\\repo',
            providerName: 'test',
        }
        const original = new GatewaySecureContentLayer(
            'gateway-1',
            security,
            [firstPolicy, oldPolicy],
            async () => originalActive,
        )
        await original.initialize(now)
        await original.sendCollaborationPrompt(room, {
            commandId: 'rotated-command',
            revision: 8,
            originDeviceId: 'device-a',
            originDeviceName: 'Alice phone',
            text: 'must remain bound to the old certificate',
        }, {
            async sendEncryptedRoomEvent(request) {
                if (envelopeRecipient(request) === 'device-b') throw new Error('old device offline')
                return { eventId: '$old-first' }
            },
        })
        originalActive = []
        original.stopRetries()

        const rotated = new GatewaySecureContentLayer(
            'gateway-1',
            security,
            [firstPolicy, rotatedPolicy],
            async () => [firstPolicy, rotatedPolicy],
        )
        await rotated.initialize(now)
        const rotatedAttempts: MatrixSendEventRequest[] = []
        await rotated.retryPendingForRoom(room, {
            async sendEncryptedRoomEvent(request) {
                rotatedAttempts.push(request)
                return { eventId: '$must-not-send' }
            },
        }, 'rotated-command')

        expect(rotatedAttempts).toEqual([])
        const ledger = await readFile(`${security.envelopeReplayLedgerPath}.delivery-outbox.jsonl`, 'utf8')
        expect(ledger).toContain('"kind":"abandoned"')
        expect(ledger).toContain('"reason":"recipient_identity_changed"')

        const oldIdentityReturns = new GatewaySecureContentLayer(
            'gateway-1',
            security,
            [firstPolicy, oldPolicy],
            async () => [firstPolicy, oldPolicy],
        )
        await oldIdentityReturns.initialize(now)
        const resurrectionAttempts: MatrixSendEventRequest[] = []
        await oldIdentityReturns.retryPendingForRoom(room, {
            async sendEncryptedRoomEvent(request) {
                resurrectionAttempts.push(request)
                return { eventId: '$must-not-resurrect' }
            },
        }, 'rotated-command')
        expect(resurrectionAttempts).toEqual([])
    })

    it('enters exponential recovery after an initial retry failure and keeps the stable recipient transaction', async () => {
        const directory = await temporaryDirectory()
        const gateway = await generateDeviceKeyPair()
        const device = await generateDeviceKeyPair()
        const policy = trusted('device-a', 'Alice phone', device.publicJwk, 'MATRIX_A')
        const security = {
            gatewayDeviceId: 'gateway-1',
            gatewayKeyPair: await exportDeviceKeyPair(gateway),
            envelopeReplayLedgerPath: join(directory, 'envelopes.json'),
        }
        const room = {
            roomId: '!room:localhost',
            conversationId: 'conversation-1',
            cwd: 'C:\\repo',
            providerName: 'test',
        }
        const original = new GatewaySecureContentLayer(
            'gateway-1',
            security,
            [policy],
            async () => [policy],
        )
        await original.initialize(now)
        await expect(original.sendCommandResult(
            room,
            policy.deviceId,
            'startup-recovery',
            4,
            9,
            'runtime-epoch-1',
            'succeeded',
            { sendEncryptedRoomEvent: async () => { throw new Error('offline') } },
        )).rejects.toThrow('offline')
        original.stopRetries()

        const restarted = new GatewaySecureContentLayer(
            'gateway-1',
            security,
            [policy],
            async () => [policy],
        )
        await restarted.initialize(now)
        const attempts: MatrixSendEventRequest[] = []
        const recoveringTransport: MatrixTransport = {
            async sendEncryptedRoomEvent(request) {
                attempts.push(request)
                if (attempts.length === 1) throw new Error('first startup retry failed')
                return { eventId: '$recovered-after-backoff' }
            },
        }
        await restarted.retryPendingForRoom(room, recoveringTransport).catch(() => {
            restarted.scheduleRecoveryForRoom(room, recoveringTransport)
        })

        await vi.waitFor(() => expect(attempts).toHaveLength(2))
        expect(attempts[0]!.transactionId).toBe(attempts[1]!.transactionId)
        restarted.stopRetries()
    })

    it('truncates only a torn final WAL record and fails closed on newline-terminated corruption', async () => {
        const directory = await temporaryDirectory()
        const path = join(directory, 'delivery-outbox.jsonl')
        const outbox = new FileMatrixDeliveryOutbox(path)
        await outbox.initialize()
        await outbox.stage({
            deliveryId: 'delivery-valid',
            logicalKey: 'logical-valid',
            recipientDeviceId: 'device-a',
            recipientSequenceEpoch: 'certificate-a',
            recipientPublicKeyId: 'key-a',
            request: {
                roomId: '!room:localhost',
                eventType: 'm.room.message',
                transactionId: 'txn-valid',
                content: { msgtype: 'm.text', body: 'valid' },
            },
            createdAt: now,
        })
        const validContent = await readFile(path, 'utf8')
        await appendFile(path, '{"version":1,"kind":"pending","deliveryId":"torn"', 'utf8')

        const recovered = new FileMatrixDeliveryOutbox(path)
        await expect(recovered.initialize()).resolves.toBeUndefined()
        expect(recovered.listPending()).toHaveLength(1)
        expect(await readFile(path, 'utf8')).toBe(validContent)

        await writeFile(path, `${validContent}{not-json}\n`, 'utf8')
        const corrupt = new FileMatrixDeliveryOutbox(path)
        await expect(corrupt.initialize()).rejects.toThrow(
            'Invalid Matrix delivery outbox record at line 2',
        )
    })

    it('keeps per-device command sequences but CAS-orders a shared conversation revision', async () => {
        const directory = await temporaryDirectory()
        const first = await generateDeviceKeyPair()
        const second = await generateDeviceKeyPair()
        const policies = [
            trusted('device-a', 'Alice phone', first.publicJwk, 'MATRIX_A', 'certificate-a'),
            trusted('device-b', 'Bob laptop', second.publicJwk, 'MATRIX_B', 'certificate-b'),
        ]
        const replayStore = new FileCommandReplayStore(join(directory, 'commands.jsonl'))
        const authorizer = new StrictMatrixCommandAuthorizer(
            'gateway-1',
            policies,
            replayStore,
        )
        await authorizer.initialize(now)
        await expect(
            replayStore.getConversationRevision(
                'gateway-1',
                'conversation-1',
                'runtime-epoch-1',
            ),
        ).resolves.toBe(0)

        const acceptedA = await authorizer.authorizeDelivery(
            await signedPrompt(first, 'device-a', 1, 0, 'runtime-epoch-1', 'certificate-a'),
            context('device-a'),
            now,
        )
        expect(acceptedA).toMatchObject({ duplicate: false, revision: 1 })

        await expect(authorizer.authorizeDelivery(
            await signedPrompt(second, 'device-b', 1, 0, 'runtime-epoch-1', 'certificate-b'),
            context('device-b'),
            now,
        )).rejects.toMatchObject({
            code: 'revision_conflict',
            expectedRevision: 1,
            receivedBaseRevision: 0,
        })

        const acceptedB = await authorizer.authorizeDelivery(
            await signedPrompt(second, 'device-b', 1, 1, 'runtime-epoch-1', 'certificate-b'),
            context('device-b'),
            now,
        )
        expect(acceptedB).toMatchObject({ duplicate: false, revision: 2 })
        await expect(
            replayStore.getConversationRevision(
                'gateway-1',
                'conversation-1',
                'runtime-epoch-1',
            ),
        ).resolves.toBe(2)

        await expect(authorizer.authorizeDelivery(
            await signedPrompt(first, 'device-a', 1, 0, 'runtime-epoch-2', 'certificate-a'),
            context('device-a'),
            now,
        )).rejects.toMatchObject({ code: 'revision-epoch-mismatch' })
        const acceptedAfterRuntimeReset = await authorizer.authorizeDelivery(
            await signedPrompt(first, 'device-a', 1, 0, 'runtime-epoch-2', 'certificate-a'),
            context('device-a', 'runtime-epoch-2'),
            now,
        )
        expect(acceptedAfterRuntimeReset).toMatchObject({ duplicate: false, revision: 1 })
        await expect(
            replayStore.getConversationRevision(
                'gateway-1',
                'conversation-1',
                'runtime-epoch-2',
            ),
        ).resolves.toBe(1)
    })

    it('rejects a delayed command from the previous certificate after same-device renewal', async () => {
        const directory = await temporaryDirectory()
        const device = await generateDeviceKeyPair()
        const oldPolicy = trusted(
            'device-a',
            'Alice phone',
            device.publicJwk,
            'MATRIX_A',
            'certificate-old',
        )
        const replayStore = new FileCommandReplayStore(join(directory, 'commands.jsonl'))
        const authorizer = new StrictMatrixCommandAuthorizer(
            'gateway-1',
            [oldPolicy],
            replayStore,
        )
        await authorizer.initialize(now)
        const delayedOldCommand = await signedPrompt(
            device,
            'device-a',
            1,
            0,
            'runtime-epoch-1',
            'certificate-old',
        )

        authorizer.trustDevice(trusted(
            'device-a',
            'Alice phone',
            device.publicJwk,
            'MATRIX_A',
            'certificate-new',
        ))

        await expect(authorizer.authorizeDelivery(
            delayedOldCommand,
            context('device-a'),
            now,
        )).rejects.toMatchObject({ code: 'sequence-epoch-mismatch' })

        await expect(authorizer.authorizeDelivery(
            await signedPrompt(
                device,
                'device-a',
                1,
                0,
                'runtime-epoch-1',
                'certificate-new',
            ),
            context('device-a'),
            now,
        )).resolves.toMatchObject({ duplicate: false, revision: 1 })
    })
})

async function openFor(
    request: MatrixSendEventRequest,
    recipient: Awaited<ReturnType<typeof generateDeviceKeyPair>>,
    gateway: Awaited<ReturnType<typeof generateDeviceKeyPair>>,
    recipientDeviceId: string,
) {
    const extension = request.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
    const opened = await openSecureEnvelope(extension.secure_envelope, {
        recipientPrivateKey: recipient.privateKey,
        senderPublicKey: gateway.publicKey,
        expected: {
            gatewayId: 'gateway-1',
            conversationId: 'conversation-1',
            direction: 'gateway_to_device',
            senderDeviceId: 'gateway-1',
            recipientDeviceId,
            senderKeyId: gateway.keyId,
            recipientKeyId: recipient.keyId,
        },
        replayStore: new InMemoryReplayStore(),
    })
    return opened.plaintext as Record<string, unknown>
}

function envelopeRecipient(request: MatrixSendEventRequest): string | undefined {
    const extension = request.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
    const signed = extension.secure_envelope as { envelope?: { recipientDeviceId?: string } }
    return signed.envelope?.recipientDeviceId
}

function trusted(
    deviceId: string,
    deviceName: string,
    publicKey: JsonWebKey,
    matrixDeviceId: string,
    sequenceEpoch = `certificate-${deviceId}`,
): MatrixGatewayTrustedDevice {
    return {
        deviceId,
        deviceName,
        publicKey,
        allowedRoomIds: ['!room:localhost'],
        allowedOperations: ['prompt'],
        matrixUserId: `@${deviceId}:localhost`,
        matrixDeviceId,
        matrixDeviceKeys: [`${matrixDeviceId}-ed25519`],
        certificateExpiresAt: now + 60_000,
        sequenceEpoch,
    }
}

async function signedPrompt(
    keys: Awaited<ReturnType<typeof generateDeviceKeyPair>>,
    deviceId: string,
    sequence: number,
    baseRevision: number,
    revisionEpoch = 'runtime-epoch-1',
    sequenceEpoch = `certificate-${deviceId}`,
) {
    const command: CodeverCommand = {
        kind: 'codever.command',
        version: 1,
        commandId: `${deviceId}-${sequence}-${baseRevision}`,
        gatewayId: 'gateway-1',
        deviceId,
        sequenceEpoch,
        conversationId: 'conversation-1',
        revisionEpoch,
        sequence,
        baseRevision,
        operation: 'prompt',
        issuedAt: now,
        expiresAt: now + 60_000,
        nonce: `0123456789abcdef-${deviceId}-${baseRevision}`,
        payload: { operation: 'prompt', text: `hello from ${deviceId}` },
    }
    return signCommand(command, keys.privateKey, keys.keyId)
}

function context(deviceId: string, revisionEpoch = 'runtime-epoch-1') {
    return {
        roomId: '!room:localhost',
        conversationId: 'conversation-1',
        revisionEpoch,
        matrixSender: `@${deviceId}:localhost`,
        matrixDeviceKey: 'ignored-with-app-envelope',
        applicationDeviceId: deviceId,
    }
}

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'codever-multi-device-'))
    temporaryDirectories.push(directory)
    return directory
}
