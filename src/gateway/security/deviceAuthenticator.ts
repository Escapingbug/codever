import {
    createOpaqueCredentialRegistrationResponse,
    finishOpaqueCredentialServerLogin,
    getOpaqueServerPublicKey,
    OpaquePairingAuthority,
    startOpaqueCredentialServerLogin,
    type OpaquePairingTicket,
} from '@codever/secure-channel'
import type { DeviceCredentialRecord, DeviceCredentialStore } from './deviceCredentialRepository'

interface PendingCredentialHandshake {
    mode: 'credential'
    credentialId: string
    serverLoginState: string
    expiresAtMs: number
}

interface PendingPairingHandshake {
    mode: 'pairing'
    credentialId: string
    authorityHandshakeId: string
    expiresAtMs: number
}

type PendingHandshake = PendingCredentialHandshake | PendingPairingHandshake

/** Authenticates devices against a Gateway identity using one-time pairing or a durable credential. */
export class DeviceAuthenticator {
    private readonly handshakes = new Map<string, PendingHandshake>()

    private constructor(
        readonly gatewayId: string,
        readonly serverSetup: string,
        readonly pairing: OpaquePairingAuthority,
        private readonly credentials: DeviceCredentialStore,
        private readonly now: () => number,
        private readonly randomId: () => string,
        private readonly handshakeTtlMs: number,
    ) {}

    static async create(input: {
        gatewayId: string
        serverSetup: string
        credentials: DeviceCredentialStore
        now?: () => number
        randomId?: () => string
        pairingTtlMs?: number
        handshakeTtlMs?: number
        maxPairingAttempts?: number
    }): Promise<DeviceAuthenticator> {
        if (!input.gatewayId.trim()) throw new Error('gatewayId is required')
        const now = input.now ?? Date.now
        const randomId = input.randomId ?? (() => globalThis.crypto.randomUUID())
        const pairingTtlMs = input.pairingTtlMs ?? 3 * 60_000
        const handshakeTtlMs = input.handshakeTtlMs ?? 30_000
        const maxPairingAttempts = input.maxPairingAttempts ?? 5
        const pairing = await OpaquePairingAuthority.create({
            serverId: input.gatewayId,
            serverSetup: input.serverSetup,
            now,
            randomId,
            pairingTtlMs,
            handshakeTtlMs,
            maxAttempts: maxPairingAttempts,
        })
        return new DeviceAuthenticator(
            input.gatewayId,
            input.serverSetup,
            pairing,
            input.credentials,
            now,
            randomId,
            handshakeTtlMs,
        )
    }

    issuePairing(): OpaquePairingTicket {
        return this.pairing.issue()
    }

    async createCredentialRegistrationResponse(credentialId: string, registrationRequest: string): Promise<{
        registrationResponse: string
        serverStaticPublicKey: string
    }> {
        assertCredentialId(credentialId)
        return {
            registrationResponse: await createOpaqueCredentialRegistrationResponse({
                serverSetup: this.serverSetup,
                subjectId: credentialId,
                serverId: this.gatewayId,
                registrationRequest,
            }),
            serverStaticPublicKey: await getOpaqueServerPublicKey(this.serverSetup),
        }
    }

    async commitCredential(credentialId: string, registrationRecord: string, label?: string): Promise<DeviceCredentialRecord> {
        return this.credentials.put(credentialId, registrationRecord, label)
    }

    async revoke(credentialId: string): Promise<boolean> {
        return this.credentials.revoke(credentialId)
    }

    async begin(input: {
        mode: 'pairing' | 'credential'
        credentialId: string
        subjectId: string
        startLoginRequest: string
    }): Promise<{
        handshakeId: string
        loginResponse: string
        expiresAt: string
        attemptsRemaining?: number
    }> {
        this.prune()
        assertCredentialId(input.credentialId)
        if (input.mode === 'pairing') {
            const started = this.pairing.begin(input.subjectId, input.startLoginRequest)
            this.handshakes.set(started.handshakeId, {
                mode: 'pairing',
                credentialId: input.credentialId,
                authorityHandshakeId: started.handshakeId,
                expiresAtMs: Date.parse(started.expiresAt),
            })
            return {
                handshakeId: started.handshakeId,
                loginResponse: started.loginResponse,
                expiresAt: started.expiresAt,
                attemptsRemaining: started.attemptsRemaining,
            }
        }

        if (input.subjectId !== input.credentialId) throw new Error('Device credential subject must match credentialId')
        const credential = await this.credentials.get(input.credentialId)
        if (!credential || !credential.enabled) throw new Error('Device credential is unknown or disabled')
        const started = await startOpaqueCredentialServerLogin({
            serverSetup: this.serverSetup,
            registrationRecord: credential.registrationRecord,
            subjectId: input.credentialId,
            serverId: this.gatewayId,
            startLoginRequest: input.startLoginRequest,
        })
        const handshakeId = this.randomId()
        const expiresAtMs = this.now() + this.handshakeTtlMs
        this.handshakes.set(handshakeId, {
            mode: 'credential',
            credentialId: input.credentialId,
            serverLoginState: started.serverLoginState,
            expiresAtMs,
        })
        return {
            handshakeId,
            loginResponse: started.loginResponse,
            expiresAt: new Date(expiresAtMs).toISOString(),
        }
    }

    async finish(input: { handshakeId: string; finishLoginRequest: string }): Promise<{
        credentialId: string
        sessionKey: string
        credentialProvisioningRequired: boolean
    }> {
        this.prune()
        const handshake = this.handshakes.get(input.handshakeId)
        if (!handshake) throw new Error('Gateway device handshake is invalid or expired')
        // Consume before verifying the final proof so success and failure are both one-shot.
        this.handshakes.delete(input.handshakeId)
        if (handshake.mode === 'pairing') {
            const finished = this.pairing.finish(handshake.authorityHandshakeId, input.finishLoginRequest)
            return {
                credentialId: handshake.credentialId,
                sessionKey: finished.sessionKey,
                credentialProvisioningRequired: true,
            }
        }
        const sessionKey = await finishOpaqueCredentialServerLogin({
            serverLoginState: handshake.serverLoginState,
            finishLoginRequest: input.finishLoginRequest,
            subjectId: handshake.credentialId,
            serverId: this.gatewayId,
        })
        return {
            credentialId: handshake.credentialId,
            sessionKey,
            credentialProvisioningRequired: false,
        }
    }

    private prune(): void {
        const now = this.now()
        for (const [handshakeId, handshake] of this.handshakes) {
            if (handshake.expiresAtMs <= now) this.handshakes.delete(handshakeId)
        }
    }
}

function assertCredentialId(credentialId: string): void {
    if (!credentialId.trim()) throw new Error('credentialId is required')
}
