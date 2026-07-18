import { OpaquePairingAuthority, type OpaquePairingTicket } from '@codever/secure-channel'
import type { NatsCredentialIssuer } from './nscCredentialIssuer'

interface PendingHandshake {
    gatewayId: string
    natsPublicKey: string
    authorityHandshakeId: string
    expiresAtMs: number
}

/** One-time OPAQUE authorization that signs a Gateway-generated NKey public key. */
export class SecureGatewayAuthenticator {
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
    }): Promise<SecureGatewayAuthenticator> {
        const now = input.now ?? Date.now
        const pairing = await OpaquePairingAuthority.create({
            domain: 'relay-gateway', serverId: input.relayId, serverSetup: input.serverSetup,
            now, randomId: input.randomId, pairingTtlMs: input.pairingTtlMs,
            handshakeTtlMs: input.handshakeTtlMs, maxAttempts: input.maxPairingAttempts,
        })
        return new SecureGatewayAuthenticator(input.relayId, pairing, now, input.natsCredentials)
    }

    issuePairing(): OpaquePairingTicket { return this.pairing.issue() }

    async begin(input: {
        gatewayId: string
        subjectId: string
        startLoginRequest: string
        natsPublicKey: string
    }): Promise<{ handshakeId: string; loginResponse: string; expiresAt: string; attemptsRemaining?: number }> {
        this.prune()
        const started = this.pairing.begin(input.subjectId, input.startLoginRequest)
        this.handshakes.set(started.handshakeId, {
            gatewayId: input.gatewayId,
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
        gatewayId: string
        sessionKey: string
        natsUserJwt: string
        natsUrl: string
    }> {
        this.prune()
        const pending = this.handshakes.get(input.handshakeId)
        if (!pending) throw new Error('Secure Gateway handshake is invalid or expired')
        this.handshakes.delete(input.handshakeId)
        const finished = this.pairing.finish(pending.authorityHandshakeId, input.finishLoginRequest)
        const issued = await this.natsCredentials.issueGateway(pending.gatewayId, pending.natsPublicKey)
        return {
            gatewayId: pending.gatewayId,
            sessionKey: finished.sessionKey,
            natsUserJwt: issued.userJwt,
            natsUrl: issued.natsUrl,
        }
    }

    private prune(): void {
        const now = this.now()
        for (const [id, value] of this.handshakes) if (value.expiresAtMs <= now) this.handshakes.delete(id)
    }
}
