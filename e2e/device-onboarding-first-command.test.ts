import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
    type CodeverCommand,
    type MatrixTransportBinding,
} from '@codever/protocol'
import {
    generateDeviceKeyPair,
    PairingOfferGuard,
    signCommand,
} from '@codever/security'
import { FileReplayStore } from '@codever/security/node'
import {
    DeviceInvitationCoordinator,
    FileGatewayIdentityStore,
    FileTrustedDeviceRegistry,
    GatewayPairingService,
    trustedDeviceFromRecord,
} from '@/gateway/pairing'
import {
    FileCommandReplayStore,
    StrictMatrixCommandAuthorizer,
} from '@/gateway/matrix'
import {
    completePairing,
    decodeDeviceInvitationLink,
    inspectPairingLink,
    pairingLinkFromDeviceInvitation,
    trustedGatewayConfig,
} from '../apps/pwa/app/pairing'
import type { DeviceIdentity } from '../apps/pwa/app/matrix'

const temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory =>
        rm(directory, { recursive: true, force: true })))
})

describe('device invitation to first Gateway command', () => {
    it('pairs from a one-time invitation and authorizes the new device immediately', async () => {
        const now = Date.now()
        const directory = await temporaryDirectory()
        const identity = await new FileGatewayIdentityStore(
            join(directory, 'gateway-identity.json'),
        ).loadOrCreate('gateway-onboarding-e2e', now)
        const registry = new FileTrustedDeviceRegistry(join(directory, 'registry.json'))
        const pairingService = new GatewayPairingService(
            identity,
            registry,
            new PairingOfferGuard(
                new FileReplayStore(join(directory, 'pairing-replay.json')),
            ),
        )
        const coordinator = new DeviceInvitationCoordinator(
            pairingService,
            registry,
            {
                gatewayName: 'Onboarding E2E Gateway',
                gatewayTransport,
                now: () => now,
                matrixLoginTokenIssuer: {
                    async issue() {
                        return {
                            status: 'ready',
                            invitation: {
                                homeserver: 'https://matrix.example',
                                userId: '@phone:example',
                                loginToken: 'one-time-onboarding-token',
                                expiresAt: now + 120_000,
                            },
                        }
                    },
                },
            },
        )

        const invitation = await coordinator.create({
            source: { kind: 'local-admin' },
            matrixLogin: 'required',
            appUrl: 'https://codever.example/',
        })
        const decoded = decodeDeviceInvitationLink(invitation.invitationLink)
        expect(decoded.matrixLogin).toMatchObject({
            homeserver: 'https://matrix.example',
            userId: '@phone:example',
            loginToken: 'one-time-onboarding-token',
        })
        const preview = await inspectPairingLink(
            pairingLinkFromDeviceInvitation(decoded),
            now,
        )
        expect(preview.verificationCode.replaceAll(' ', ''))
            .toBe(invitation.verificationCode.replaceAll(' ', ''))

        const deviceKeys = await generateDeviceKeyPair()
        const deviceIdentity: DeviceIdentity = {
            keyId: deviceKeys.keyId,
            privateKey: deviceKeys.privateKey,
            publicKey: deviceKeys.publicKey,
            publicJwk: deviceKeys.publicJwk,
        }
        const trust = await completePairing(
            preview,
            deviceIdentity,
            deviceTransport(deviceIdentity.keyId),
            'Android onboarding E2E',
            {
                async exchange(request) {
                    return (await pairingService.receiveRequest(request)).response
                },
            },
        )
        expect(trust).toMatchObject({
            gatewayId: 'gateway-onboarding-e2e',
            gatewayName: 'Onboarding E2E Gateway',
            activeDeviceCount: 1,
        })
        expect(trustedGatewayConfig(trust)).toEqual({
            gatewayId: 'gateway-onboarding-e2e',
            homeserver: 'https://matrix.example',
            roomId: '!codever:example',
            gatewayMatrixUserId: '@gateway:example',
            gatewayMatrixDeviceId: 'GATEWAY_DEVICE',
            gatewayMatrixEd25519: 'gateway-ed25519-key',
        })

        const record = await registry.get(deviceIdentity.keyId)
        expect(record).toMatchObject({ status: 'active' })
        if (!record || record.status !== 'active') {
            throw new Error('The paired device was not activated')
        }
        const policy = trustedDeviceFromRecord(record)
        expect(policy.allowedOperations).toEqual(expect.arrayContaining([
            'session.create',
            'session.archive',
            'session.restore',
            'session.delete',
        ]))

        // The first command proves that pairing produced executable Gateway
        // authority, not merely a certificate that the UI could display.
        const replayStore = new FileCommandReplayStore(
            join(directory, 'commands.jsonl'),
        )
        const authorizer = new StrictMatrixCommandAuthorizer(
            identity.gatewayId,
            [policy],
            replayStore,
        )
        await authorizer.initialize(now)
        const firstCommand = await createFirstSessionCommand(
            identity.gatewayId,
            deviceKeys,
            record.certificate.certificate.certificateId,
            now,
        )
        await expect(authorizer.authorizeDelivery(
            firstCommand,
            {
                roomId: '!codever:example',
                conversationId: 'conversation-onboarding-e2e',
                revisionEpoch: 'runtime-onboarding-e2e',
                matrixSender: '@phone:example',
                matrixDeviceKey: 'application-envelope',
                applicationDeviceId: deviceIdentity.keyId,
            },
            now,
        )).resolves.toMatchObject({
            duplicate: false,
            revision: 1,
            command: {
                operation: 'session.create',
                sequence: 1,
                baseRevision: 0,
            },
        })
    })
})

async function createFirstSessionCommand(
    gatewayId: string,
    keys: Awaited<ReturnType<typeof generateDeviceKeyPair>>,
    sequenceEpoch: string,
    now: number,
) {
    const command: CodeverCommand = {
        kind: 'codever.command',
        version: 1,
        commandId: randomUUID(),
        gatewayId,
        deviceId: keys.keyId,
        sequenceEpoch,
        conversationId: 'conversation-onboarding-e2e',
        revisionEpoch: 'runtime-onboarding-e2e',
        sequence: 1,
        baseRevision: 0,
        operation: 'session.create',
        issuedAt: now,
        expiresAt: now + 60_000,
        nonce: randomBytes(18).toString('base64url'),
        payload: {
            operation: 'session.create',
            cwd: '/workspace/codever',
            projectName: 'codever',
        },
    }
    return signCommand(command, keys.privateKey, keys.keyId)
}

function gatewayTransport(): MatrixTransportBinding {
    return {
        homeserver: 'https://matrix.example',
        roomId: '!codever:example',
        userId: '@gateway:example',
        deviceId: 'GATEWAY_DEVICE',
        ed25519: 'gateway-ed25519-key',
    }
}

function deviceTransport(deviceId: string): MatrixTransportBinding {
    return {
        homeserver: 'https://matrix.example',
        roomId: '!codever:example',
        userId: '@phone:example',
        deviceId: 'PHONE_DEVICE',
        ed25519: `phone-ed25519-${deviceId}`,
    }
}

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'codever-onboarding-e2e-'))
    temporaryDirectories.push(directory)
    return directory
}
