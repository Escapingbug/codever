import * as opaque from '@serenity-kit/opaque'

export async function createOpaqueServerSetup(): Promise<string> {
    await opaque.ready
    return opaque.server.createSetup()
}

export async function getOpaqueServerPublicKey(serverSetup: string): Promise<string> {
    await opaque.ready
    return opaque.server.getPublicKey(serverSetup)
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const LOCATOR_LENGTH = 6
const SECRET_LENGTH = 10
export type OpaquePairingDomain = 'relay-client' | 'relay-gateway' | 'gateway-device'

export interface OpaquePairingTicket {
    pairingId: string
    code: string
    expiresAt: string
    attemptsRemaining: number
}

export interface OpaquePairingLoginRequest {
    pairingId: string
    handshakeId: string
    loginResponse: string
    expiresAt: string
    attemptsRemaining: number
}

export interface OpaquePairingClientStart {
    pairingId: string
    clientLoginState: string
    startLoginRequest: string
}

export interface OpaquePairingClientFinish {
    finishLoginRequest: string
    sessionKey: string
    serverStaticPublicKey: string
}

interface PairingRecord {
    pairingId: string
    registrationRecord: string
    expiresAtMs: number
    attemptsRemaining: number
}

interface HandshakeRecord {
    pairingId: string
    serverLoginState: string
    expiresAtMs: number
}

export class OpaquePairingError extends Error {
    constructor(
        message: string,
        readonly code: 'closed' | 'expired' | 'attempts_exhausted' | 'invalid_code' | 'invalid_handshake' | 'authentication_failed',
        options?: ErrorOptions,
    ) {
        super(message, options)
        this.name = 'OpaquePairingError'
    }
}

export class OpaquePairingAuthority {
    readonly serverStaticPublicKey: string
    private readonly pairings = new Map<string, PairingRecord>()
    private readonly handshakes = new Map<string, HandshakeRecord>()

    private constructor(
        private readonly serverSetup: string,
        private readonly serverId: string,
        private readonly domain: OpaquePairingDomain,
        private readonly options: {
            pairingTtlMs: number
            handshakeTtlMs: number
            maxAttempts: number
            now: () => number
            randomBytes: (length: number) => Uint8Array
            randomId: () => string
        },
    ) {
        this.serverStaticPublicKey = opaque.server.getPublicKey(serverSetup)
    }

    static async create(input: {
        serverId: string
        domain: OpaquePairingDomain
        serverSetup?: string
        pairingTtlMs?: number
        handshakeTtlMs?: number
        maxAttempts?: number
        now?: () => number
        randomBytes?: (length: number) => Uint8Array
        randomId?: () => string
    }): Promise<OpaquePairingAuthority> {
        await opaque.ready
        if (!input.serverId.trim()) throw new Error('serverId is required')
        const pairingTtlMs = input.pairingTtlMs ?? 3 * 60_000
        const handshakeTtlMs = input.handshakeTtlMs ?? 30_000
        const maxAttempts = input.maxAttempts ?? 5
        if (!Number.isSafeInteger(pairingTtlMs) || pairingTtlMs <= 0) throw new Error('pairingTtlMs must be positive')
        if (!Number.isSafeInteger(handshakeTtlMs) || handshakeTtlMs <= 0 || handshakeTtlMs > pairingTtlMs) {
            throw new Error('handshakeTtlMs must be positive and no longer than pairingTtlMs')
        }
        if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) throw new Error('maxAttempts must be positive')
        return new OpaquePairingAuthority(input.serverSetup ?? opaque.server.createSetup(), input.serverId, input.domain, {
            pairingTtlMs,
            handshakeTtlMs,
            maxAttempts,
            now: input.now ?? Date.now,
            randomBytes: input.randomBytes ?? secureRandomBytes,
            randomId: input.randomId ?? secureRandomId,
        })
    }

    issue(): OpaquePairingTicket {
        this.prune()
        let pairingId = ''
        for (let attempt = 0; attempt < 16; attempt += 1) {
            pairingId = randomCode(this.options.randomBytes, LOCATOR_LENGTH)
            if (!this.pairings.has(pairingId)) break
        }
        if (!pairingId || this.pairings.has(pairingId)) throw new Error('Unable to allocate a unique pairing ID')
        const secret = randomCode(this.options.randomBytes, SECRET_LENGTH)
        const code = formatPairingCode(pairingId, secret)
        const identifiers = pairingIdentifiers(pairingId, this.serverId, this.domain)
        const client = opaque.client.startRegistration({ password: secret })
        const server = opaque.server.createRegistrationResponse({
            serverSetup: this.serverSetup,
            userIdentifier: pairingId,
            registrationRequest: client.registrationRequest,
        })
        const registration = opaque.client.finishRegistration({
            clientRegistrationState: client.clientRegistrationState,
            registrationResponse: server.registrationResponse,
            password: secret,
            identifiers,
            keyStretching: 'memory-constrained',
        })
        const expiresAtMs = this.options.now() + this.options.pairingTtlMs
        this.pairings.set(pairingId, {
            pairingId,
            registrationRecord: registration.registrationRecord,
            expiresAtMs,
            attemptsRemaining: this.options.maxAttempts,
        })
        return { pairingId, code, expiresAt: new Date(expiresAtMs).toISOString(), attemptsRemaining: this.options.maxAttempts }
    }

    begin(pairingIdInput: string, startLoginRequest: string): OpaquePairingLoginRequest {
        this.prune()
        const pairingId = normalizePairingId(pairingIdInput)
        const pairing = this.pairings.get(pairingId)
        if (!pairing) throw new OpaquePairingError('Pairing is not open', 'closed')
        if (pairing.attemptsRemaining <= 0) {
            this.deletePairing(pairingId)
            throw new OpaquePairingError('Pairing attempts are exhausted', 'attempts_exhausted')
        }
        pairing.attemptsRemaining -= 1
        let started: ReturnType<typeof opaque.server.startLogin>
        try {
            started = opaque.server.startLogin({
                serverSetup: this.serverSetup,
                registrationRecord: pairing.registrationRecord,
                startLoginRequest,
                userIdentifier: pairingId,
                identifiers: pairingIdentifiers(pairingId, this.serverId, this.domain),
            })
        } catch (error) {
            if (pairing.attemptsRemaining === 0) this.deletePairing(pairingId)
            throw new OpaquePairingError('Invalid OPAQUE login request', 'authentication_failed', { cause: error })
        }
        const handshakeId = this.options.randomId()
        const expiresAtMs = Math.min(pairing.expiresAtMs, this.options.now() + this.options.handshakeTtlMs)
        this.handshakes.set(handshakeId, { pairingId, serverLoginState: started.serverLoginState, expiresAtMs })
        return {
            pairingId,
            handshakeId,
            loginResponse: started.loginResponse,
            expiresAt: new Date(expiresAtMs).toISOString(),
            attemptsRemaining: pairing.attemptsRemaining,
        }
    }

    finish(handshakeId: string, finishLoginRequest: string): { pairingId: string; sessionKey: string } {
        this.prune()
        const handshake = this.handshakes.get(handshakeId)
        if (!handshake) throw new OpaquePairingError('Pairing handshake is invalid or expired', 'invalid_handshake')
        this.handshakes.delete(handshakeId)
        let result: ReturnType<typeof opaque.server.finishLogin>
        try {
            result = opaque.server.finishLogin({
                serverLoginState: handshake.serverLoginState,
                finishLoginRequest,
                identifiers: pairingIdentifiers(handshake.pairingId, this.serverId, this.domain),
            })
        } catch (error) {
            const pairing = this.pairings.get(handshake.pairingId)
            if (pairing?.attemptsRemaining === 0) this.deletePairing(handshake.pairingId)
            throw new OpaquePairingError('Pairing authentication failed', 'authentication_failed', { cause: error })
        }

        // Consume before returning key material so a second completion cannot win a race.
        this.deletePairing(handshake.pairingId)
        return { pairingId: handshake.pairingId, sessionKey: result.sessionKey }
    }

    cancel(pairingIdInput: string): boolean {
        return this.deletePairing(normalizePairingId(pairingIdInput))
    }

    hasOpenPairing(pairingIdInput: string): boolean {
        this.prune()
        const pairing = this.pairings.get(normalizePairingId(pairingIdInput))
        return pairing !== undefined && pairing.attemptsRemaining > 0
    }

    private prune(): void {
        const now = this.options.now()
        for (const [handshakeId, handshake] of this.handshakes) {
            if (handshake.expiresAtMs <= now) this.handshakes.delete(handshakeId)
        }
        for (const [pairingId, pairing] of this.pairings) {
            const hasActiveHandshake = [...this.handshakes.values()].some(handshake => handshake.pairingId === pairingId)
            if (pairing.expiresAtMs <= now || (pairing.attemptsRemaining <= 0 && !hasActiveHandshake)) {
                this.deletePairing(pairingId)
            }
        }
    }

    private deletePairing(pairingId: string): boolean {
        const deleted = this.pairings.delete(pairingId)
        for (const [handshakeId, handshake] of this.handshakes) {
            if (handshake.pairingId === pairingId) this.handshakes.delete(handshakeId)
        }
        return deleted
    }
}

export async function startOpaquePairingClient(codeInput: string): Promise<OpaquePairingClientStart> {
    await opaque.ready
    const { pairingId, secret } = parsePairingCode(codeInput)
    const started = opaque.client.startLogin({ password: secret })
    return { pairingId, clientLoginState: started.clientLoginState, startLoginRequest: started.startLoginRequest }
}

export function finishOpaquePairingClient(input: {
    code: string
    serverId: string
    domain: OpaquePairingDomain
    clientLoginState: string
    loginResponse: string
    expectedServerStaticPublicKey?: string
}): OpaquePairingClientFinish {
    const { pairingId, secret } = parsePairingCode(input.code)
    let result: ReturnType<typeof opaque.client.finishLogin>
    try {
        result = opaque.client.finishLogin({
            clientLoginState: input.clientLoginState,
            loginResponse: input.loginResponse,
            password: secret,
            identifiers: pairingIdentifiers(pairingId, input.serverId, input.domain),
            keyStretching: 'memory-constrained',
        })
    } catch (error) {
        throw new OpaquePairingError('Pairing authentication failed', 'authentication_failed', { cause: error })
    }
    if (!result) throw new OpaquePairingError('Pairing authentication failed', 'authentication_failed')
    if (input.expectedServerStaticPublicKey && result.serverStaticPublicKey !== input.expectedServerStaticPublicKey) {
        throw new OpaquePairingError('Relay static public key changed', 'authentication_failed')
    }
    return {
        finishLoginRequest: result.finishLoginRequest,
        sessionKey: result.sessionKey,
        serverStaticPublicKey: result.serverStaticPublicKey,
    }
}

export function parsePairingCode(input: string): { pairingId: string; secret: string } {
    const normalized = input.toUpperCase().replace(/[^A-Z2-9]/g, '')
    if (normalized.length !== LOCATOR_LENGTH + SECRET_LENGTH || [...normalized].some(value => !CODE_ALPHABET.includes(value))) {
        throw new OpaquePairingError('Pairing code is invalid', 'invalid_code')
    }
    return { pairingId: normalized.slice(0, LOCATOR_LENGTH), secret: normalized.slice(LOCATOR_LENGTH) }
}

function formatPairingCode(pairingId: string, secret: string): string {
    return `${pairingId}-${secret.slice(0, 5)}-${secret.slice(5)}`
}

function normalizePairingId(input: string): string {
    const normalized = input.toUpperCase().replace(/[^A-Z2-9]/g, '')
    if (normalized.length !== LOCATOR_LENGTH || [...normalized].some(value => !CODE_ALPHABET.includes(value))) {
        throw new OpaquePairingError('Pairing ID is invalid', 'invalid_code')
    }
    return normalized
}

function pairingIdentifiers(
    pairingId: string,
    serverId: string,
    domain: OpaquePairingDomain,
): { client: string; server: string } {
    return {
        client: `codever:${domain}:pairing:${pairingId}`,
        server: `codever:${domain}:server:${serverId}`,
    }
}

function randomCode(randomBytes: (length: number) => Uint8Array, length: number): string {
    // Rejection sampling avoids modulo bias because 256 is not divisible by the alphabet length.
    let result = ''
    const limit = 256 - (256 % CODE_ALPHABET.length)
    while (result.length < length) {
        for (const byte of randomBytes(length)) {
            if (byte >= limit) continue
            result += CODE_ALPHABET[byte % CODE_ALPHABET.length]
            if (result.length === length) break
        }
    }
    return result
}

function secureRandomBytes(length: number): Uint8Array {
    const value = new Uint8Array(length)
    globalThis.crypto.getRandomValues(value)
    return value
}

function secureRandomId(): string {
    return globalThis.crypto.randomUUID()
}
