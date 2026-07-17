const CONTEXT = new TextEncoder().encode('codever.secure-channel.v1')
const KEY_BYTES = 32
const NONCE_PREFIX_BYTES = 4
const NONCE_BYTES = 12
const MAX_SEQUENCE = 0xffff_ffff_ffff_ffffn

export type SecureChannelRole = 'initiator' | 'responder'

export interface SecureEnvelope {
    version: 1
    channelId: string
    sequence: string
    ciphertext: string
}

export class SecureChannelError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options)
        this.name = 'SecureChannelError'
    }
}

export class SessionCipher {
    private sendSequence = 0n
    private receiveSequence = 0n

    private constructor(
        readonly channelId: string,
        private readonly sendKey: CryptoKey,
        private readonly receiveKey: CryptoKey,
        private readonly sendNoncePrefix: Uint8Array,
        private readonly receiveNoncePrefix: Uint8Array,
        private readonly crypto: Crypto,
    ) {}

    static async create(input: {
        sessionKey: Uint8Array | string
        role: SecureChannelRole
        channelId: string
        crypto?: Crypto
    }): Promise<SessionCipher> {
        if (!input.channelId.trim()) throw new SecureChannelError('channelId is required')
        const crypto = input.crypto ?? globalThis.crypto
        if (!crypto?.subtle) throw new SecureChannelError('Web Crypto is unavailable')
        const sessionKey = typeof input.sessionKey === 'string'
            ? decodeBase64Url(input.sessionKey)
            : new Uint8Array(input.sessionKey)
        if (sessionKey.byteLength < 32) throw new SecureChannelError('Session key must contain at least 256 bits')

        const material = await deriveMaterial(crypto, sessionKey, input.channelId)
        sessionKey.fill(0)
        const initiatorKey = material.slice(0, KEY_BYTES)
        const responderKey = material.slice(KEY_BYTES, KEY_BYTES * 2)
        const initiatorNonce = material.slice(KEY_BYTES * 2, KEY_BYTES * 2 + NONCE_PREFIX_BYTES)
        const responderNonce = material.slice(KEY_BYTES * 2 + NONCE_PREFIX_BYTES)
        const [sendBytes, receiveBytes, sendNonce, receiveNonce] = input.role === 'initiator'
            ? [initiatorKey, responderKey, initiatorNonce, responderNonce]
            : [responderKey, initiatorKey, responderNonce, initiatorNonce]
        const sendKey = await crypto.subtle.importKey('raw', arrayBuffer(sendBytes), 'AES-GCM', false, ['encrypt'])
        const receiveKey = await crypto.subtle.importKey('raw', arrayBuffer(receiveBytes), 'AES-GCM', false, ['decrypt'])
        material.fill(0)
        return new SessionCipher(input.channelId, sendKey, receiveKey, sendNonce, receiveNonce, crypto)
    }

    async encrypt(value: unknown): Promise<SecureEnvelope> {
        if (this.sendSequence > MAX_SEQUENCE) throw new SecureChannelError('Send sequence exhausted')
        const sequence = this.sendSequence
        const plaintext = new TextEncoder().encode(JSON.stringify(value))
        const ciphertext = await this.crypto.subtle.encrypt({
            name: 'AES-GCM',
            iv: arrayBuffer(nonce(this.sendNoncePrefix, sequence)),
            additionalData: arrayBuffer(associatedData(this.channelId, sequence)),
            tagLength: 128,
        }, this.sendKey, plaintext)
        plaintext.fill(0)
        this.sendSequence += 1n
        return {
            version: 1,
            channelId: this.channelId,
            sequence: sequence.toString(10),
            ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
        }
    }

    async decrypt(envelope: SecureEnvelope): Promise<unknown> {
        validateEnvelope(envelope)
        if (envelope.channelId !== this.channelId) throw new SecureChannelError('Envelope belongs to another channel')
        const sequence = BigInt(envelope.sequence)
        if (sequence !== this.receiveSequence) {
            throw new SecureChannelError(`Unexpected receive sequence: expected ${this.receiveSequence}, received ${sequence}`)
        }
        let plaintext: ArrayBuffer
        try {
            plaintext = await this.crypto.subtle.decrypt({
                name: 'AES-GCM',
                iv: arrayBuffer(nonce(this.receiveNoncePrefix, sequence)),
                additionalData: arrayBuffer(associatedData(this.channelId, sequence)),
                tagLength: 128,
            }, this.receiveKey, arrayBuffer(decodeBase64Url(envelope.ciphertext)))
        } catch (error) {
            throw new SecureChannelError('Envelope authentication failed', { cause: error })
        }
        let value: unknown
        try {
            value = JSON.parse(new TextDecoder().decode(plaintext))
        } catch (error) {
            throw new SecureChannelError('Encrypted payload is not valid JSON', { cause: error })
        }
        this.receiveSequence += 1n
        return value
    }
}

async function deriveMaterial(crypto: Crypto, sessionKey: Uint8Array, channelId: string): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey('raw', arrayBuffer(sessionKey), 'HKDF', false, ['deriveBits'])
    const salt = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`codever:${channelId}`))
    const result = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: CONTEXT }, key, 576)
    return new Uint8Array(result)
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(value.byteLength)
    copy.set(value)
    return copy.buffer
}

function nonce(prefix: Uint8Array, sequence: bigint): Uint8Array {
    const result = new Uint8Array(NONCE_BYTES)
    result.set(prefix, 0)
    new DataView(result.buffer).setBigUint64(NONCE_PREFIX_BYTES, sequence, false)
    return result
}

function associatedData(channelId: string, sequence: bigint): Uint8Array {
    return new TextEncoder().encode(JSON.stringify([1, channelId, sequence.toString(10)]))
}

function validateEnvelope(value: SecureEnvelope): void {
    if (!value || value.version !== 1 || typeof value.channelId !== 'string' || !value.channelId) {
        throw new SecureChannelError('Invalid secure envelope')
    }
    if (!/^(0|[1-9][0-9]{0,19})$/.test(value.sequence)) throw new SecureChannelError('Invalid secure envelope sequence')
    const sequence = BigInt(value.sequence)
    if (sequence > MAX_SEQUENCE) throw new SecureChannelError('Secure envelope sequence is out of range')
    if (typeof value.ciphertext !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value.ciphertext)) {
        throw new SecureChannelError('Invalid secure envelope ciphertext')
    }
}

function encodeBase64Url(value: Uint8Array): string {
    if (typeof Buffer !== 'undefined') return Buffer.from(value).toString('base64url')
    let binary = ''
    for (const byte of value) binary += String.fromCharCode(byte)
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function decodeBase64Url(value: string): Uint8Array {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new SecureChannelError('Invalid base64url value')
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64url'))
    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
    const binary = atob(padded)
    return Uint8Array.from(binary, character => character.charCodeAt(0))
}
