import {
    OpaquePairingAuthority,
    hpkeKeyId,
    type HpkeKeyPair,
    type OpaquePairingTicket,
} from '@codever/secure-channel'
import type { DeviceCredentialRecord, DeviceCredentialStore } from './deviceCredentialRepository'

interface PendingPairingHandshake {
    credentialId: string
    authorityHandshakeId: string
    expiresAtMs: number
}

/** One-time OPAQUE pairing authority plus long-term HPKE device authorization. */
export class DeviceAuthenticator {
    private readonly handshakes = new Map<string, PendingPairingHandshake>()

    private constructor(
        readonly gatewayId: string,
        readonly pairing: OpaquePairingAuthority,
        readonly hpkeKeyPair: HpkeKeyPair,
        private readonly credentials: DeviceCredentialStore,
        private readonly now: () => number,
    ) {}

    static async create(input: {
        gatewayId: string
        serverSetup: string
        credentials: DeviceCredentialStore
        hpkeKeyPair: HpkeKeyPair
        now?: () => number
        randomId?: () => string
        pairingTtlMs?: number
        handshakeTtlMs?: number
        maxPairingAttempts?: number
    }): Promise<DeviceAuthenticator> {
        if (!input.gatewayId.trim()) throw new Error('gatewayId is required')
        const now = input.now ?? Date.now
        const pairing = await OpaquePairingAuthority.create({
            domain: 'gateway-device',
            serverId: input.gatewayId,
            serverSetup: input.serverSetup,
            now,
            randomId: input.randomId ?? (() => globalThis.crypto.randomUUID()),
            pairingTtlMs: input.pairingTtlMs ?? 3 * 60_000,
            handshakeTtlMs: input.handshakeTtlMs ?? 30_000,
            maxAttempts: input.maxPairingAttempts ?? 5,
        })
        return new DeviceAuthenticator(input.gatewayId, pairing, { ...input.hpkeKeyPair }, input.credentials, now)
    }

    issuePairing(): OpaquePairingTicket {
        return this.pairing.issue()
    }

    begin(input: {
        credentialId: string
        pairingId: string
        startLoginRequest: string
    }): {
        handshakeId: string
        loginResponse: string
        expiresAt: string
        attemptsRemaining: number
    } {
        this.prune()
        assertCredentialId(input.credentialId)
        const started = this.pairing.begin(input.pairingId, input.startLoginRequest)
        this.handshakes.set(started.handshakeId, {
            credentialId: input.credentialId,
            authorityHandshakeId: started.handshakeId,
            expiresAtMs: Date.parse(started.expiresAt),
        })
        return started
    }

    finish(input: { handshakeId: string; finishLoginRequest: string }): {
        credentialId: string
        sessionKey: string
    } {
        this.prune()
        const handshake = this.handshakes.get(input.handshakeId)
        if (!handshake) throw new Error('Gateway device pairing handshake is invalid or expired')
        this.handshakes.delete(input.handshakeId)
        const finished = this.pairing.finish(handshake.authorityHandshakeId, input.finishLoginRequest)
        return { credentialId: handshake.credentialId, sessionKey: finished.sessionKey }
    }

    async register(
        credentialId: string,
        deviceHpkeKeyId: string,
        hpkePublicKey: string,
        label?: string,
    ): Promise<DeviceCredentialRecord> {
        if (await hpkeKeyId(hpkePublicKey) !== deviceHpkeKeyId) throw new Error('Device HPKE key ID mismatch')
        return this.credentials.put(credentialId, deviceHpkeKeyId, hpkePublicKey, label)
    }

    async authorize(credentialId: string): Promise<DeviceCredentialRecord> {
        const credential = await this.credentials.get(credentialId)
        if (!credential || !credential.enabled) throw new Error('Device credential is unknown or revoked')
        return credential
    }

    async revoke(credentialId: string): Promise<boolean> {
        return this.credentials.revoke(credentialId)
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
