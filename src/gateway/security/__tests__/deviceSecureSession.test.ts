import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
    parseDeviceCredentialFrame,
    parseDeviceSecureHandshakeFrame,
    parseGatewaySecureAuthAcceptedPayload,
    parseSecureDataFrame,
    type ClientGatewayResponseFrame,
} from '@codever/protocol'
import {
    finishOpaqueCredentialClientLogin,
    finishOpaqueCredentialRegistration,
    finishOpaquePairingClient,
    generateOpaqueCredentialSecret,
    SessionCipher,
    startOpaqueCredentialLogin,
    startOpaqueCredentialRegistration,
    startOpaquePairingClient,
} from '@codever/secure-channel'
import { afterEach, describe, expect, it } from 'vitest'
import { DeviceAuthenticator } from '../deviceAuthenticator'
import { DeviceCredentialRepository } from '../deviceCredentialRepository'
import { decodeOpaquePayload, DeviceSecureSession, encodeOpaquePayload } from '../deviceSecureSession'

const directories: string[] = []

afterEach(async () => {
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('DeviceSecureSession', () => {
    it('consumes one-time pairing, provisions a durable credential, and reconnects E2E', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-device-session-'))
        directories.push(directory)
        const repository = await DeviceCredentialRepository.open(join(directory, 'devices.json'))
        const authenticator = await DeviceAuthenticator.create({
            gatewayId: 'gateway-1', serverSetup: repository.serverSetup, credentials: repository,
        })
        const ticket = authenticator.issuePairing()
        const credentialId = 'device-1'
        const first = harness(authenticator)

        const pairingStart = await startOpaquePairingClient(ticket.code)
        await first.session.receive(encodeOpaquePayload({
            version: 1,
            type: 'client.secure-auth.start',
            messageId: 'pair-start',
            payload: {
                mode: 'pairing', credentialId, subjectId: pairingStart.pairingId,
                startLoginRequest: pairingStart.startLoginRequest,
            },
        }))
        const challenge = parseDeviceSecureHandshakeFrame(decodeOpaquePayload(first.take()))
        expect(challenge.type).toBe('gateway.secure-auth.response')
        if (challenge.type !== 'gateway.secure-auth.response') throw new Error('Expected auth response')
        const pairingFinish = finishOpaquePairingClient({
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
        const clientCipher = await SessionCipher.create({
            sessionKey: pairingFinish.sessionKey,
            role: 'initiator',
            channelId: accepted.payload.envelope.channelId,
        })
        expect(parseGatewaySecureAuthAcceptedPayload(await clientCipher.decrypt(accepted.payload.envelope))).toMatchObject({
            gatewayId: 'gateway-1', credentialId, credentialProvisioningRequired: true,
        })

        const credentialSecret = generateOpaqueCredentialSecret()
        const registration = await startOpaqueCredentialRegistration(credentialSecret)
        await sendEncrypted(first.session, clientCipher, {
            version: 1,
            type: 'device.credential.registration.start',
            messageId: 'registration-start',
            payload: { deviceId: credentialId, registrationRequest: registration.registrationRequest },
        })
        const registrationResponse = parseDeviceCredentialFrame(await decryptOutput(first.take(), clientCipher))
        if (registrationResponse.type !== 'device.credential.registration.response') throw new Error('Expected registration response')
        const registered = await finishOpaqueCredentialRegistration({
            secret: credentialSecret,
            subjectId: credentialId,
            serverId: 'gateway-1',
            clientRegistrationState: registration.clientRegistrationState,
            registrationResponse: registrationResponse.payload.registrationResponse,
            expectedServerStaticPublicKey: pairingFinish.serverStaticPublicKey,
        })
        await sendEncrypted(first.session, clientCipher, {
            version: 1,
            type: 'device.credential.registration.commit',
            messageId: 'registration-commit',
            payload: { deviceId: credentialId, registrationRecord: registered.registrationRecord },
        })
        expect(parseDeviceCredentialFrame(await decryptOutput(first.take(), clientCipher))).toMatchObject({
            type: 'device.credential.registration.accepted', payload: { deviceId: credentialId },
        })
        expect(first.session.ready).toBe(true)
        expect(await repository.get(credentialId)).toMatchObject({ credentialId, enabled: true })

        const replay = harness(authenticator)
        const replayStart = await startOpaquePairingClient(ticket.code)
        await expect(replay.session.receive(encodeOpaquePayload({
            version: 1,
            type: 'client.secure-auth.start',
            messageId: 'replay-start',
            payload: {
                mode: 'pairing', credentialId: 'attacker-device', subjectId: replayStart.pairingId,
                startLoginRequest: replayStart.startLoginRequest,
            },
        }))).rejects.toThrow('Pairing is not open')

        const reconnect = harness(authenticator)
        const login = await startOpaqueCredentialLogin(credentialSecret)
        await reconnect.session.receive(encodeOpaquePayload({
            version: 1,
            type: 'client.secure-auth.start',
            messageId: 'credential-start',
            payload: { mode: 'credential', credentialId, subjectId: credentialId, startLoginRequest: login.startLoginRequest },
        }))
        const loginResponse = parseDeviceSecureHandshakeFrame(decodeOpaquePayload(reconnect.take()))
        if (loginResponse.type !== 'gateway.secure-auth.response') throw new Error('Expected credential response')
        const loginFinish = await finishOpaqueCredentialClientLogin({
            secret: credentialSecret,
            subjectId: credentialId,
            serverId: 'gateway-1',
            clientLoginState: login.clientLoginState,
            loginResponse: loginResponse.payload.loginResponse,
            expectedServerStaticPublicKey: registered.serverStaticPublicKey,
        })
        await reconnect.session.receive(encodeOpaquePayload({
            version: 1,
            type: 'client.secure-auth.finish',
            messageId: 'credential-finish',
            payload: { handshakeId: loginResponse.payload.handshakeId, finishLoginRequest: loginFinish.finishLoginRequest },
        }))
        const reconnectAccepted = parseDeviceSecureHandshakeFrame(decodeOpaquePayload(reconnect.take()))
        if (reconnectAccepted.type !== 'gateway.secure-auth.accepted') throw new Error('Expected reconnect acceptance')
        const reconnectCipher = await SessionCipher.create({
            sessionKey: loginFinish.sessionKey,
            role: 'initiator',
            channelId: reconnectAccepted.payload.envelope.channelId,
        })
        expect(parseGatewaySecureAuthAcceptedPayload(await reconnectCipher.decrypt(reconnectAccepted.payload.envelope)))
            .toMatchObject({ credentialProvisioningRequired: false })

        await sendEncrypted(reconnect.session, reconnectCipher, {
            version: 1,
            type: 'client.gateway.request',
            requestId: 'request-1',
            idempotencyKey: 'idempotency-1',
            payload: { kind: 'inventory.get' },
        })
        expect(await decryptOutput(reconnect.take(), reconnectCipher)).toMatchObject({
            type: 'gateway.client.response', requestId: 'request-1', status: 'completed',
        })
    }, 30_000)
})

function harness(authenticator: DeviceAuthenticator) {
    const output: string[] = []
    const session = new DeviceSecureSession({
        gatewayId: 'gateway-1',
        authenticator,
        send: value => { output.push(value) },
        handleRequest: request => ({
            version: 1,
            type: 'gateway.client.response',
            requestId: request.requestId,
            status: 'completed',
            completedAt: new Date().toISOString(),
            payload: { generatedAt: new Date().toISOString(), revision: 1, projects: [], sessions: [] },
        } satisfies ClientGatewayResponseFrame),
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

async function sendEncrypted(session: DeviceSecureSession, cipher: SessionCipher, value: unknown): Promise<void> {
    await session.receive(encodeOpaquePayload({
        version: 1,
        type: 'secure.data',
        messageId: globalThis.crypto.randomUUID(),
        envelope: await cipher.encrypt(value),
    }))
}

async function decryptOutput(output: string, cipher: SessionCipher): Promise<unknown> {
    return cipher.decrypt(parseSecureDataFrame(decodeOpaquePayload(output)).envelope)
}
