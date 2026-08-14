import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
    exportDeviceKeyPair,
    generateDeviceKeyPair,
    InMemoryReplayStore,
    base64UrlDecode,
    openMatrixTimelineEnvelope,
    openSecureEnvelopeBundle,
    openSecureEnvelope,
    sealSecureEnvelope,
} from '@codever/security'
import type {
    MatrixApplicationControlEventRequest,
    MatrixApplicationStateEventRequest,
    MatrixApplicationTimelineEventRequest,
    MatrixSendEventRequest,
    MatrixTransport,
} from '@/channel/matrix'
import { CODEVER_MATRIX_EXTENSION } from '@/channel/matrix'
import { GatewaySecureContentLayer } from '@/gateway/matrix/secureContent'

const temporaryDirectories: string[] = []
const now = Date.now()

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(directory =>
            rm(directory, { recursive: true, force: true }),
        ),
    )
})

describe('Gateway application-layer Matrix content', () => {
    it('does not block a new state entity behind an unrelated durable gap', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-secure-matrix-'))
        temporaryDirectories.push(directory)
        const gateway = await generateDeviceKeyPair()
        const device = await generateDeviceKeyPair()
        const layer = new GatewaySecureContentLayer(
            'gateway-1',
            {
                gatewayDeviceId: 'gateway-1',
                gatewayKeyPair: await exportDeviceKeyPair(gateway),
                envelopeReplayLedgerPath: join(directory, 'envelopes.json'),
            },
            [{
                deviceId: 'phone-1',
                publicKey: device.publicJwk,
                allowedRoomIds: ['!room:localhost'],
                allowedOperations: ['prompt'],
                matrixUserId: '@phone:localhost',
                matrixDeviceId: 'PHONE_MATRIX',
                matrixDeviceKeys: ['phone-matrix-ed25519'],
                certificateExpiresAt: now + 60_000,
                sequenceEpoch: 'certificate-phone-1',
            }],
        )
        await layer.initialize(now)
        const room = {
            roomId: '!room:localhost',
            conversationId: 'conversation-1',
            cwd: '/repo',
            providerName: 'test',
        }
        const firstAttempts: MatrixApplicationStateEventRequest[] = []
        await expect(layer.setNativeRoomState(
            room,
            'io.codever.session.current.v2',
            'session-old-gap',
            deletedSessionState('session-old-gap', 1),
            {
                async sendEncryptedRoomEvent() {
                    throw new Error('not used')
                },
                async setApplicationRoomState(request) {
                    firstAttempts.push(request)
                    throw new Error('old entity offline')
                },
            },
        )).rejects.toThrow('old entity offline')
        layer.stopRetries()

        const recovered: MatrixApplicationStateEventRequest[] = []
        await layer.setNativeRoomState(
            room,
            'io.codever.session.current.v2',
            'session-new',
            deletedSessionState('session-new', 2),
            {
                async sendEncryptedRoomEvent() {
                    throw new Error('not used')
                },
                async setApplicationRoomState(request) {
                    recovered.push(request)
                    return { eventId: '$new-current-state' }
                },
            },
        )
        layer.stopRetries()

        expect(firstAttempts.map(request => request.stateKey)).toEqual(['session-old-gap'])
        expect(recovered.map(request => request.stateKey)).toEqual(['session-new'])
    })

    it('rejects oversized content and never falls back from application events to Megolm', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-secure-matrix-'))
        temporaryDirectories.push(directory)
        const gateway = await generateDeviceKeyPair()
        const device = await generateDeviceKeyPair()
        const layer = new GatewaySecureContentLayer(
            'gateway-1',
            {
                gatewayDeviceId: 'gateway-1',
                gatewayKeyPair: await exportDeviceKeyPair(gateway),
                envelopeReplayLedgerPath: join(directory, 'envelopes.json'),
            },
            [{
                deviceId: 'phone-1',
                publicKey: device.publicJwk,
                allowedRoomIds: ['!room:localhost'],
                allowedOperations: ['prompt'],
                matrixUserId: '@phone:localhost',
                matrixDeviceId: 'PHONE_MATRIX',
                matrixDeviceKeys: ['phone-matrix-ed25519'],
                certificateExpiresAt: now + 60_000,
                sequenceEpoch: 'certificate-phone-1',
            }],
        )
        await layer.initialize(now)
        let megolmCalls = 0
        const transport: MatrixTransport = {
            async sendEncryptedRoomEvent() {
                megolmCalls += 1
                throw new Error('oversized content must not reach Matrix')
            },
        }
        const secureTransport = layer.transportForRoom({
            roomId: '!room:localhost',
            conversationId: 'conversation-1',
            cwd: '/repo',
            providerName: 'test',
        }, transport)

        await expect(secureTransport.sendEncryptedRoomEvent({
            roomId: '!room:localhost',
            eventType: 'm.room.message',
            transactionId: 'oversized-event',
            content: {
                msgtype: 'm.text',
                body: 'x'.repeat(30 * 1024),
                [CODEVER_MATRIX_EXTENSION]: { version: 1, kind: 'message' },
            },
        })).rejects.toThrow(/Matrix timeline event|too_big|32/i)

        await expect(secureTransport.sendEncryptedRoomEvent({
            roomId: '!room:localhost',
            eventType: 'm.room.message',
            transactionId: 'missing-direct-timeline',
            content: {
                msgtype: 'm.text',
                body: 'small current event',
                [CODEVER_MATRIX_EXTENSION]: { version: 1, kind: 'message' },
            },
        })).rejects.toThrow('application timeline events')
        await expect(layer.sendCommandAccepted(
            {
                roomId: '!room:localhost',
                conversationId: 'conversation-1',
                cwd: '/repo',
                providerName: 'test',
            },
            'phone-1',
            'missing-direct-control',
            1,
            1,
            'epoch-1',
            transport,
        )).rejects.toThrow('application control events')
        expect(megolmCalls).toBe(0)
        layer.stopRetries()
    })

    it('seals outgoing content and opens authenticated incoming content', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-secure-matrix-'))
        temporaryDirectories.push(directory)
        const gateway = await generateDeviceKeyPair()
        const device = await generateDeviceKeyPair()
        const trustedDevice = {
            deviceId: 'phone-1',
            publicKey: device.publicJwk,
            allowedRoomIds: ['!room:localhost'],
            allowedOperations: ['prompt'] as Array<'prompt'>,
            matrixUserId: '@phone:localhost',
            matrixDeviceId: 'PHONE_MATRIX',
            matrixDeviceKeys: ['phone-matrix-ed25519'],
            certificateExpiresAt: now + 60_000,
            sequenceEpoch: 'certificate-phone-1',
        }
        const layer = new GatewaySecureContentLayer(
            'gateway-1',
            {
                gatewayDeviceId: 'gateway-1',
                gatewayKeyPair: await exportDeviceKeyPair(gateway),
                envelopeReplayLedgerPath: join(directory, 'envelopes.json'),
            },
            [trustedDevice],
        )
        await layer.initialize(now)
        const sent: MatrixSendEventRequest[] = []
        const timelineSent: MatrixApplicationTimelineEventRequest[] = []
        const controlSent: MatrixApplicationControlEventRequest[] = []
        const matrix: MatrixTransport = {
            async sendEncryptedRoomEvent(request) {
                sent.push(request)
                return { eventId: '$event' }
            },
            async sendApplicationTimelineEvent(request) {
                timelineSent.push(request)
                return { eventId: '$timeline-event' }
            },
            async sendApplicationControlEvent(request) {
                controlSent.push(request)
                return { eventId: '$control-event' }
            },
        }
        const room = {
            roomId: '!room:localhost',
            conversationId: 'conversation-1',
            cwd: 'C:\\repo',
            providerName: 'test',
        }

        await layer.transportForRoom(room, matrix).sendEncryptedRoomEvent({
            roomId: room.roomId,
            eventType: 'm.room.message',
            content: {
                msgtype: 'm.text',
                body: 'agent secret reply',
                'm.relates_to': {
                    rel_type: 'm.thread',
                    event_id: '$session-root',
                    is_falling_back: true,
                    'm.in_reply_to': { event_id: '$session-root' },
                },
                [CODEVER_MATRIX_EXTENSION]: {
                    version: 1,
                    kind: 'message',
                    session_id: 'session-1',
                    thread_root_event_id: '$session-root',
                },
            },
            transactionId: 'transaction-1',
        })
        expect(sent).toHaveLength(0)
        expect(timelineSent).toHaveLength(1)
        expect(JSON.stringify(timelineSent)).not.toContain('agent secret reply')
        expect(timelineSent[0]?.eventType).toBe('m.room.message')
        expect(timelineSent[0]?.content['m.relates_to']).toMatchObject({
            rel_type: 'm.thread',
            event_id: '$session-root',
        })
        const outgoingExtension = timelineSent[0]?.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
        const openedGrant = await openSecureEnvelopeBundle(
            outgoingExtension.timeline_key_ring_bundle,
            {
            recipientPrivateKey: device.privateKey,
            senderPublicKey: gateway.publicKey,
            expected: {
                gatewayId: 'gateway-1',
                conversationId: 'conversation-1',
                direction: 'gateway_to_device',
                senderDeviceId: 'gateway-1',
                recipientDeviceId: 'phone-1',
                senderKeyId: gateway.keyId,
                recipientKeyId: device.keyId,
            },
            replayStore: new InMemoryReplayStore(),
            now: Date.now(),
            },
        )
        const grant = openedGrant.plaintext as {
                active_epoch_id: string
                epochs: Array<{ epoch_id: string; key: string }>
            }
        const activeKey = grant.epochs.find(epoch => epoch.epoch_id === grant.active_epoch_id)!
        const openedOutgoing = await openMatrixTimelineEnvelope(
            outgoingExtension.timeline_envelope,
            {
                timelineKey: base64UrlDecode(activeKey.key),
                gatewayPublicKey: gateway.publicKey,
                expected: {
                    gatewayId: 'gateway-1',
                    conversationId: 'conversation-1',
                    roomId: '!room:localhost',
                    epochId: activeKey.epoch_id,
                    sessionId: 'session-1',
                    threadRootEventId: '$session-root',
                },
            },
        )
        expect(openedOutgoing.plaintext).toMatchObject({ body: 'agent secret reply' })

        await layer.sendCommandAccepted(
            room,
            'phone-1',
            'command-1',
            1,
            1,
            'gateway-key-epoch',
            matrix,
        )
        expect(controlSent[0]?.eventType).toBe('io.codever.secure_control.v1')
        expect(controlSent[0]?.content).not.toHaveProperty('io.codever.command_id')
        expect(JSON.stringify(controlSent[0]?.content)).not.toContain('"command_id"')
        const ackExtension = controlSent[0]?.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
        const openedAck = await openSecureEnvelope(ackExtension.secure_envelope, {
            recipientPrivateKey: device.privateKey,
            senderPublicKey: gateway.publicKey,
            expected: {
                gatewayId: 'gateway-1',
                conversationId: 'conversation-1',
                direction: 'gateway_to_device',
                senderDeviceId: 'gateway-1',
                recipientDeviceId: 'phone-1',
                senderKeyId: gateway.keyId,
                recipientKeyId: device.keyId,
            },
            replayStore: new InMemoryReplayStore(),
            now: Date.now(),
        })
        expect(openedAck.plaintext).toMatchObject({
            [CODEVER_MATRIX_EXTENSION]: {
                kind: 'command_ack',
                command_id: 'command-1',
                sequence: 1,
            },
        })

        const incoming = await sealSecureEnvelope({
            plaintext: {
                msgtype: 'm.text',
                body: 'private prompt',
                [CODEVER_MATRIX_EXTENSION]: { version: 1, kind: 'signed_command' },
            },
            gatewayId: 'gateway-1',
            conversationId: 'conversation-1',
            direction: 'device_to_gateway',
            senderDeviceId: 'phone-1',
            recipientDeviceId: 'gateway-1',
            senderKeyId: device.keyId,
            recipientKeyId: gateway.keyId,
            senderPrivateKey: device.privateKey,
            recipientPublicKey: gateway.publicKey,
            now,
        })
        await expect(layer.openIncoming({
            version: 1,
            kind: 'secure_envelope',
            secure_envelope: incoming,
        }, room, now + 1)).resolves.toMatchObject({
            authenticatedDeviceId: 'phone-1',
            content: { body: 'private prompt' },
        })
    })

    it('rejects an expired pairing certificate before opening content', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-secure-matrix-'))
        temporaryDirectories.push(directory)
        const gateway = await generateDeviceKeyPair()
        const device = await generateDeviceKeyPair()
        const layer = new GatewaySecureContentLayer(
            'gateway-1',
            {
                gatewayDeviceId: 'gateway-1',
                gatewayKeyPair: await exportDeviceKeyPair(gateway),
                envelopeReplayLedgerPath: join(directory, 'envelopes.json'),
            },
            [{
                deviceId: 'phone-1',
                publicKey: device.publicJwk,
                allowedRoomIds: ['!room:localhost'],
                matrixUserId: '@phone:localhost',
                matrixDeviceId: 'PHONE_MATRIX',
                matrixDeviceKeys: ['phone-matrix-ed25519'],
                certificateExpiresAt: now,
                sequenceEpoch: 'certificate-phone-1',
            }],
        )
        await layer.initialize(now)
        expect(() => layer.transportForRoom({
            roomId: '!room:localhost',
            conversationId: 'conversation-1',
            cwd: 'C:\\repo',
            providerName: 'test',
        }, {
            async sendEncryptedRoomEvent() {
                return { eventId: '$event' }
            },
        })).not.toThrow()
        await expect(layer.openIncoming({
            version: 1,
            kind: 'secure_envelope',
            secure_envelope: { envelope: { senderDeviceId: 'phone-1' } },
        }, {
            roomId: '!room:localhost',
            conversationId: 'conversation-1',
            cwd: 'C:\\repo',
            providerName: 'test',
        }, now)).rejects.toThrow(/certificate has expired|not trusted/)
    })
})

function deletedSessionState(sessionId: string, stateVersion: number) {
    return {
        version: 2 as const,
        kind: 'session_state' as const,
        gateway_id: 'gateway-1',
        conversation_id: 'conversation-1',
        revision: stateVersion,
        revision_epoch: 'epoch-1',
        revision_epoch_generation: 1,
        state_version: stateVersion,
        session_id: sessionId,
        state: 'deleted' as const,
        updated_at: now + stateVersion,
    }
}
