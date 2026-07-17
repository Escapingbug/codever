import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    parseDeviceBindingFrame,
    parseDeviceHpkeDataFrame,
    parseDeviceKeyProvisioningFrame,
    parseDeviceSecureHandshakeFrame,
    parseGatewaySecureAuthAcceptedPayload,
    parseSecureDataFrame,
    type ClientGatewayResponseFrame,
    type DeviceHpkeDataFrame,
} from '@codever/protocol'
import {
    finishOpaquePairingClient,
    generateHpkeKeyPair,
    HpkeMessageCipher,
    SessionCipher,
    startOpaquePairingClient,
} from '@codever/secure-channel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeviceAuthenticator } from '../deviceAuthenticator'
import { DeviceCredentialRepository } from '../deviceCredentialRepository'
import { decodeOpaquePayload, DeviceSecureSession, encodeOpaquePayload } from '../deviceSecureSession'

const directories: string[] = []

afterEach(async () => {
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('DeviceSecureSession', () => {
    it('pairs once, binds by HPKE on reconnect, deduplicates replay, and enforces revocation', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-device-session-'))
        directories.push(directory)
        const repository = await DeviceCredentialRepository.open(join(directory, 'devices.json'))
        const authenticator = await DeviceAuthenticator.create({
            gatewayId: 'gateway-1',
            serverSetup: repository.serverSetup,
            credentials: repository,
            hpkeKeyPair: repository.hpkeKeyPair,
        })
        const ticket = authenticator.issuePairing()
        const credentialId = 'device-1'
        const handleRequest = vi.fn((request: { requestId: string }) => ({
            version: 1,
            type: 'gateway.client.response',
            requestId: request.requestId,
            status: 'completed',
            completedAt: new Date().toISOString(),
            payload: { generatedAt: new Date().toISOString(), revision: 1, projects: [], sessions: [] },
        } satisfies ClientGatewayResponseFrame))
        const first = harness(authenticator, handleRequest)

        const pairingStart = await startOpaquePairingClient(ticket.code)
        await first.session.receive(encodeOpaquePayload({
            version: 1,
            type: 'client.secure-auth.start',
            messageId: 'pair-start',
            payload: {
                credentialId,
                pairingId: pairingStart.pairingId,
                startLoginRequest: pairingStart.startLoginRequest,
            },
        }))
        const challenge = parseDeviceSecureHandshakeFrame(decodeOpaquePayload(first.take()))
        if (challenge.type !== 'gateway.secure-auth.response') throw new Error('Expected auth response')
        const pairingFinish = finishOpaquePairingClient({
            domain: 'gateway-device',
            code: ticket.code,
            serverId: 'gateway-1',
            clientLoginState: pairingStart.clientLoginState,
            loginResponse: challenge.payload.loginResponse,
        })
        await first.session.receive(encodeOpaquePayload({
            version: 1,
            type: 'client.secure-auth.finish',
            messageId: 'pair-finish',
            payload: { handshakeId: challenge.payload.handshakeId, finishLoginRequest: pairingFinish.finishLoginRequest },
        }))
        const accepted = parseDeviceSecureHandshakeFrame(decodeOpaquePayload(first.take()))
        if (accepted.type !== 'gateway.secure-auth.accepted') throw new Error('Expected auth acceptance')
        const provisioningCipher = await SessionCipher.create({
            sessionKey: pairingFinish.sessionKey,
            role: 'initiator',
            channelId: accepted.payload.envelope.channelId,
        })
        const acceptedPayload = parseGatewaySecureAuthAcceptedPayload(
            await provisioningCipher.decrypt(accepted.payload.envelope),
        )
        expect(acceptedPayload).toMatchObject({ gatewayId: 'gateway-1', credentialId })

        const deviceKeys = await generateHpkeKeyPair()
        await sendTemporary(first.session, provisioningCipher, {
            version: 1,
            type: 'device.key.register',
            messageId: 'key-register',
            payload: {
                deviceId: credentialId,
                deviceHpkeKeyId: deviceKeys.keyId,
                deviceHpkePublicKey: deviceKeys.publicKey,
            },
        })
        const registered = parseDeviceKeyProvisioningFrame(await decryptTemporary(first.take(), provisioningCipher))
        expect(registered).toMatchObject({ type: 'gateway.key.registered', payload: { deviceId: credentialId } })
        expect(await repository.get(credentialId)).toMatchObject({
            credentialId, enabled: true, hpkeKeyId: deviceKeys.keyId, hpkePublicKey: deviceKeys.publicKey,
        })

        const clientCipher = await HpkeMessageCipher.create({
            localId: credentialId,
            remoteId: 'gateway-1',
            localKeyPair: deviceKeys,
            remoteKey: { keyId: acceptedPayload.gatewayHpkeKeyId, publicKey: acceptedPayload.gatewayHpkePublicKey },
        })
        await sendHpke(first.session, clientCipher, bindFrame('bind-1', credentialId), 'bind-wire-1')
        expect(await decryptHpke(first.take(), clientCipher)).toMatchObject({ type: 'gateway.bound' })
        expect(first.session.ready).toBe(true)

        const request = {
            version: 1,
            type: 'client.gateway.request',
            requestId: 'request-1',
            idempotencyKey: 'idempotency-1',
            payload: { kind: 'inventory.get' },
        }
        const encodedRequest = await encodeHpke(clientCipher, request, 'wire-request-1')
        await first.session.receive(encodedRequest)
        const firstResponse = first.take()
        expect(await decryptHpke(firstResponse, clientCipher)).toMatchObject({
            type: 'gateway.client.response', requestId: 'request-1', status: 'completed',
        })
        await first.session.receive(encodedRequest)
        expect(first.take()).toBe(firstResponse)
        expect(handleRequest).toHaveBeenCalledTimes(1)

        const reconnect = harness(authenticator, handleRequest)
        await sendHpke(reconnect.session, clientCipher, bindFrame('bind-2', credentialId), 'bind-wire-2')
        expect(await decryptHpke(reconnect.take(), clientCipher)).toMatchObject({ type: 'gateway.bound' })
        expect(reconnect.session.ready).toBe(true)

        await authenticator.revoke(credentialId)
        await expect(sendHpke(reconnect.session, clientCipher, {
            ...request, requestId: 'request-2', idempotencyKey: 'idempotency-2',
        }, 'wire-request-2')).rejects.toThrow('revoked')
    }, 30_000)
})

function harness(authenticator: DeviceAuthenticator, handleRequest: (request: any) => ClientGatewayResponseFrame) {
    const output: string[] = []
    const session = new DeviceSecureSession({
        gatewayId: 'gateway-1',
        authenticator,
        send: value => { output.push(value) },
        handleRequest,
    })
    return {
        session,
        take() {
            const value = output.shift()
            if (!value) throw new Error('Expected secure session output')
            return value
        },
    }
}

function bindFrame(messageId: string, credentialId: string) {
    return {
        version: 1,
        type: 'device.bind',
        messageId,
        payload: {
            gatewayId: 'gateway-1', credentialId, boundAt: new Date().toISOString(),
        },
    }
}

async function sendTemporary(session: DeviceSecureSession, cipher: SessionCipher, value: unknown): Promise<void> {
    await session.receive(encodeOpaquePayload({
        version: 1,
        type: 'secure.data',
        messageId: globalThis.crypto.randomUUID(),
        envelope: await cipher.encrypt(value),
    }))
}

async function decryptTemporary(output: string, cipher: SessionCipher): Promise<unknown> {
    return cipher.decrypt(parseSecureDataFrame(decodeOpaquePayload(output)).envelope)
}

async function sendHpke(
    session: DeviceSecureSession,
    cipher: HpkeMessageCipher,
    value: unknown,
    messageId: string,
): Promise<void> {
    await session.receive(await encodeHpke(cipher, value, messageId))
}

async function encodeHpke(cipher: HpkeMessageCipher, value: unknown, messageId: string): Promise<string> {
    return encodeOpaquePayload({
        version: 1,
        type: 'device.hpke-data',
        messageId,
        envelope: await cipher.encrypt(value, { messageId }),
    } satisfies DeviceHpkeDataFrame)
}

async function decryptHpke(output: string, cipher: HpkeMessageCipher): Promise<unknown> {
    const frame = parseDeviceHpkeDataFrame(decodeOpaquePayload(output))
    return cipher.decrypt(frame.envelope)
}
