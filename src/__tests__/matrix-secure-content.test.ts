import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
    exportDeviceKeyPair,
    generateDeviceKeyPair,
    InMemoryReplayStore,
    openSecureEnvelope,
    sealSecureEnvelope,
} from '@codever/security'
import type {
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
        const matrix: MatrixTransport = {
            async sendEncryptedRoomEvent(request) {
                sent.push(request)
                return { eventId: '$event' }
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
                [CODEVER_MATRIX_EXTENSION]: { version: 1, kind: 'message' },
            },
            transactionId: 'transaction-1',
        })
        expect(JSON.stringify(sent[0]?.content)).not.toContain('agent secret reply')
        const outgoingExtension = sent[0]?.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
        const openedOutgoing = await openSecureEnvelope(outgoingExtension.secure_envelope, {
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
        const ackExtension = sent[1]?.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
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

        await layer.sendGatewayState(room, {
            revision: 0,
            revisionEpoch: 'gateway-key-epoch',
            stateVersion: 1,
            currentSessionId: null,
            sessions: [],
            workspace: {
                cwd: 'C:\\repo',
                provider: 'codex',
                permissionMode: 'default',
            },
            capabilities: {
                models: [{ id: 'gpt-test', name: 'GPT Test' }],
                permissionModes: [{ id: 'default', name: 'Default' }],
                canCreateSession: true,
                canSelectSession: true,
            },
        }, matrix)
        const stateExtension = sent[2]?.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
        const openedState = await openSecureEnvelope(stateExtension.secure_envelope, {
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
        expect(openedState.plaintext).toMatchObject({
            [CODEVER_MATRIX_EXTENSION]: {
                version: 1,
                kind: 'gateway_state',
                revision: 0,
                revision_epoch: 'gateway-key-epoch',
                state_version: 1,
                active_device_count: 1,
                current_session_id: null,
                sessions: [],
                workspace: {
                    cwd: 'C:\\repo',
                    provider: 'codex',
                    permission_mode: 'default',
                },
                capabilities: {
                    models: [{ id: 'gpt-test', name: 'GPT Test' }],
                    permission_modes: [{ id: 'default', name: 'Default' }],
                    can_create_session: true,
                    can_select_session: true,
                },
            },
        })
        const firstStateTransaction = sent[2]!.transactionId
        await layer.sendGatewayState(room, {
            revision: 0,
            revisionEpoch: 'gateway-key-epoch',
            stateVersion: 2,
            currentSessionId: null,
            sessions: [],
            workspace: {
                cwd: 'C:\\repo',
                provider: 'codex',
                permissionMode: 'default',
            },
            capabilities: {
                models: [{ id: 'gpt-test', name: 'GPT Test' }],
                permissionModes: [{ id: 'default', name: 'Default' }],
                canCreateSession: true,
                canSelectSession: true,
            },
        }, matrix)
        expect(sent[3]!.transactionId).not.toBe(firstStateTransaction)

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
                matrixDeviceKeys: ['phone-matrix-ed25519'],
                certificateExpiresAt: now,
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
