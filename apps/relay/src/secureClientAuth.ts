import { OpaquePairingAuthority, type OpaquePairingTicket } from '@codever/secure-channel'
import type { NatsCredentialIssuer } from './nscCredentialIssuer'

interface PendingHandshake {
    clientId: string
    natsPublicKey: string
    authorityHandshakeId: string
    expiresAtMs: number
}

/** One-time OPAQUE authorization that signs a client-generated NKey public key. */
export class SecureClientAuthenticator {
    private readonly handshakes = new Map<string, PendingHandshake>()

    private constructor(
        readonly relayId: string,
        readonly pairing: OpaquePairingAuthority,
        private readonly now: () => number,
        private readonly natsCredentials: NatsCredentialIssuer,
    ) {}

    static async create(input: {
        relayId: string
        serverSetup: string
        now?: () => number
        randomId?: () => string
        pairingTtlMs?: number
        handshakeTtlMs?: number
        maxPairingAttempts?: number
        natsCredentials: NatsCredentialIssuer
    }): Promise<SecureClientAuthenticator> {
        const now = input.now ?? Date.now
        const pairing = await OpaquePairingAuthority.create({
            domain: 'relay-client', serverId: input.relayId, serverSetup: input.serverSetup,
            now, randomId: input.randomId, pairingTtlMs: input.pairingTtlMs,
            handshakeTtlMs: input.handshakeTtlMs, maxAttempts: input.maxPairingAttempts,
        })
        return new SecureClientAuthenticator(input.relayId, pairing, now, input.natsCredentials)
    }

    issuePairing(): OpaquePairingTicket { return this.pairing.issue() }

    async begin(input: {
        clientId: string
        subjectId: string
        startLoginRequest: string
        natsPublicKey: string
    }): Promise<{ handshakeId: string; loginResponse: string; expiresAt: string; attemptsRemaining?: number }> {
        this.prune()
        const started = this.pairing.begin(input.subjectId, input.startLoginRequest)
        this.handshakes.set(started.handshakeId, {
            clientId: input.clientId,
            natsPublicKey: input.natsPublicKey,
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

    async finish(input: { handshakeId: string; finishLoginRequest: string }): Promise<{
        clientId: string
        sessionKey: string
        natsUserJwt: string
        natsWebSocketUrl: string
    }> {
        this.prune()
        const pending = this.handshakes.get(input.handshakeId)
        if (!pending) throw new Error('Secure Client handshake is invalid or expired')
        this.handshakes.delete(input.handshakeId)
        const finished = this.pairing.finish(pending.authorityHandshakeId, input.finishLoginRequest)
        const issued = await this.natsCredentials.issueClient(pending.clientId, pending.natsPublicKey)
        return {
            clientId: pending.clientId,
            sessionKey: finished.sessionKey,
            natsUserJwt: issued.userJwt,
            natsWebSocketUrl: issued.websocketUrl,
        }
    }

    private prune(): void {
        const now = this.now()
        for (const [id, value] of this.handshakes) if (value.expiresAtMs <= now) this.handshakes.delete(id)
    }
}
