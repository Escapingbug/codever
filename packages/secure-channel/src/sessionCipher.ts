const CONTEXT = new TextEncoder().encode('codever.secure-channel.v2')
const KEY_BYTES = 32
const NONCE_BYTES = 12

export type SecureChannelRole = 'initiator' | 'responder'

export interface SecureEnvelope {
    version: 2
    channelId: string
    messageId: string
    nonce: string
    ciphertext: string
}

export class SecureChannelError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options)
        this.name = 'SecureChannelError'
    }
}

/**
 * Short-lived PAKE record protection.
 *
 * Records are independently encrypted with a random nonce. They deliberately do
 * not share a receive counter, so delayed or reordered transport frames cannot
 * corrupt the cryptographic state of the connection. Application protocols own
 * replay/idempotency decisions through their message and operation identifiers.
 */
export class SessionCipher {
    private constructor(
        readonly channelId: string,
        private readonly sendKey: CryptoKey,
        private readonly receiveKey: CryptoKey,
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
        const [sendBytes, receiveBytes] = input.role === 'initiator'
            ? [initiatorKey, responderKey]
            : [responderKey, initiatorKey]
        const sendKey = await crypto.subtle.importKey('raw', arrayBuffer(sendBytes), 'AES-GCM', false, ['encrypt'])
        const receiveKey = await crypto.subtle.importKey('raw', arrayBuffer(receiveBytes), 'AES-GCM', false, ['decrypt'])
        material.fill(0)
        return new SessionCipher(input.channelId, sendKey, receiveKey, crypto)
    }

    async encrypt(value: unknown): Promise<SecureEnvelope> {
        const messageId = randomId(this.crypto)
        const nonce = this.crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
        const plaintext = new TextEncoder().encode(JSON.stringify(value))
        const ciphertext = await this.crypto.subtle.encrypt({
            name: 'AES-GCM',
            iv: arrayBuffer(nonce),
            additionalData: arrayBuffer(associatedData(this.channelId, messageId)),
            tagLength: 128,
        }, this.sendKey, plaintext)
        plaintext.fill(0)
        return {
            version: 2,
            channelId: this.channelId,
            messageId,
            nonce: encodeBase64Url(nonce),
            ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
        }
    }

    async decrypt(envelope: SecureEnvelope): Promise<unknown> {
        validateEnvelope(envelope)
        if (envelope.channelId !== this.channelId) throw new SecureChannelError('Envelope belongs to another channel')
        let plaintext: ArrayBuffer
        try {
            plaintext = await this.crypto.subtle.decrypt({
                name: 'AES-GCM',
                iv: arrayBuffer(decodeBase64Url(envelope.nonce)),
                additionalData: arrayBuffer(associatedData(this.channelId, envelope.messageId)),
                tagLength: 128,
            }, this.receiveKey, arrayBuffer(decodeBase64Url(envelope.ciphertext)))
        } catch (error) {
            throw new SecureChannelError('Envelope authentication failed', { cause: error })
        }
        try {
            return JSON.parse(new TextDecoder().decode(plaintext)) as unknown
        } catch (error) {
            throw new SecureChannelError('Encrypted payload is not valid JSON', { cause: error })
        }
    }
}

async function deriveMaterial(crypto: Crypto, sessionKey: Uint8Array, channelId: string): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey('raw', arrayBuffer(sessionKey), 'HKDF', false, ['deriveBits'])
    const salt = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`codever:${channelId}`))
    const result = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: CONTEXT }, key, KEY_BYTES * 2 * 8)
    return new Uint8Array(result)
}

function associatedData(channelId: string, messageId: string): Uint8Array {
    return new TextEncoder().encode(JSON.stringify([2, channelId, messageId]))
}

function validateEnvelope(value: SecureEnvelope): void {
    if (!value || value.version !== 2 || typeof value.channelId !== 'string' || !value.channelId
        || typeof value.messageId !== 'string' || !value.messageId) {
        throw new SecureChannelError('Invalid secure envelope')
    }
    if (decodeBase64Url(value.nonce).byteLength !== NONCE_BYTES) throw new SecureChannelError('Invalid secure envelope nonce')
    if (typeof value.ciphertext !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value.ciphertext)) {
        throw new SecureChannelError('Invalid secure envelope ciphertext')
    }
}

function randomId(crypto: Crypto): string {
    return encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)))
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(value.byteLength)
    copy.set(value)
    return copy.buffer
}

export function encodeBase64Url(value: Uint8Array): string {
    if (typeof Buffer !== 'undefined') return Buffer.from(value).toString('base64url')
    let binary = ''
    for (const byte of value) binary += String.fromCharCode(byte)
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function decodeBase64Url(value: string): Uint8Array {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new SecureChannelError('Invalid base64url value')
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64url'))
    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
    const binary = atob(padded)
    return Uint8Array.from(binary, character => character.charCodeAt(0))
}
