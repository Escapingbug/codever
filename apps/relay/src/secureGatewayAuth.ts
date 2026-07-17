import {
    createOpaqueCredentialRegistrationResponse,
    finishOpaqueCredentialServerLogin,
    getOpaqueServerPublicKey,
    OpaquePairingAuthority,
    startOpaqueCredentialServerLogin,
    type OpaquePairingTicket,
} from '@codever/secure-channel'

export interface GatewayCredentialRecord {
    gatewayId: string
    registrationRecord: string
    enabled: boolean
}

export interface GatewayCredentialStore {
    get(gatewayId: string): Promise<GatewayCredentialRecord | undefined>
    put(gatewayId: string, registrationRecord: string): Promise<GatewayCredentialRecord>
}

interface PendingCredentialHandshake {
    mode: 'credential'
    gatewayId: string
    serverLoginState: string
    expiresAtMs: number
}

interface PendingPairingHandshake {
    mode: 'pairing'
    gatewayId: string
    authorityHandshakeId: string
    expiresAtMs: number
}

type PendingHandshake = PendingCredentialHandshake | PendingPairingHandshake

export class SecureGatewayAuthenticator {
    private readonly handshakes = new Map<string, PendingHandshake>()

    private constructor(
        readonly relayId: string,
        readonly serverSetup: string,
        readonly pairing: OpaquePairingAuthority,
        private readonly credentials: GatewayCredentialStore,
        private readonly now: () => number,
        private readonly randomId: () => string,
        private readonly handshakeTtlMs: number,
    ) {}

    static async create(input: {
        relayId: string
        serverSetup: string
        credentials: GatewayCredentialStore
        now?: () => number
        randomId?: () => string
        pairingTtlMs?: number
        handshakeTtlMs?: number
        maxPairingAttempts?: number
    }): Promise<SecureGatewayAuthenticator> {
        const now = input.now ?? Date.now
        const randomId = input.randomId ?? (() => globalThis.crypto.randomUUID())
        const handshakeTtlMs = input.handshakeTtlMs ?? 30_000
        const pairing = await OpaquePairingAuthority.create({
            domain: 'relay-gateway',
            serverId: input.relayId,
            serverSetup: input.serverSetup,
            now,
            randomId,
            pairingTtlMs: input.pairingTtlMs,
            handshakeTtlMs,
            maxAttempts: input.maxPairingAttempts,
        })
        return new SecureGatewayAuthenticator(
            input.relayId, input.serverSetup, pairing, input.credentials, now, randomId, handshakeTtlMs,
        )
    }

    issuePairing(): OpaquePairingTicket {
        return this.pairing.issue()
    }

    async createCredentialRegistrationResponse(gatewayId: string, registrationRequest: string): Promise<{
        registrationResponse: string
        serverStaticPublicKey: string
    }> {
        return {
            registrationResponse: await createOpaqueCredentialRegistrationResponse({
                serverSetup: this.serverSetup,
                subjectId: gatewayId,
                serverId: this.relayId,
                registrationRequest,
            }),
            serverStaticPublicKey: await getOpaqueServerPublicKey(this.serverSetup),
        }
    }

    async commitCredential(gatewayId: string, registrationRecord: string): Promise<void> {
        await this.credentials.put(gatewayId, registrationRecord)
    }

    async begin(input: {
        mode: 'pairing' | 'credential'
        gatewayId: string
        subjectId: string
        startLoginRequest: string
    }): Promise<{
        handshakeId: string
        loginResponse: string
        expiresAt: string
        attemptsRemaining?: number
    }> {
        this.prune()
        if (input.mode === 'pairing') {
            const started = this.pairing.begin(input.subjectId, input.startLoginRequest)
            this.handshakes.set(started.handshakeId, {
                mode: 'pairing', gatewayId: input.gatewayId,
                authorityHandshakeId: started.handshakeId, expiresAtMs: Date.parse(started.expiresAt),
            })
            return {
                handshakeId: started.handshakeId,
                loginResponse: started.loginResponse,
                expiresAt: started.expiresAt,
                attemptsRemaining: started.attemptsRemaining,
            }
        }

        if (input.subjectId !== input.gatewayId) throw new Error('Credential subject must match gatewayId')
        const credential = await this.credentials.get(input.gatewayId)
        if (!credential || !credential.enabled) throw new Error('Gateway credential is unknown or disabled')
        const started = await startOpaqueCredentialServerLogin({
            serverSetup: this.serverSetup,
            registrationRecord: credential.registrationRecord,
            subjectId: input.gatewayId,
            serverId: this.relayId,
            startLoginRequest: input.startLoginRequest,
        })
        const handshakeId = this.randomId()
        const expiresAtMs = this.now() + this.handshakeTtlMs
        this.handshakes.set(handshakeId, {
            mode: 'credential', gatewayId: input.gatewayId,
            serverLoginState: started.serverLoginState, expiresAtMs,
        })
        return { handshakeId, loginResponse: started.loginResponse, expiresAt: new Date(expiresAtMs).toISOString() }
    }

    async finish(input: { handshakeId: string; finishLoginRequest: string }): Promise<{
        gatewayId: string
        sessionKey: string
        credentialProvisioningRequired: boolean
    }> {
        this.prune()
        const handshake = this.handshakes.get(input.handshakeId)
        if (!handshake) throw new Error('Secure Gateway handshake is invalid or expired')
        this.handshakes.delete(input.handshakeId)
        if (handshake.mode === 'pairing') {
            const finished = this.pairing.finish(handshake.authorityHandshakeId, input.finishLoginRequest)
            return { gatewayId: handshake.gatewayId, sessionKey: finished.sessionKey, credentialProvisioningRequired: true }
        }
        const sessionKey = await finishOpaqueCredentialServerLogin({
            serverLoginState: handshake.serverLoginState,
            finishLoginRequest: input.finishLoginRequest,
            subjectId: handshake.gatewayId,
            serverId: this.relayId,
        })
        return { gatewayId: handshake.gatewayId, sessionKey, credentialProvisioningRequired: false }
    }

    private prune(): void {
        const now = this.now()
        for (const [id, handshake] of this.handshakes) {
            if (handshake.expiresAtMs <= now) this.handshakes.delete(id)
        }
    }
}
