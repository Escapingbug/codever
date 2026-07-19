import { Algorithms, Headers, ProtectedHeaders, Sign1 } from '@auth0/cose'
import { Decoder, Encoder } from 'cbor-x'
import { base64url, type JWK, type KeyLike } from 'jose'
import { ExecutionAuthorizationError, importExecutionKey } from './keys'
import type { ExecutionReplayGuard, ReplayDisposition } from './replayGuard'

const CWT_ISS = 1
const CWT_SUB = 2
const CWT_AUD = 3
const CWT_EXP = 4
const CWT_NBF = 5
const CWT_IAT = 6
const CWT_CTI = 7
const CLAIM_OPERATIONS = 'codever.operations'
const CLAIM_REQUEST_HASH = 'codever.request_hash'
const DEFAULT_TTL_SECONDS = 90
// CWT implementations commonly allow bounded clock skew. Codever Gateways run on
// user-managed machines whose wall clocks can be a few minutes away from mobile
// devices, while request binding and the replay ledger still constrain reuse.
const DEFAULT_CLOCK_SKEW_SECONDS = 180
const encoder = new Encoder({ mapsAsObjects: false, useRecords: false })
const decoder = new Decoder({ mapsAsObjects: false, useRecords: false })

export interface ExecutionTokenClaims {
    issuer: string
    subject: string
    audience: string
    issuedAt: number
    notBefore: number
    expiresAt: number
    tokenId: string
    operations: string[]
    requestHash: string
}

export interface SignExecutionTokenInput {
    request: unknown
    gatewayId: string
    issuer: string
    subject: string
    operation: string
    keyId: string
    privateKey: JWK | KeyLike
    now?: () => number
    ttlSeconds?: number
    tokenId?: string
}

export interface VerifyExecutionTokenInput {
    token: string
    request: unknown
    gatewayId: string
    operation: string
    resolvePublicKey: (keyId: string) => Promise<JWK | KeyLike | undefined>
    replayGuard: ExecutionReplayGuard
    now?: () => number
    clockSkewSeconds?: number
}

export interface VerifiedExecutionToken {
    claims: ExecutionTokenClaims
    keyId: string
    replay: ReplayDisposition
}

export async function signExecutionToken(input: SignExecutionTokenInput): Promise<string> {
    assertIdentifier(input.gatewayId, 'gatewayId')
    assertIdentifier(input.issuer, 'issuer')
    assertIdentifier(input.subject, 'subject')
    assertIdentifier(input.operation, 'operation')
    assertIdentifier(input.keyId, 'keyId')
    const now = Math.floor((input.now?.() ?? Date.now()) / 1_000)
    const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 300) {
        throw new ExecutionAuthorizationError('malformed_token', 'Execution token TTL must be between 1 and 300 seconds')
    }
    const tokenId = input.tokenId ?? base64url.encode(randomBytes(16))
    const requestHash = await hashRequest(input.request)
    const claims = new Map<number | string, unknown>([
        [CWT_ISS, input.issuer],
        [CWT_SUB, input.subject],
        [CWT_AUD, input.gatewayId],
        [CWT_EXP, now + ttl],
        [CWT_NBF, now - DEFAULT_CLOCK_SKEW_SECONDS],
        [CWT_IAT, now],
        [CWT_CTI, base64url.decode(tokenId)],
        [CLAIM_OPERATIONS, [input.operation]],
        [CLAIM_REQUEST_HASH, base64url.decode(requestHash)],
    ])
    const protectedHeaders = new ProtectedHeaders([
        [Headers.Algorithm, Algorithms.ES256],
        [Headers.KeyID, new TextEncoder().encode(input.keyId)],
    ])
    const key = isJwk(input.privateKey) ? await importExecutionKey(input.privateKey, 'sign') : input.privateKey
    const signed = await Sign1.sign(protectedHeaders, undefined, encoder.encode(claims), key)
    return base64url.encode(signed.encode())
}

export async function verifyExecutionToken(input: VerifyExecutionTokenInput): Promise<VerifiedExecutionToken> {
    let sign1: Sign1
    let keyId: string
    try {
        sign1 = Sign1.decode(base64url.decode(input.token))
        if (sign1.protectedHeaders.get(Headers.Algorithm) !== Algorithms.ES256) {
            throw new ExecutionAuthorizationError('malformed_token', 'Execution token must use COSE ES256')
        }
        const encodedKeyId = sign1.protectedHeaders.get(Headers.KeyID)
        if (!(encodedKeyId instanceof Uint8Array)) {
            throw new ExecutionAuthorizationError('malformed_token', 'Execution token has no protected key ID')
        }
        keyId = new TextDecoder().decode(encodedKeyId)
    } catch (error) {
        if (error instanceof ExecutionAuthorizationError) throw error
        throw new ExecutionAuthorizationError('malformed_token', 'Execution token is not valid COSE Sign1/CWT', { cause: error })
    }

    const keyValue = await input.resolvePublicKey(keyId)
    if (!keyValue) throw new ExecutionAuthorizationError('unknown_key', 'Execution signing key is unknown or revoked')
    const key = isJwk(keyValue) ? await importExecutionKey(keyValue, 'verify') : keyValue
    try {
        await sign1.verify(key, { algorithms: [Algorithms.ES256] })
    } catch (error) {
        throw new ExecutionAuthorizationError('invalid_signature', 'Execution token signature is invalid', { cause: error })
    }

    let claims: ExecutionTokenClaims
    try {
        claims = parseClaims(decoder.decode(sign1.payload))
    } catch (error) {
        if (error instanceof ExecutionAuthorizationError) throw error
        throw new ExecutionAuthorizationError('malformed_token', 'Execution token contains invalid CWT claims', { cause: error })
    }

    const now = Math.floor((input.now?.() ?? Date.now()) / 1_000)
    const skew = input.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS
    if (claims.audience !== input.gatewayId) {
        throw new ExecutionAuthorizationError('wrong_audience', 'Execution token is intended for another Gateway')
    }
    if (now + skew < claims.notBefore) {
        throw new ExecutionAuthorizationError('not_yet_valid', 'Execution token is not valid yet')
    }
    if (now - skew >= claims.expiresAt) {
        throw new ExecutionAuthorizationError('expired', 'Execution token has expired')
    }
    if (!claims.operations.includes(input.operation)) {
        throw new ExecutionAuthorizationError('operation_denied', 'Execution token does not authorize this operation')
    }
    const requestHash = await hashRequest(input.request)
    if (claims.requestHash !== requestHash) {
        throw new ExecutionAuthorizationError('request_mismatch', 'Execution token does not match the request')
    }
    const replay = await input.replayGuard.consume({
        tokenId: claims.tokenId,
        requestHash,
        expiresAt: claims.expiresAt,
    })
    return { claims, keyId, replay }
}

export async function hashRequest(request: unknown): Promise<string> {
    const bytes = new TextEncoder().encode(canonicalJson(request))
    return base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

function parseClaims(value: unknown): ExecutionTokenClaims {
    if (!(value instanceof Map)) throw malformed('CWT claims must be a CBOR map')
    const issuer = requiredString(value.get(CWT_ISS), 'issuer')
    const subject = requiredString(value.get(CWT_SUB), 'subject')
    const audience = requiredString(value.get(CWT_AUD), 'audience')
    const expiresAt = requiredInteger(value.get(CWT_EXP), 'expiration')
    const notBefore = requiredInteger(value.get(CWT_NBF), 'not-before')
    const issuedAt = requiredInteger(value.get(CWT_IAT), 'issued-at')
    const cti = value.get(CWT_CTI)
    const hash = value.get(CLAIM_REQUEST_HASH)
    const operations = value.get(CLAIM_OPERATIONS)
    if (!(cti instanceof Uint8Array) || cti.byteLength < 16) throw malformed('CWT token ID is invalid')
    if (!(hash instanceof Uint8Array) || hash.byteLength !== 32) throw malformed('CWT request hash is invalid')
    if (!Array.isArray(operations) || operations.length < 1 || operations.some(value => typeof value !== 'string' || !value)) {
        throw malformed('CWT operation list is invalid')
    }
    if (expiresAt <= issuedAt || notBefore > issuedAt) throw malformed('CWT time claims are inconsistent')
    return {
        issuer,
        subject,
        audience,
        expiresAt,
        notBefore,
        issuedAt,
        tokenId: base64url.encode(cti),
        operations,
        requestHash: base64url.encode(hash),
    }
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        const serialized = JSON.stringify(value)
        if (serialized === undefined) throw malformed('Execution request must be JSON serializable')
        return serialized
    }
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function randomBytes(size: number): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(size))
}

function requiredString(value: unknown, name: string): string {
    if (typeof value !== 'string' || !value) throw malformed(`CWT ${name} claim is invalid`)
    return value
}

function requiredInteger(value: unknown, name: string): number {
    if (!Number.isSafeInteger(value)) throw malformed(`CWT ${name} claim is invalid`)
    return value as number
}

function assertIdentifier(value: string, name: string): void {
    if (!value.trim()) throw malformed(`${name} is required`)
}

function malformed(message: string): ExecutionAuthorizationError {
    return new ExecutionAuthorizationError('malformed_token', message)
}

function isJwk(value: JWK | KeyLike): value is JWK {
    return typeof value === 'object' && value !== null && 'kty' in value
}
