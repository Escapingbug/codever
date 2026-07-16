import {
    createHash,
    createPrivateKey,
    createPublicKey,
    generateKeyPair,
    KeyObject,
    sign,
    verify,
} from 'node:crypto'
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { serializeGatewayAuthPayload } from '@codever/protocol'
import {
    GATEWAY_IDENTITY_ALGORITHM,
    GATEWAY_IDENTITY_VERSION,
    type GatewayEnrollmentBundle,
    type GatewayIdentityOptions,
    type RelayAuthenticationChallenge,
    type SignedRelayAuthenticationChallenge,
} from './types'

const generateKeyPairAsync = promisify(generateKeyPair)
const DEFAULT_PRIVATE_KEY_FILENAME = 'gateway-identity.pem'
const PRIVATE_KEY_MODE = 0o600
const IDENTITY_DIRECTORY_MODE = 0o700

const initializations = new Map<string, Promise<GatewayIdentity>>()

export class GatewayIdentityError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options)
        this.name = 'GatewayIdentityError'
    }
}

export class GatewayIdentity {
    readonly fingerprint: string
    readonly publicKeySpkiPem: string

    private constructor(private readonly privateKey: KeyObject) {
        const publicKey = createPublicKey(privateKey)
        this.publicKeySpkiPem = exportPublicKeySpkiPem(publicKey)
        this.fingerprint = fingerprintPublicKey(publicKey)
    }

    static fromPrivateKeyPem(privateKeyPem: string | Buffer): GatewayIdentity {
        const pemText = privateKeyPem.toString()
        if (
            !pemText.trimStart().startsWith('-----BEGIN PRIVATE KEY-----')
            || !pemText.trimEnd().endsWith('-----END PRIVATE KEY-----')
        ) {
            throw new GatewayIdentityError('Gateway identity file is not a valid PKCS#8 PEM private key')
        }

        let privateKey: KeyObject
        try {
            privateKey = createPrivateKey({ key: pemText, format: 'pem', type: 'pkcs8' })
        } catch (error) {
            throw new GatewayIdentityError('Gateway identity file is not a valid PKCS#8 PEM private key', {
                cause: error,
            })
        }

        assertP256PrivateKey(privateKey)
        return new GatewayIdentity(privateKey)
    }

    enrollmentBundle(): GatewayEnrollmentBundle {
        return {
            version: GATEWAY_IDENTITY_VERSION,
            algorithm: GATEWAY_IDENTITY_ALGORITHM,
            fingerprint: this.fingerprint,
            publicKeySpkiPem: this.publicKeySpkiPem,
        }
    }

    signRelayChallenge(challenge: RelayAuthenticationChallenge, gatewayId: string): SignedRelayAuthenticationChallenge {
        assertChallenge(challenge)
        const payload = serializeGatewayAuthPayload(challenge, gatewayId, this.fingerprint)
        const signature = sign('sha256', payload, this.privateKey)

        return {
            version: GATEWAY_IDENTITY_VERSION,
            algorithm: GATEWAY_IDENTITY_ALGORITHM,
            fingerprint: this.fingerprint,
            signature: signature.toString('base64url'),
        }
    }
}

export function initializeGatewayIdentity(
    options: GatewayIdentityOptions | string,
): Promise<GatewayIdentity> {
    const normalized = normalizeOptions(options)
    const existing = initializations.get(normalized.privateKeyPath)
    if (existing) {
        return existing
    }

    const initialization = initialize(normalized.directory, normalized.privateKeyPath)
    initializations.set(normalized.privateKeyPath, initialization)
    void initialization.finally(() => {
        if (initializations.get(normalized.privateKeyPath) === initialization) {
            initializations.delete(normalized.privateKeyPath)
        }
    }).catch(() => undefined)
    return initialization
}

export function fingerprintPublicKey(publicKey: KeyObject | string | Buffer): string {
    const key = toP256PublicKey(publicKey)
    const spkiDer = key.export({ type: 'spki', format: 'der' })
    return `sha256:${createHash('sha256').update(spkiDer).digest('base64url')}`
}

export function validateEnrollmentBundle(bundle: GatewayEnrollmentBundle): GatewayEnrollmentBundle {
    if (!bundle || typeof bundle !== 'object') {
        throw new GatewayIdentityError('Gateway enrollment bundle must be an object')
    }
    if (bundle.version !== GATEWAY_IDENTITY_VERSION) {
        throw new GatewayIdentityError(`Unsupported Gateway enrollment version: ${String(bundle.version)}`)
    }
    if (bundle.algorithm !== GATEWAY_IDENTITY_ALGORITHM) {
        throw new GatewayIdentityError(`Unsupported Gateway identity algorithm: ${String(bundle.algorithm)}`)
    }
    if (typeof bundle.publicKeySpkiPem !== 'string' || bundle.publicKeySpkiPem.includes('PRIVATE KEY')) {
        throw new GatewayIdentityError('Gateway enrollment bundle must contain only a public SPKI PEM key')
    }

    const actualFingerprint = fingerprintPublicKey(bundle.publicKeySpkiPem)
    if (bundle.fingerprint !== actualFingerprint) {
        throw new GatewayIdentityError('Gateway enrollment fingerprint does not match its public key')
    }

    return {
        version: GATEWAY_IDENTITY_VERSION,
        algorithm: GATEWAY_IDENTITY_ALGORITHM,
        fingerprint: bundle.fingerprint,
        publicKeySpkiPem: bundle.publicKeySpkiPem,
    }
}

export function verifyRelayChallengeSignature(
    challenge: RelayAuthenticationChallenge,
    signedChallenge: SignedRelayAuthenticationChallenge,
    enrollment: GatewayEnrollmentBundle,
    gatewayId: string,
): boolean {
    try {
        const validatedEnrollment = validateEnrollmentBundle(enrollment)
        if (
            signedChallenge.version !== GATEWAY_IDENTITY_VERSION
            || signedChallenge.algorithm !== GATEWAY_IDENTITY_ALGORITHM
            || signedChallenge.fingerprint !== validatedEnrollment.fingerprint
        ) {
            return false
        }

        const signature = Buffer.from(signedChallenge.signature, 'base64url')
        if (signature.length === 0) {
            return false
        }
        return verify(
            'sha256',
            serializeGatewayAuthPayload(challenge, gatewayId, signedChallenge.fingerprint),
            validatedEnrollment.publicKeySpkiPem,
            signature,
        )
    } catch {
        return false
    }
}

async function initialize(directory: string, privateKeyPath: string): Promise<GatewayIdentity> {
    await mkdir(directory, { recursive: true, mode: IDENTITY_DIRECTORY_MODE })
    await chmod(directory, IDENTITY_DIRECTORY_MODE)

    let privateKeyPem: Buffer
    try {
        privateKeyPem = await readExistingPrivateKey(privateKeyPath)
    } catch (error) {
        if (!isMissingFileError(error)) {
            throw error
        }
        privateKeyPem = await generateAndPersistPrivateKey(privateKeyPath)
    }

    return GatewayIdentity.fromPrivateKeyPem(privateKeyPem)
}

async function readExistingPrivateKey(privateKeyPath: string): Promise<Buffer> {
    const file = await lstat(privateKeyPath)
    if (!file.isFile() || file.isSymbolicLink()) {
        throw new GatewayIdentityError(`Gateway identity path is not a regular file: ${privateKeyPath}`)
    }
    await chmod(privateKeyPath, PRIVATE_KEY_MODE)
    return readFile(privateKeyPath)
}

async function generateAndPersistPrivateKey(privateKeyPath: string): Promise<Buffer> {
    const { privateKey } = await generateKeyPairAsync('ec', {
        namedCurve: 'prime256v1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    const privateKeyPem = Buffer.from(privateKey)

    try {
        await writeFile(privateKeyPath, privateKeyPem, {
            flag: 'wx',
            mode: PRIVATE_KEY_MODE,
        })
        await chmod(privateKeyPath, PRIVATE_KEY_MODE)
        return privateKeyPem
    } catch (error) {
        if (!isAlreadyExistsError(error)) {
            throw new GatewayIdentityError(`Unable to persist Gateway identity at ${privateKeyPath}`, {
                cause: error,
            })
        }
        return readExistingPrivateKey(privateKeyPath)
    }
}

function normalizeOptions(options: GatewayIdentityOptions | string): {
    directory: string
    privateKeyPath: string
} {
    const value = typeof options === 'string' ? { directory: options } : options
    if (!value.directory || typeof value.directory !== 'string') {
        throw new GatewayIdentityError('Gateway identity directory is required')
    }
    const directory = resolve(value.directory)
    const filename = value.privateKeyFilename ?? DEFAULT_PRIVATE_KEY_FILENAME
    if (!filename || isAbsolute(filename) || filename !== filename.split(/[\\/]/).at(-1)) {
        throw new GatewayIdentityError('Gateway identity privateKeyFilename must be a filename, not a path')
    }
    return { directory, privateKeyPath: join(directory, filename) }
}

function assertP256PrivateKey(key: KeyObject): void {
    if (key.type !== 'private' || key.asymmetricKeyType !== 'ec') {
        throw new GatewayIdentityError('Gateway identity must be an EC private key')
    }
    if (key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
        throw new GatewayIdentityError('Gateway identity EC private key must use the P-256 curve')
    }
}

function toP256PublicKey(key: KeyObject | string | Buffer): KeyObject {
    let publicKey: KeyObject
    try {
        publicKey = key instanceof KeyObject
            ? (key.type === 'public' ? key : createPublicKey(key))
            : createPublicKey({ key, format: 'pem' })
    } catch (error) {
        throw new GatewayIdentityError('Gateway public key is not a valid SPKI PEM key', { cause: error })
    }
    if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
        throw new GatewayIdentityError('Gateway public key must be an EC P-256 key')
    }
    return publicKey
}

function exportPublicKeySpkiPem(publicKey: KeyObject): string {
    return publicKey.export({ type: 'spki', format: 'pem' }).toString()
}

function assertChallenge(challenge: RelayAuthenticationChallenge): void {
    if (!challenge || challenge.version !== GATEWAY_IDENTITY_VERSION) {
        throw new GatewayIdentityError(`Unsupported Relay authentication challenge version: ${String(challenge?.version)}`)
    }
    for (const field of ['relayId', 'challengeId', 'nonce', 'issuedAt', 'expiresAt'] as const) {
        if (typeof challenge[field] !== 'string' || challenge[field].length === 0) {
            throw new GatewayIdentityError(`Relay authentication challenge ${field} must be a non-empty string`)
        }
    }
}

function isMissingFileError(error: unknown): boolean {
    return isNodeError(error) && error.code === 'ENOENT'
}

function isAlreadyExistsError(error: unknown): boolean {
    return isNodeError(error) && error.code === 'EEXIST'
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error
}
