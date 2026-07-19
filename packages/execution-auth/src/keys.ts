import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, type JWK, type KeyLike } from 'jose'

export type { JWK, KeyLike } from 'jose'

export interface ExecutionKeyPair {
    keyId: string
    publicKey: JWK
    privateKey: JWK
}

export async function generateExecutionKeyPair(): Promise<ExecutionKeyPair> {
    const pair = await generateKeyPair('ES256', { extractable: true })
    const publicKey = await exportJWK(pair.publicKey)
    const privateKey = await exportJWK(pair.privateKey)
    const keyId = await calculateJwkThumbprint(publicKey, 'sha256')
    return {
        keyId,
        publicKey: { ...publicKey, alg: 'ES256', kid: keyId, use: 'sig' },
        privateKey: { ...privateKey, alg: 'ES256', kid: keyId, use: 'sig' },
    }
}

export async function executionKeyId(publicKey: JWK): Promise<string> {
    return calculateJwkThumbprint(publicKey, 'sha256')
}

export async function importExecutionKey(key: JWK, usage: 'sign' | 'verify'): Promise<KeyLike> {
    if (key.kty !== 'EC' || key.crv !== 'P-256' || key.alg !== 'ES256') {
        throw new ExecutionAuthorizationError('invalid_key', 'Execution keys must be ES256 P-256 keys')
    }
    if (usage === 'sign' && typeof key.d !== 'string') {
        throw new ExecutionAuthorizationError('invalid_key', 'An execution signing key must include private key material')
    }
    const imported = await importJWK(key, 'ES256')
    if (imported instanceof Uint8Array) {
        throw new ExecutionAuthorizationError('invalid_key', 'Execution keys must be asymmetric keys')
    }
    return imported
}

export class ExecutionAuthorizationError extends Error {
    constructor(readonly code: ExecutionAuthorizationErrorCode, message: string, options?: ErrorOptions) {
        super(message, options)
        this.name = 'ExecutionAuthorizationError'
    }
}

export type ExecutionAuthorizationErrorCode =
    | 'invalid_key'
    | 'malformed_token'
    | 'invalid_signature'
    | 'unknown_key'
    | 'wrong_audience'
    | 'not_yet_valid'
    | 'expired'
    | 'operation_denied'
    | 'request_mismatch'
    | 'replay_conflict'
    | 'credential_revoked'
