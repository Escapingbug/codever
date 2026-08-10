import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type CodeverCommand } from '@codever/protocol'
import {
    exportDeviceKeyPair,
    generateDeviceKeyPair,
    InMemoryReplayStore,
    openSecureEnvelopeBundle,
    openSecureEnvelope,
    openMatrixTimelineEnvelope,
    base64UrlDecode,
    signCommand,
} from '@codever/security'
import {
    CODEVER_MATRIX_EXTENSION,
    type MatrixSendEventRequest,
    type MatrixTransport,
} from '@/channel/matrix'
import { ChannelDeliveryQueuedError } from '@/bridge/channelPort'
import {
    FileCommandReplayStore,
    FileMatrixDeliveryOutbox,
    GatewaySecureContentLayer,
    StrictMatrixCommandAuthorizer,
    type MatrixGatewayTrustedDevice,
} from '@/gateway/matrix'

const temporaryDirectories: string[] = []
const now = Date.now()
const TEST_CREDENTIAL_LIFETIME_MS = 15 * 60_000

afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(
        temporaryDirectories.splice(0).map(directory =>
            rm(directory, { recursive: true, force: true }),
        ),
    )
})

describe('multi-device Matrix collaboration', () => {
    it('sends one shared ciphertext, preserves stable edit identities, and stops revoked recipients immediately', async () => {
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
        const transport: MatrixTransport = {
            async sendEncryptedRoomEvent(request) {
                sent.push(request)
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
        expect(sent).toHaveLength(1)
        expect(sent[0]!.transactionId).toBe('logical-send')
        expect(original.eventId).toBe('$event-1')
        const originalA = await openFor(sent[0]!, first, gateway, 'device-a')
        const originalB = await openFor(sent[0]!, second, gateway, 'device-b')
        expect(originalA)
            .toMatchObject({
                body: 'shared answer',
                [CODEVER_MATRIX_EXTENSION]: { active_device_count: 2 },
            })
        expect(originalB)
            .toMatchObject({
                body: 'shared answer',
                [CODEVER_MATRIX_EXTENSION]: { active_device_count: 2 },
            })
        const stableOriginalId = (
            originalA[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
        ).logical_event_id
        expect(stableOriginalId).toMatch(/^[A-Za-z0-9_-]{43}$/u)

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
        expect(sent).toHaveLength(2)
        const firstEdit = await openFor(sent[1]!, first, gateway, 'device-a')
        const secondEdit = await openFor(sent[1]!, second, gateway, 'device-b')
        expect(firstEdit['m.relates_to']).toMatchObject({ event_id: stableOriginalId })
        expect(secondEdit['m.relates_to']).toMatchObject({ event_id: stableOriginalId })
        expect(
            (secondEdit['m.new_content'] as Record<string, unknown>)[CODEVER_MATRIX_EXTENSION],
        ).toMatchObject({ replaces_logical_event_id: stableOriginalId })

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
        expect(sent).toHaveLength(3)
        const afterRevoke = await openFor(sent[2]!, first, gateway, 'device-a')
        expect(afterRevoke[CODEVER_MATRIX_EXTENSION]).toMatchObject({
            active_device_count: 1,
        })
    })

    it('retries one stable bundle transaction and uses logical edit IDs for a newly joined device', async () => {
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
        let failOnce = true
        const transport: MatrixTransport = {
            async sendEncryptedRoomEvent(request) {
                sent.push(request)
                if (failOnce) {
                    failOnce = false
                    throw new Error('temporary bundle delivery failure')
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

        await expect(secureTransport.sendEncryptedRoomEvent(originalRequest))
            .rejects.toBeInstanceOf(ChannelDeliveryQueuedError)
        await layer.retryPendingForRoom(room, transport)
        expect(sent).toHaveLength(2)
        expect(new Set(sent.map(request => request.transactionId))).toEqual(
            new Set(['logical-retry']),
        )
        expect(eventIds).toEqual(new Map([['logical-retry', '$physical-1']]))
        expect(bundleRecipients(sent[1]!)).toEqual(['device-a', 'device-b'])

        active = [firstPolicy, secondPolicy, thirdPolicy]
        await expect(secureTransport.sendEncryptedRoomEvent(originalRequest)).resolves.toEqual({
            eventId: '$physical-1',
        })
        expect(sent).toHaveLength(2)
        await secureTransport.sendEncryptedRoomEvent({
            roomId: room.roomId,
            eventType: 'm.room.message',
            transactionId: 'logical-edit-after-join',
            content: {
                msgtype: 'm.text',
                body: '* updated',
                'm.relates_to': { rel_type: 'm.replace', event_id: '$physical-1' },
                'm.new_content': {
                    msgtype: 'm.text',
                    body: 'updated',
                    [CODEVER_MATRIX_EXTENSION]: {
                        version: 1,
                        kind: 'message',
                        replaces_event_id: '$physical-1',
                    },
                },
                [CODEVER_MATRIX_EXTENSION]: {
                    version: 1,
                    kind: 'message',
                    replaces_event_id: '$physical-1',
                },
            },
        })
        const thirdEditRequest = sent.at(-1)!
        expect(bundleRecipients(thirdEditRequest)).toEqual([
            'device-a',
            'device-b',
            'device-c',
        ])
        const thirdEdit = await openFor(thirdEditRequest, third, gateway, 'device-c')
        const stableTarget = (thirdEdit['m.relates_to'] as Record<string, unknown>).event_id
        expect(stableTarget).toMatch(/^[A-Za-z0-9_-]{43}$/u)
        expect(thirdEdit[CODEVER_MATRIX_EXTENSION]).toMatchObject({
            replaces_logical_event_id: stableTarget,
        })
        expect(
            (thirdEdit['m.new_content'] as Record<string, unknown>)[CODEVER_MATRIX_EXTENSION],
        ).toMatchObject({ replaces_logical_event_id: stableTarget })
    })

    it('persists one bundle while a slow Matrix attempt completes after the caller timeout', async () => {
        const directory = await temporaryDirectory()
        const gateway = await generateDeviceKeyPair()
        const first = await generateDeviceKeyPair()
        const second = await generateDeviceKeyPair()
        const policies = [
            trusted('device-a', 'Alice phone', first.publicJwk, 'MATRIX_A'),
            trusted('device-b', 'Bob laptop', second.publicJwk, 'MATRIX_B'),
        ]
        const security = {
            gatewayDeviceId: 'gateway-1',
            gatewayKeyPair: await exportDeviceKeyPair(gateway),
            envelopeReplayLedgerPath: join(directory, 'envelopes.json'),
            deliveryAttemptTimeoutMs: 20,
        }
        const layer = new GatewaySecureContentLayer(
            'gateway-1',
            security,
            policies,
            async () => policies,
        )
        await layer.initialize(now)
        let releaseSlow!: () => void
        const slow = new Promise<void>(resolve => {
            releaseSlow = resolve
        })
        const attempted: string[] = []
        const transport: MatrixTransport = {
            async sendEncryptedRoomEvent(request) {
                attempted.push(request.transactionId)
                await slow
                return { eventId: '$event-bundle' }
            },
        }
        const room = {
            roomId: '!room:localhost',
            conversationId: 'conversation-1',
            cwd: 'C:\\repo',
            providerName: 'test',
        }

        const result = layer.transportForRoom(room, transport).sendEncryptedRoomEvent({
            roomId: room.roomId,
            eventType: 'm.room.message',
            transactionId: 'logical-slow-fanout',
            content: {
                msgtype: 'm.text',
                body: 'reply survives a slow device',
                [CODEVER_MATRIX_EXTENSION]: { version: 1, kind: 'message' },
            },
        })

        await expect(result).rejects.toBeInstanceOf(ChannelDeliveryQueuedError)
        expect(attempted).toEqual(['logical-slow-fanout'])
        const beforeSlowConfirmation = await readFile(
            `${security.envelopeReplayLedgerPath}.delivery-outbox.jsonl`,
            'utf8',
        )
        expect(beforeSlowConfirmation.match(/"kind":"pending_bundle"/gu)).toHaveLength(1)
        expect(beforeSlowConfirmation.match(/"kind":"delivered"/gu)).toBeNull()

        releaseSlow()
        await vi.waitFor(async () => {
            const ledger = await readFile(
                `${security.envelopeReplayLedgerPath}.delivery-outbox.jsonl`,
                'utf8',
            )
            expect(ledger.match(/"kind":"delivered"/gu)).toHaveLength(1)
        })
        layer.stopRetries()
    })

    it('persists a new reply before recovering an older stuck delivery', async () => {
        const directory = await temporaryDirectory()
        const gateway = await generateDeviceKeyPair()
        const device = await generateDeviceKeyPair()
        const policy = trusted('device-a', 'Alice phone', device.publicJwk, 'MATRIX_A')
        const security = {
            gatewayDeviceId: 'gateway-1',
            gatewayKeyPair: await exportDeviceKeyPair(gateway),
            envelopeReplayLedgerPath: join(directory, 'envelopes.json'),
        }
        const ledgerPath = `${security.envelopeReplayLedgerPath}.delivery-outbox.jsonl`
        const oldOutbox = new FileMatrixDeliveryOutbox(ledgerPath)
        await oldOutbox.initialize()
        await oldOutbox.stage({
            deliveryId: 'old-stuck-delivery',
            logicalKey: 'old-stuck-logical',
            recipientDeviceId: policy.deviceId,
            recipientSequenceEpoch: policy.sequenceEpoch!,
            recipientPublicKeyId: device.keyId,
            request: {
                roomId: '!room:localhost',
                eventType: 'm.room.message',
                transactionId: 'old-stuck-transaction',
                content: { msgtype: 'm.text', body: 'old stuck reply' },
            },
            createdAt: now - 1_000,
        })
        const layer = new GatewaySecureContentLayer(
            'gateway-1',
            security,
            [policy],
            async () => [policy],
        )
        await layer.initialize(now)
        const attempted: string[] = []
        const room = {
            roomId: '!room:localhost',
            conversationId: 'conversation-1',
            cwd: 'C:\\repo',
            providerName: 'test',
        }

        await layer.transportForRoom(room, {
            async sendEncryptedRoomEvent(request) {
                attempted.push(request.transactionId)
                if (request.transactionId === 'old-stuck-transaction') {
                    return await new Promise(() => {})
                }
                return { eventId: '$new-reply' }
            },
        }).sendEncryptedRoomEvent({
            roomId: room.roomId,
            eventType: 'm.room.message',
            transactionId: 'new-logical-transaction',
            content: {
                msgtype: 'm.text',
                body: 'new reply is staged first',
                [CODEVER_MATRIX_EXTENSION]: { version: 1, kind: 'message' },
            },
        })

        expect(attempted).toContain('new-logical-transaction')
        const ledger = await readFile(ledgerPath, 'utf8')
        expect(ledger).toContain('new reply is staged first')
        layer.stopRetries()
    })

    it('keeps an all-device network failure durable and recovers it after restart', async () => {
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
        const secureTransport = original.transportForRoom(room, {
            async sendEncryptedRoomEvent() {
                throw new Error('temporary weak network')
            },
        })

        await expect(secureTransport.sendEncryptedRoomEvent({
            roomId: room.roomId,
            eventType: 'm.room.message',
            transactionId: 'weak-network-logical',
            content: {
                msgtype: 'm.text',
                body: 'recover this reply',
                [CODEVER_MATRIX_EXTENSION]: { version: 1, kind: 'message' },
            },
        })).rejects.toBeInstanceOf(ChannelDeliveryQueuedError)
        original.stopRetries()

        const restarted = new GatewaySecureContentLayer(
            'gateway-1',
            security,
            [policy],
            async () => [policy],
        )
        await restarted.initialize(now)
        const recovered: MatrixSendEventRequest[] = []
        await restarted.retryPendingForRoom(room, {
            async sendEncryptedRoomEvent(request) {
                recovered.push(request)
                return { eventId: '$recovered-weak-network' }
            },
        })

        expect(recovered).toHaveLength(1)
        const plaintext = await openFor(recovered[0]!, device, gateway, 'device-a')
        expect(plaintext).toMatchObject({ body: 'recover this reply' })
        restarted.stopRetries()
    })

    it('keeps a hung transport promise in flight so watchdog retries cannot duplicate it', async () => {
        const directory = await temporaryDirectory()
        const gateway = await generateDeviceKeyPair()
        const device = await generateDeviceKeyPair()
        const policy = trusted('device-a', 'Alice phone', device.publicJwk, 'MATRIX_A')
        const security = {
            gatewayDeviceId: 'gateway-1',
            gatewayKeyPair: await exportDeviceKeyPair(gateway),
            envelopeReplayLedgerPath: join(directory, 'envelopes.json'),
            deliveryAttemptTimeoutMs: 20,
        }
        const room = {
            roomId: '!room:localhost',
            conversationId: 'conversation-1',
            cwd: 'C:\\repo',
            providerName: 'test',
        }
        const layer = new GatewaySecureContentLayer(
            'gateway-1',
            security,
            [policy],
            async () => [policy],
        )
        await layer.initialize(now)
        const attemptedTransactions: string[] = []
        let releaseHung!: () => void
        const hung = new Promise<void>(resolve => {
            releaseHung = resolve
        })
        const originalTransport: MatrixTransport = {
            async sendEncryptedRoomEvent(request) {
                attemptedTransactions.push(request.transactionId)
                await hung
                return { eventId: '$hung-late-confirmation' }
            },
        }
        let queued!: ChannelDeliveryQueuedError
        try {
            await layer.transportForRoom(room, originalTransport).sendEncryptedRoomEvent({
                roomId: room.roomId,
                eventType: 'm.room.message',
                transactionId: 'hung-logical',
                content: {
                    msgtype: 'm.text',
                    body: 'hung but durable reply',
                    [CODEVER_MATRIX_EXTENSION]: { version: 1, kind: 'message' },
                },
            })
        } catch (error) {
            expect(error).toBeInstanceOf(ChannelDeliveryQueuedError)
            queued = error as ChannelDeliveryQueuedError
        }
        layer.stopRetries()

        let recoveryTransportCalls = 0
        const recovery = layer.retryPendingForRoom(room, {
            async sendEncryptedRoomEvent(request) {
                recoveryTransportCalls += 1
                attemptedTransactions.push(request.transactionId)
                return { eventId: '$must-not-duplicate' }
            },
        })
        await vi.waitFor(() => expect(attemptedTransactions).toHaveLength(1))
        expect(recoveryTransportCalls).toBe(0)

        releaseHung()
        await recovery

        await expect(queued.confirmation).resolves.toEqual({
            messageId: '$hung-late-confirmation',
        })
        expect(attemptedTransactions).toHaveLength(1)
        expect(new Set(attemptedTransactions)).toHaveLength(1)
        layer.stopRetries()
    })

    it('recovers a confirmation already persisted before the queued waiter is installed', async () => {
        const directory = await temporaryDirectory()
        const gateway = await generateDeviceKeyPair()
        const device = await generateDeviceKeyPair()
        const policy = trusted('device-a', 'Alice phone', device.publicJwk, 'MATRIX_A')
        const security = {
            gatewayDeviceId: 'gateway-1',
            gatewayKeyPair: await exportDeviceKeyPair(gateway),
            envelopeReplayLedgerPath: join(directory, 'envelopes.json'),
            deliveryAttemptTimeoutMs: 20,
        }
        const room = {
            roomId: '!room:localhost',
            conversationId: 'conversation-1',
            cwd: 'C:\\repo',
            providerName: 'test',
        }
        const layer = new GatewaySecureContentLayer(
            'gateway-1',
            security,
            [policy],
            async () => [policy],
        )
        await layer.initialize(now)
        let releaseMarkDelivered!: () => void
        const markDeliveredGate = new Promise<void>(resolve => {
            releaseMarkDelivered = resolve
        })
        let markDeliveredPersisted!: () => void
        const persisted = new Promise<void>(resolve => {
            markDeliveredPersisted = resolve
        })
        const originalMarkDelivered = FileMatrixDeliveryOutbox.prototype.markDelivered
        const markDelivered = vi.spyOn(
            FileMatrixDeliveryOutbox.prototype,
            'markDelivered',
        ).mockImplementation(async function (
            this: FileMatrixDeliveryOutbox,
            deliveryId,
            eventId,
            deliveredAt,
        ) {
            await originalMarkDelivered.call(this, deliveryId, eventId, deliveredAt)
            markDeliveredPersisted()
            await markDeliveredGate
        })
        try {
            let queued!: ChannelDeliveryQueuedError
            try {
                await layer.transportForRoom(room, {
                    async sendEncryptedRoomEvent() {
                        return { eventId: '$persisted-before-waiter' }
                    },
                }).sendEncryptedRoomEvent({
                    roomId: room.roomId,
                    eventType: 'm.room.message',
                    transactionId: 'confirmation-race',
                    content: {
                        msgtype: 'm.text',
                        body: 'persisted before waiter',
                        [CODEVER_MATRIX_EXTENSION]: { version: 1, kind: 'message' },
                    },
                })
            } catch (error) {
                expect(error).toBeInstanceOf(ChannelDeliveryQueuedError)
                queued = error as ChannelDeliveryQueuedError
            }
            layer.stopRetries()

            // Explicitly establish the race this test names. Timeline group
            // encryption can legitimately take longer than the 20 ms caller
            // watchdog under a parallel test load; persistence, rather than
            // cryptographic scheduling latency, is the required precondition.
            await persisted
            await expect(queued.confirmation).resolves.toEqual({
                messageId: '$persisted-before-waiter',
            })
        } finally {
            releaseMarkDelivered()
            markDelivered.mockRestore()
            layer.stopRetries()
        }
    })

    it('lets control responses bypass a hung bounded recovery queue', async () => {
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
        const outbox = new FileMatrixDeliveryOutbox(
            `${security.envelopeReplayLedgerPath}.delivery-outbox.jsonl`,
        )
        await outbox.initialize()
        for (let index = 0; index < 4; index += 1) {
            await outbox.stage({
                deliveryId: `old-bulk-${index}`,
                logicalKey: `old-bulk-logical-${index}`,
                recipientDeviceId: policy.deviceId,
                recipientSequenceEpoch: policy.sequenceEpoch!,
                recipientPublicKeyId: device.keyId,
                request: {
                    roomId: room.roomId,
                    eventType: 'm.room.message',
                    transactionId: `old-bulk-transaction-${index}`,
                    content: { msgtype: 'm.text', body: `old bulk ${index}` },
                },
                createdAt: now - 10_000 + index,
            })
        }
        const layer = new GatewaySecureContentLayer(
            'gateway-1',
            security,
            [policy],
            async () => [policy],
        )
        await layer.initialize(now)
        let releaseRecovery!: () => void
        const recoveryGate = new Promise<void>(resolve => {
            releaseRecovery = resolve
        })
        const attempted: string[] = []
        const transport: MatrixTransport = {
            async sendEncryptedRoomEvent(request) {
                attempted.push(request.transactionId)
                if (request.transactionId === 'old-bulk-transaction-0') {
                    await recoveryGate
                }
                return { eventId: `$priority-${attempted.length}` }
            },
        }

        const recovery = layer.retryPendingForRoom(room, transport)
        await vi.waitFor(() => expect(attempted).toEqual(['old-bulk-transaction-0']))

        await layer.sendCommandAccepted(
            room,
            policy.deviceId,
            'priority-command',
            1,
            1,
            'runtime-epoch-1',
            transport,
        )
        await layer.sendCommandResult(
            room,
            policy.deviceId,
            'priority-command',
            1,
            1,
            'runtime-epoch-1',
            'succeeded',
            transport,
        )
        await layer.transportForRoom(room, transport).sendEncryptedRoomEvent({
            roomId: room.roomId,
            eventType: 'm.room.message',
            transactionId: 'priority-decision',
            content: {
                msgtype: 'm.text',
                body: 'permission required',
                [CODEVER_MATRIX_EXTENSION]: {
                    version: 1,
                    kind: 'decision_request',
                    session_id: 'priority-session',
                    decision_id: 'decision-priority',
                },
            },
        })

        expect(attempted).toHaveLength(4)
        expect(attempted[1]).toMatch(/^codever\.command\.ack\.priority-command\.[^.]+\./u)
        expect(attempted[2]).toMatch(/^codever\.command\.result\.priority-command\.succeeded\./u)
        expect(attempted[3]).toBe('priority-decision')
        releaseRecovery()
        await recovery
        expect(attempted.filter(transactionId =>
            transactionId.startsWith('old-bulk-transaction-'),
        )).toHaveLength(4)
        layer.stopRetries()
    })

    it('uses a fresh Matrix transaction and envelope for each command-status redelivery', async () => {
        const directory = await temporaryDirectory()
        const gateway = await generateDeviceKeyPair()
        const device = await generateDeviceKeyPair()
        const policy = trusted('device-a', 'Alice phone', device.publicJwk, 'MATRIX_A')
        const layer = new GatewaySecureContentLayer(
            'gateway-1',
            {
                gatewayDeviceId: 'gateway-1',
                gatewayKeyPair: await exportDeviceKeyPair(gateway),
                envelopeReplayLedgerPath: join(directory, 'envelopes.json'),
            },
            [policy],
            async () => [policy],
        )
        await layer.initialize(now)
        const room = {
            roomId: '!room:localhost',
            conversationId: 'conversation-1',
            cwd: 'C:\\repo',
            providerName: 'test',
        }
        const eventsByTransaction = new Map<string, string>()
        const timeline: MatrixSendEventRequest[] = []
        const transport: MatrixTransport = {
            async sendEncryptedRoomEvent(request) {
                const existing = eventsByTransaction.get(request.transactionId)
                if (existing) return { eventId: existing }
                const eventId = `$status-${eventsByTransaction.size + 1}`
                eventsByTransaction.set(request.transactionId, eventId)
                timeline.push(request)
                return { eventId }
            },
        }

        await layer.sendCommandAccepted(
            room,
            policy.deviceId,
            'recover-command',
            7,
            11,
            'runtime-epoch-1',
            transport,
        )
        await layer.sendCommandAccepted(
            room,
            policy.deviceId,
            'recover-command',
            7,
            11,
            'runtime-epoch-1',
            transport,
        )
        await layer.sendCommandResult(
            room,
            policy.deviceId,
            'recover-command',
            7,
            11,
            'runtime-epoch-1',
            'succeeded',
            transport,
            undefined,
            'created-session',
        )
        await layer.sendCommandResult(
            room,
            policy.deviceId,
            'recover-command',
            7,
            11,
            'runtime-epoch-1',
            'succeeded',
            transport,
            undefined,
            'created-session',
        )

        expect(timeline).toHaveLength(4)
        expect(new Set(timeline.map(request => request.transactionId)).size).toBe(4)
        expect(timeline.slice(0, 2).every(request =>
            request.transactionId.startsWith('codever.command.ack.recover-command.'),
        )).toBe(true)
        expect(timeline.slice(2).every(request =>
            request.transactionId.startsWith(
                'codever.command.result.recover-command.succeeded.',
            ),
        )).toBe(true)

        const replayStore = new InMemoryReplayStore()
        const plaintext = []
        for (const request of timeline) {
            plaintext.push(await openFor(
                request,
                device,
                gateway,
                policy.deviceId,
                replayStore,
            ))
        }
        expect(plaintext.map(content =>
            (content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>).kind,
        )).toEqual(['command_ack', 'command_ack', 'command_result', 'command_result'])
        expect(plaintext.slice(2).every(content =>
            (content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>).session_id
                === 'created-session',
        )).toBe(true)
        layer.stopRetries()
    })

    it('coalesces queued replacement bundles and tombstones the superseded WAL copy', async () => {
        const directory = await temporaryDirectory()
        const gateway = await generateDeviceKeyPair()
        const first = await generateDeviceKeyPair()
        const second = await generateDeviceKeyPair()
        const third = await generateDeviceKeyPair()
        const policies = [
            trusted('device-a', 'Alice phone', first.publicJwk, 'MATRIX_A'),
            trusted('device-b', 'Bob laptop', second.publicJwk, 'MATRIX_B'),
            trusted('device-c', 'Carol tablet', third.publicJwk, 'MATRIX_C'),
        ]
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
        const layer = new GatewaySecureContentLayer(
            'gateway-1',
            security,
            policies,
            async () => policies,
        )
        await layer.initialize(now)
        let releaseFirstEdit!: () => void
        const firstEditGate = new Promise<void>(resolve => {
            releaseFirstEdit = resolve
        })
        const sent: MatrixSendEventRequest[] = []
        const transport: MatrixTransport = {
            async sendEncryptedRoomEvent(request) {
                sent.push(request)
                if (request.transactionId === 'coalesce-edit-one') {
                    await firstEditGate
                }
                return { eventId: `$coalesce-${sent.length}` }
            },
        }
        const secureTransport = layer.transportForRoom(room, transport)
        const original = await secureTransport.sendEncryptedRoomEvent({
            roomId: room.roomId,
            eventType: 'm.room.message',
            transactionId: 'coalesce-original',
            content: {
                msgtype: 'm.text',
                body: 'original',
                [CODEVER_MATRIX_EXTENSION]: { version: 1, kind: 'message' },
            },
        })
        expect(sent).toHaveLength(1)
        const replacement = (transactionId: string, body: string): MatrixSendEventRequest => ({
            roomId: room.roomId,
            eventType: 'm.room.message',
            transactionId,
            content: {
                msgtype: 'm.text',
                body: `* ${body}`,
                'm.relates_to': { rel_type: 'm.replace', event_id: original.eventId },
                'm.new_content': {
                    msgtype: 'm.text',
                    body,
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

        const firstEdit = secureTransport.sendEncryptedRoomEvent(
            replacement('coalesce-edit-one', 'first'),
        )
        await vi.waitFor(() => expect(sent.filter(request =>
            request.transactionId === 'coalesce-edit-one',
        )).toHaveLength(1))
        const intermediateEdit = secureTransport.sendEncryptedRoomEvent(
            replacement('coalesce-edit-two', 'intermediate'),
        )
        const intermediateOutcome = intermediateEdit.catch(error => error as unknown)
        const finalEdit = secureTransport.sendEncryptedRoomEvent(
            replacement('coalesce-edit-three', 'final'),
        )
        await vi.waitFor(async () => {
            const ledger = await readFile(
                `${security.envelopeReplayLedgerPath}.delivery-outbox.jsonl`,
                'utf8',
            )
            expect(ledger).toContain('"reason":"superseded"')
        })
        expect(sent.some(request => request.transactionId === 'coalesce-edit-two')).toBe(false)

        releaseFirstEdit()
        await Promise.all([firstEdit, finalEdit])
        expect(await intermediateOutcome).toBeInstanceOf(Error)
        await vi.waitFor(() => expect(sent.filter(request =>
            request.transactionId === 'coalesce-edit-three',
        )).toHaveLength(1))
        layer.stopRetries()
    })

    it('persists a targeted result gap without replaying an already delivered collaboration bundle', async () => {
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
            revisionEpoch: 'runtime-epoch-1',
            revisionEpochGeneration: 1,
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
            {
                pairingLink: 'codever://pair?data=signed-offer',
                expiresAt: now + 300_000,
            },
        )).rejects.toThrow('device-b offline')
        expect(firstAttempts.filter(request =>
            request.transactionId.startsWith('codever.command.result.command-durable.'),
        )).toHaveLength(1)
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

        expect(recovered).toHaveLength(1)
        expect(new Set(recovered.map(envelopeRecipient))).toEqual(new Set(['device-b']))
        const plaintext = await Promise.all(
            recovered.map(request => openFor(request, second, gateway, 'device-b')),
        )
        expect(plaintext.map(content =>
            (content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>).kind,
        )).toEqual(['command_result'])
        const recoveredResult = plaintext
            .map(content => content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>)
            .find(extension => extension.kind === 'command_result')
        expect(recoveredResult).toMatchObject({
            command_id: 'command-durable',
            sequence: 3,
            revision: 7,
            session_id: 'session-durable',
            outcome: 'succeeded',
            result: {
                pairingLink: 'codever://pair?data=signed-offer',
                expiresAt: now + 300_000,
            },
        })
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
        await expect(original.sendCollaborationPrompt(room, {
            commandId: 'rotated-command',
            revision: 8,
            revisionEpoch: 'runtime-epoch-1',
            revisionEpochGeneration: 1,
            originDeviceId: 'device-a',
            originDeviceName: 'Alice phone',
            text: 'must remain bound to the old certificate',
        }, {
            async sendEncryptedRoomEvent() {
                throw new Error('bundle transport offline')
            },
        })).rejects.toBeInstanceOf(ChannelDeliveryQueuedError)
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

        expect(rotatedAttempts).toHaveLength(1)
        expect(bundleRecipients(rotatedAttempts[0]!)).toEqual(['device-a'])
        await expect(openFor(rotatedAttempts[0]!, first, gateway, 'device-a'))
            .resolves.toMatchObject({
                [CODEVER_MATRIX_EXTENSION]: { command_id: 'rotated-command' },
            })
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

    it('persists permanent delivery failures so restart recovery does not retry them', async () => {
        const directory = await temporaryDirectory()
        const path = join(directory, 'delivery-outbox.jsonl')
        const outbox = new FileMatrixDeliveryOutbox(path)
        await outbox.initialize()
        await outbox.stage({
            deliveryId: 'delivery-permanent',
            logicalKey: 'logical-permanent',
            recipientDeviceId: 'device-a',
            recipientSequenceEpoch: 'certificate-a',
            recipientPublicKeyId: 'key-a',
            request: {
                roomId: '!room:localhost',
                eventType: 'm.room.message',
                transactionId: 'txn-permanent',
                content: { msgtype: 'm.text', body: 'invalid forever' },
            },
            createdAt: now,
        })
        await outbox.markFailed('delivery-permanent', 'canonical JSON rejected the payload')

        const recovered = new FileMatrixDeliveryOutbox(path)
        await recovered.initialize()

        expect(recovered.listPending()).toEqual([])
        expect(await readFile(path, 'utf8')).toContain('"kind":"failed"')
    })

    it('writes one delivered transition when a late attempt and its retry confirm together', async () => {
        const directory = await temporaryDirectory()
        const path = join(directory, 'delivery-outbox.jsonl')
        const outbox = new FileMatrixDeliveryOutbox(path)
        await outbox.initialize()
        await outbox.stage({
            deliveryId: 'delivery-race',
            logicalKey: 'logical-race',
            recipientDeviceId: 'device-a',
            recipientSequenceEpoch: 'certificate-a',
            recipientPublicKeyId: 'key-a',
            request: {
                roomId: '!room:localhost',
                eventType: 'm.room.message',
                transactionId: 'txn-race',
                content: { msgtype: 'm.text', body: 'race safely' },
            },
            createdAt: now,
        })

        await Promise.all([
            outbox.markDelivered('delivery-race', '$same-event'),
            outbox.markDelivered('delivery-race', '$same-event'),
        ])

        const ledger = await readFile(path, 'utf8')
        expect(ledger.match(/"kind":"delivered"/gu)).toHaveLength(1)
        expect(outbox.deliveredEventId('delivery-race')).toBe('$same-event')
    })

    it('keeps per-device command sequences but CAS-orders a shared conversation revision', async () => {
        const directory = await temporaryDirectory()
        const first = await generateDeviceKeyPair()
        const second = await generateDeviceKeyPair()
        const policies: MatrixGatewayTrustedDevice[] = [
            trusted('device-a', 'Alice phone', first.publicJwk, 'MATRIX_A', 'certificate-a'),
            {
                ...trusted(
                    'device-b',
                    'Bob laptop',
                    second.publicJwk,
                    'MATRIX_B',
                    'certificate-b',
                ),
                allowedOperations: ['prompt', 'session.delete'],
            },
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
            await signedSessionDelete(
                second,
                'device-b',
                1,
                0,
                'runtime-epoch-1',
                'certificate-b',
            ),
            context('device-b'),
            now,
        )).rejects.toMatchObject({
            code: 'revision_conflict',
            expectedRevision: 1,
            receivedBaseRevision: 0,
        })

        const acceptedB = await authorizer.authorizeDelivery(
            await signedSessionDelete(
                second,
                'device-b',
                1,
                1,
                'runtime-epoch-1',
                'certificate-b',
            ),
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
    replayStore = new InMemoryReplayStore(),
) {
    const extension = request.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
    const options = {
        recipientPrivateKey: recipient.privateKey,
        senderPublicKey: gateway.publicKey,
        expected: {
            gatewayId: 'gateway-1',
            conversationId: 'conversation-1',
            direction: 'gateway_to_device' as const,
            senderDeviceId: 'gateway-1',
            recipientDeviceId,
            senderKeyId: gateway.keyId,
            recipientKeyId: recipient.keyId,
        },
        replayStore,
    }
    const opened = extension.kind === 'secure_envelope_bundle'
        ? await openSecureEnvelopeBundle(extension.secure_envelope_bundle, options)
        : extension.kind === 'timeline_envelope'
            ? await openTimelineFor(extension, options, gateway)
            : await openSecureEnvelope(extension.secure_envelope, options)
    return opened.plaintext as Record<string, unknown>
}

async function openTimelineFor(
    extension: Record<string, unknown>,
    options: Parameters<typeof openSecureEnvelopeBundle>[1],
    gateway: Awaited<ReturnType<typeof generateDeviceKeyPair>>,
) {
    const openedGrant = await openSecureEnvelopeBundle(
        extension.timeline_key_ring_bundle,
        options,
    )
    const grant = openedGrant.plaintext as {
        active_epoch_id: string
        epochs: Array<{ epoch_id: string; key: string }>
    }
    const active = grant.epochs.find(epoch => epoch.epoch_id === grant.active_epoch_id)!
    const signed = extension.timeline_envelope as {
        envelope: {
            sessionId?: string
            threadRootEventId?: string
        }
    }
    return openMatrixTimelineEnvelope(extension.timeline_envelope, {
        timelineKey: base64UrlDecode(active.key),
        gatewayPublicKey: gateway.publicKey,
        expected: {
            gatewayId: options.expected.gatewayId,
            conversationId: options.expected.conversationId,
            roomId: '!room:localhost',
            epochId: active.epoch_id,
            ...(signed.envelope.sessionId ? { sessionId: signed.envelope.sessionId } : {}),
            ...(signed.envelope.threadRootEventId
                ? { threadRootEventId: signed.envelope.threadRootEventId }
                : {}),
        },
    })
}

function envelopeRecipient(request: MatrixSendEventRequest): string | undefined {
    const extension = request.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
    const signed = extension.secure_envelope as {
        envelope?: { recipientDeviceId?: string }
    } | undefined
    if (!signed) {
        const bundle = (extension.secure_envelope_bundle
            ?? extension.timeline_key_ring_bundle) as {
            bundle?: { recipients?: Array<{ recipientDeviceId?: string }> }
        } | undefined
        return bundle?.bundle?.recipients?.length === 1
            ? bundle.bundle.recipients[0]?.recipientDeviceId
            : undefined
    }
    return signed.envelope?.recipientDeviceId
}

function bundleRecipients(request: MatrixSendEventRequest): string[] {
    const extension = request.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
    const signed = (extension.secure_envelope_bundle
        ?? extension.timeline_key_ring_bundle) as {
        bundle?: { recipients?: Array<{ recipientDeviceId?: string }> }
    } | undefined
    return (signed?.bundle?.recipients ?? [])
        .map(recipient => recipient.recipientDeviceId)
        .filter((deviceId): deviceId is string => deviceId !== undefined)
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
        certificateExpiresAt: now + TEST_CREDENTIAL_LIFETIME_MS,
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
        payload: {
            operation: 'prompt',
            sessionId: 'app-session-1',
            text: `hello from ${deviceId}`,
        },
    }
    return signCommand(command, keys.privateKey, keys.keyId)
}

async function signedSessionDelete(
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
        commandId: `${deviceId}-delete-${sequence}-${baseRevision}`,
        gatewayId: 'gateway-1',
        deviceId,
        sequenceEpoch,
        conversationId: 'conversation-1',
        revisionEpoch,
        sequence,
        baseRevision,
        operation: 'session.delete',
        issuedAt: now,
        expiresAt: now + 60_000,
        nonce: `0123456789abcdef-${deviceId}-delete-${baseRevision}`,
        payload: {
            operation: 'session.delete',
            sessionId: 'app-session-1',
        },
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
