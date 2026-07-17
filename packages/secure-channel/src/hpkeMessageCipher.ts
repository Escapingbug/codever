import { Aes128Gcm, CipherSuite, HkdfSha256 } from '@hpke/core'
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519'
import { decodeBase64Url, encodeBase64Url, SecureChannelError } from './sessionCipher'

const SUITE_ID = 'DHKEM_X25519_HKDF_SHA256_HKDF_SHA256_AES_128_GCM' as const
const INFO_PREFIX = 'codever.device-message.v1'
const DEFAULT_TTL_MS = 5 * 60_000
const MAX_FUTURE_SKEW_MS = 5 * 60_000
const X25519_KEY_BYTES = 32
type HpkeCryptoKeyPair = { publicKey: CryptoKey; privateKey: CryptoKey }

export interface HpkeKeyPair {
    keyId: string
    publicKey: string
    privateKey: string
}

export interface HpkeEnvelope {
    version: 1
    suite: typeof SUITE_ID
    messageId: string
    senderId: string
    recipientId: string
    senderKeyId: string
    recipientKeyId: string
    createdAt: string
    expiresAt: string
    enc: string
    ciphertext: string
}

const suite = new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes128Gcm(),
})

export async function generateHpkeKeyPair(): Promise<HpkeKeyPair> {
    const pair = await suite.kem.generateKeyPair()
    const publicKey = encodeBase64Url(new Uint8Array(await suite.kem.serializePublicKey(pair.publicKey)))
    return {
        keyId: await hpkeKeyId(publicKey),
        publicKey,
        privateKey: encodeBase64Url(new Uint8Array(await suite.kem.serializePrivateKey(pair.privateKey))),
    }
}

/** Stateless RFC 9180 Auth-mode protection for independently routed messages. */
export class HpkeMessageCipher {
    private constructor(
        readonly localId: string,
        readonly remoteId: string,
        readonly localKeyId: string,
        readonly remoteKeyId: string,
        private readonly localKeyPair: HpkeCryptoKeyPair,
        private readonly remotePublicKey: CryptoKey,
        private readonly now: () => number,
        private readonly ttlMs: number,
    ) {}

    static async create(input: {
        localId: string
        remoteId: string
        localKeyPair: HpkeKeyPair
        remoteKey: { keyId: string; publicKey: string }
        now?: () => number
        ttlMs?: number
    }): Promise<HpkeMessageCipher> {
        assertId(input.localId, 'localId')
        assertId(input.remoteId, 'remoteId')
        const publicBytes = parseKey(input.localKeyPair.publicKey, 'local public key')
        const privateBytes = parseKey(input.localKeyPair.privateKey, 'local private key')
        assertId(input.localKeyPair.keyId, 'local keyId')
        assertId(input.remoteKey.keyId, 'remote keyId')
        const remoteBytes = parseKey(input.remoteKey.publicKey, 'remote public key')
        const localKeyPair: HpkeCryptoKeyPair = {
            publicKey: await suite.kem.deserializePublicKey(publicBytes),
            privateKey: await suite.kem.deserializePrivateKey(privateBytes),
        }
        const serializedPublic = new Uint8Array(await suite.kem.serializePublicKey(localKeyPair.publicKey))
        if (!constantTimeEqual(serializedPublic, publicBytes)) throw new SecureChannelError('HPKE local key pair is inconsistent')
        if (await hpkeKeyId(input.localKeyPair.publicKey) !== input.localKeyPair.keyId) {
            throw new SecureChannelError('HPKE local key ID does not match its public key')
        }
        if (await hpkeKeyId(input.remoteKey.publicKey) !== input.remoteKey.keyId) {
            throw new SecureChannelError('HPKE remote key ID does not match its public key')
        }
        await verifyKeyPair(localKeyPair)
        const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS
        if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new SecureChannelError('HPKE message TTL must be positive')
        return new HpkeMessageCipher(
            input.localId,
            input.remoteId,
            input.localKeyPair.keyId,
            input.remoteKey.keyId,
            localKeyPair,
            await suite.kem.deserializePublicKey(remoteBytes),
            input.now ?? Date.now,
            ttlMs,
        )
    }

    async encrypt(value: unknown, options: { messageId?: string; ttlMs?: number } = {}): Promise<HpkeEnvelope> {
        const now = this.now()
        const ttlMs = options.ttlMs ?? this.ttlMs
        if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new SecureChannelError('HPKE message TTL must be positive')
        const metadata = {
            version: 1 as const,
            suite: SUITE_ID,
            messageId: options.messageId ?? globalThis.crypto.randomUUID(),
            senderId: this.localId,
            recipientId: this.remoteId,
            senderKeyId: this.localKeyId,
            recipientKeyId: this.remoteKeyId,
            createdAt: new Date(now).toISOString(),
            expiresAt: new Date(now + ttlMs).toISOString(),
        }
        const plaintext = new TextEncoder().encode(JSON.stringify(value))
        try {
            const sealed = await suite.seal({
                recipientPublicKey: this.remotePublicKey,
                senderKey: this.localKeyPair,
                info: info(metadata.senderId, metadata.recipientId),
            }, plaintext, aad(metadata))
            return {
                ...metadata,
                enc: encodeBase64Url(new Uint8Array(sealed.enc)),
                ciphertext: encodeBase64Url(new Uint8Array(sealed.ct)),
            }
        } finally {
            plaintext.fill(0)
        }
    }

    async decrypt(envelope: HpkeEnvelope): Promise<unknown> {
        validateHpkeEnvelope(envelope)
        if (envelope.senderId !== this.remoteId || envelope.recipientId !== this.localId
            || envelope.senderKeyId !== this.remoteKeyId || envelope.recipientKeyId !== this.localKeyId) {
            throw new SecureChannelError('HPKE envelope identity mismatch')
        }
        const now = this.now()
        if (Date.parse(envelope.createdAt) > now + MAX_FUTURE_SKEW_MS) throw new SecureChannelError('HPKE envelope was created in the future')
        if (Date.parse(envelope.expiresAt) <= now) throw new SecureChannelError('HPKE envelope has expired')
        try {
            const plaintext = await suite.open({
                recipientKey: this.localKeyPair,
                senderPublicKey: this.remotePublicKey,
                enc: decodeBase64Url(envelope.enc),
                info: info(envelope.senderId, envelope.recipientId),
            }, decodeBase64Url(envelope.ciphertext), aad(envelope))
            return JSON.parse(new TextDecoder().decode(plaintext)) as unknown
        } catch (error) {
            if (error instanceof SecureChannelError) throw error
            throw new SecureChannelError('HPKE envelope authentication failed', { cause: error })
        }
    }
}

function aad(value: Pick<HpkeEnvelope, 'version' | 'suite' | 'messageId' | 'senderId' | 'recipientId' | 'senderKeyId' | 'recipientKeyId' | 'createdAt' | 'expiresAt'>): Uint8Array {
    return new TextEncoder().encode(JSON.stringify([
        value.version, value.suite, value.messageId, value.senderId, value.recipientId,
        value.senderKeyId, value.recipientKeyId, value.createdAt, value.expiresAt,
    ]))
}

function info(senderId: string, recipientId: string): Uint8Array {
    return new TextEncoder().encode(JSON.stringify([INFO_PREFIX, senderId, recipientId]))
}

function parseKey(value: string, label: string): Uint8Array {
    const key = decodeBase64Url(value)
    if (key.byteLength !== X25519_KEY_BYTES) throw new SecureChannelError(`Invalid HPKE ${label}`)
    return key
}

function validateHpkeEnvelope(value: HpkeEnvelope): void {
    if (!value || value.version !== 1 || value.suite !== SUITE_ID) throw new SecureChannelError('Invalid HPKE envelope')
    for (const field of ['messageId', 'senderId', 'recipientId', 'senderKeyId', 'recipientKeyId', 'enc', 'ciphertext'] as const) {
        if (typeof value[field] !== 'string' || !value[field]) throw new SecureChannelError(`Invalid HPKE envelope ${field}`)
    }
    if (!Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.expiresAt))
        || Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) throw new SecureChannelError('Invalid HPKE envelope lifetime')
    if (decodeBase64Url(value.enc).byteLength !== X25519_KEY_BYTES) throw new SecureChannelError('Invalid HPKE encapsulated key')
    decodeBase64Url(value.ciphertext)
}

export async function hpkeKeyId(publicKey: string): Promise<string> {
    const bytes = parseKey(publicKey, 'public key')
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', copyBuffer(bytes)))
    return `x25519-${encodeBase64Url(digest.slice(0, 16))}`
}

function copyBuffer(value: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(value.byteLength)
    copy.set(value)
    return copy.buffer
}

async function verifyKeyPair(keyPair: HpkeCryptoKeyPair): Promise<void> {
    try {
        const plaintext = new Uint8Array([0x43, 0x56])
        const sealed = await suite.seal({ recipientPublicKey: keyPair.publicKey }, plaintext)
        const opened = new Uint8Array(await suite.open({ recipientKey: keyPair.privateKey, enc: sealed.enc }, sealed.ct))
        if (!constantTimeEqual(plaintext, opened)) throw new Error('self-test mismatch')
    } catch (error) {
        throw new SecureChannelError('HPKE local public and private keys do not match', { cause: error })
    }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
    if (left.byteLength !== right.byteLength) return false
    let difference = 0
    for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!
    return difference === 0
}

function assertId(value: string, label: string): void {
    if (!value.trim()) throw new SecureChannelError(`HPKE ${label} is required`)
}
