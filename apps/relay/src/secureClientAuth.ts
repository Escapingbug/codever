import {
    createOpaqueCredentialRegistrationResponse,
    finishOpaqueCredentialServerLogin,
    getOpaqueServerPublicKey,
    OpaquePairingAuthority,
    startOpaqueCredentialServerLogin,
    type OpaquePairingTicket,
} from '@codever/secure-channel'

export interface ClientCredentialRecord {
    clientId: string
    registrationRecord: string
    enabled: boolean
}

export interface ClientCredentialStore {
    get(clientId: string): Promise<ClientCredentialRecord | undefined>
    put(clientId: string, registrationRecord: string): Promise<ClientCredentialRecord>
}

type PendingHandshake = {
    mode: 'credential'
    clientId: string
    serverLoginState: string
    expiresAtMs: number
} | {
    mode: 'pairing'
    clientId: string
    authorityHandshakeId: string
    expiresAtMs: number
}

export class SecureClientAuthenticator {
    private readonly handshakes = new Map<string, PendingHandshake>()

    private constructor(
        readonly relayId: string,
        readonly serverSetup: string,
        readonly pairing: OpaquePairingAuthority,
        private readonly credentials: ClientCredentialStore,
        private readonly now: () => number,
        private readonly randomId: () => string,
        private readonly handshakeTtlMs: number,
    ) {}

    static async create(input: {
        relayId: string
        serverSetup: string
        credentials: ClientCredentialStore
        now?: () => number
        randomId?: () => string
        pairingTtlMs?: number
        handshakeTtlMs?: number
        maxPairingAttempts?: number
    }): Promise<SecureClientAuthenticator> {
        const now = input.now ?? Date.now
        const randomId = input.randomId ?? (() => globalThis.crypto.randomUUID())
        const handshakeTtlMs = input.handshakeTtlMs ?? 30_000
        const pairing = await OpaquePairingAuthority.create({
            domain: 'relay-client',
            serverId: input.relayId,
            serverSetup: input.serverSetup,
            now,
            randomId,
            pairingTtlMs: input.pairingTtlMs,
            handshakeTtlMs,
            maxAttempts: input.maxPairingAttempts,
        })
        return new SecureClientAuthenticator(
            input.relayId, input.serverSetup, pairing, input.credentials, now, randomId, handshakeTtlMs,
        )
    }

    issuePairing(): OpaquePairingTicket {
        return this.pairing.issue()
    }

    async createCredentialRegistrationResponse(clientId: string, registrationRequest: string): Promise<{
        registrationResponse: string
        serverStaticPublicKey: string
    }> {
        return {
            registrationResponse: await createOpaqueCredentialRegistrationResponse({
                serverSetup: this.serverSetup,
                subjectId: clientId,
                serverId: this.relayId,
                registrationRequest,
            }),
            serverStaticPublicKey: await getOpaqueServerPublicKey(this.serverSetup),
        }
    }

    async commitCredential(clientId: string, registrationRecord: string): Promise<ClientCredentialRecord> {
        return this.credentials.put(clientId, registrationRecord)
    }

    async begin(input: {
        mode: 'pairing' | 'credential'
        clientId: string
        subjectId: string
        startLoginRequest: string
    }): Promise<{ handshakeId: string; loginResponse: string; expiresAt: string; attemptsRemaining?: number }> {
        this.prune()
        if (input.mode === 'pairing') {
            const started = this.pairing.begin(input.subjectId, input.startLoginRequest)
            this.handshakes.set(started.handshakeId, {
                mode: 'pairing', clientId: input.clientId,
                authorityHandshakeId: started.handshakeId, expiresAtMs: Date.parse(started.expiresAt),
            })
            return {
                handshakeId: started.handshakeId,
                loginResponse: started.loginResponse,
                expiresAt: started.expiresAt,
                attemptsRemaining: started.attemptsRemaining,
            }
        }

        if (input.subjectId !== input.clientId) throw new Error('Credential subject must match clientId')
        const credential = await this.credentials.get(input.clientId)
        if (!credential?.enabled) throw new Error('Client credential is unknown or disabled')
        const started = await startOpaqueCredentialServerLogin({
            serverSetup: this.serverSetup,
            registrationRecord: credential.registrationRecord,
            subjectId: input.clientId,
            serverId: this.relayId,
            startLoginRequest: input.startLoginRequest,
        })
        const handshakeId = this.randomId()
        const expiresAtMs = this.now() + this.handshakeTtlMs
        this.handshakes.set(handshakeId, {
            mode: 'credential', clientId: input.clientId,
            serverLoginState: started.serverLoginState, expiresAtMs,
        })
        return { handshakeId, loginResponse: started.loginResponse, expiresAt: new Date(expiresAtMs).toISOString() }
    }

    async finish(input: { handshakeId: string; finishLoginRequest: string }): Promise<{
        clientId: string
        sessionKey: string
        credentialProvisioningRequired: boolean
    }> {
        this.prune()
        const handshake = this.handshakes.get(input.handshakeId)
        if (!handshake) throw new Error('Secure Client handshake is invalid or expired')
        this.handshakes.delete(input.handshakeId)
        if (handshake.mode === 'pairing') {
            const finished = this.pairing.finish(handshake.authorityHandshakeId, input.finishLoginRequest)
            return { clientId: handshake.clientId, sessionKey: finished.sessionKey, credentialProvisioningRequired: true }
        }
        const sessionKey = await finishOpaqueCredentialServerLogin({
            serverLoginState: handshake.serverLoginState,
            finishLoginRequest: input.finishLoginRequest,
            subjectId: handshake.clientId,
            serverId: this.relayId,
        })
        return { clientId: handshake.clientId, sessionKey, credentialProvisioningRequired: false }
    }

    private prune(): void {
        const now = this.now()
        for (const [id, handshake] of this.handshakes) {
            if (handshake.expiresAtMs <= now) this.handshakes.delete(id)
        }
    }
}
