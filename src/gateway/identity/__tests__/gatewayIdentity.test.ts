import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
    GATEWAY_IDENTITY_ALGORITHM,
    GatewayIdentityError,
    fingerprintPublicKey,
    initializeGatewayIdentity,
    validateEnrollmentBundle,
    verifyRelayChallengeSignature,
    type RelayAuthenticationChallenge,
} from '..'

const temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
        recursive: true,
        force: true,
    })))
})

describe('Gateway machine identity', () => {
    it('generates a persistent PKCS#8 P-256 identity and public-only enrollment bundle', async () => {
        const directory = await makeTemporaryDirectory()
        const first = await initializeGatewayIdentity(directory)
        const keyPath = join(directory, 'gateway-identity.pem')
        const privateKeyPem = await readFile(keyPath, 'utf8')
        const enrollment = first.enrollmentBundle()

        expect(privateKeyPem).toContain('BEGIN PRIVATE KEY')
        expect(privateKeyPem).not.toContain('BEGIN EC PRIVATE KEY')
        if (process.platform !== 'win32') {
            expect((await stat(keyPath)).mode & 0o777).toBe(0o600)
        }
        expect(enrollment).toMatchObject({
            version: 1,
            algorithm: GATEWAY_IDENTITY_ALGORITHM,
            fingerprint: first.fingerprint,
        })
        expect(enrollment.publicKeySpkiPem).toContain('BEGIN PUBLIC KEY')
        expect(JSON.stringify(enrollment)).not.toContain('PRIVATE KEY')
        expect(fingerprintPublicKey(enrollment.publicKeySpkiPem)).toBe(first.fingerprint)

        const reopened = await initializeGatewayIdentity(directory)
        expect(reopened.fingerprint).toBe(first.fingerprint)
        expect(reopened.publicKeySpkiPem).toBe(first.publicKeySpkiPem)
    })

    it('serializes concurrent initialization for one identity path', async () => {
        const directory = await makeTemporaryDirectory()
        const identities = await Promise.all(Array.from(
            { length: 20 },
            () => initializeGatewayIdentity(directory),
        ))

        expect(new Set(identities.map((identity) => identity.fingerprint))).toHaveLength(1)
        expect((await readFile(join(directory, 'gateway-identity.pem'), 'utf8')).match(/BEGIN PRIVATE KEY/g)).toHaveLength(1)
    })

    it('signs versioned Relay challenges and verifies them with enrollment data', async () => {
        const identity = await initializeGatewayIdentity(await makeTemporaryDirectory())
        const signed = identity.signRelayChallenge(challenge, 'gateway-1')

        expect(verifyRelayChallengeSignature(challenge, signed, identity.enrollmentBundle(), 'gateway-1')).toBe(true)
        expect(verifyRelayChallengeSignature(
            { ...challenge, nonce: 'tampered-value-that-is-still-32-bytes' },
            signed,
            identity.enrollmentBundle(),
            'gateway-1',
        )).toBe(false)
        expect(verifyRelayChallengeSignature(
            challenge,
            { ...signed, signature: `${signed.signature.slice(0, -2)}aa` },
            identity.enrollmentBundle(),
            'gateway-1',
        )).toBe(false)
    })

    it('rejects corrupt, non-private, and wrong-curve identity files without replacing them', async () => {
        const fixtures = [
            ['corrupt', 'not a pem', 'valid PKCS#8 PEM private key'],
            ['public', generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'pem' }), 'valid PKCS#8 PEM private key'],
            ['RSA', generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }), 'EC private key'],
            ['wrong curve', generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }), 'P-256 curve'],
        ] as const

        for (const [name, contents, expectedMessage] of fixtures) {
            const directory = await makeTemporaryDirectory()
            const keyPath = join(directory, 'gateway-identity.pem')
            await writeFile(keyPath, contents)

            await expect(initializeGatewayIdentity(directory), name).rejects.toThrow(expectedMessage)
            expect(await readFile(keyPath, 'utf8')).toBe(contents.toString())
        }
    })

    it('detects enrollment key/fingerprint mismatches and never accepts private PEM', async () => {
        const first = await initializeGatewayIdentity(await makeTemporaryDirectory())
        const second = await initializeGatewayIdentity(await makeTemporaryDirectory())

        expect(() => validateEnrollmentBundle({
            ...first.enrollmentBundle(),
            publicKeySpkiPem: second.publicKeySpkiPem,
        })).toThrow('fingerprint does not match')
        expect(() => validateEnrollmentBundle({
            ...first.enrollmentBundle(),
            publicKeySpkiPem: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n',
        })).toThrow('only a public SPKI PEM key')
        expect(validateEnrollmentBundle({
            ...first.enrollmentBundle(),
            privateKeyPem: 'must not survive validation',
        } as ReturnType<typeof first.enrollmentBundle>)).not.toHaveProperty('privateKeyPem')
    })

    it('rejects unsupported challenge versions and invalid identity paths', async () => {
        const identity = await initializeGatewayIdentity(await makeTemporaryDirectory())
        expect(() => identity.signRelayChallenge({ ...challenge, version: 2 as 1 }, 'gateway-1')).toThrow(
            'Unsupported Relay authentication challenge version',
        )
        expect(() => initializeGatewayIdentity({
            directory: 'somewhere',
            privateKeyFilename: '../outside.pem',
        })).toThrow('must be a filename')
        expect(() => validateEnrollmentBundle({
            ...identity.enrollmentBundle(),
            algorithm: 'RSA' as typeof GATEWAY_IDENTITY_ALGORITHM,
        })).toThrow(GatewayIdentityError)
    })
})

const challenge: RelayAuthenticationChallenge = {
    version: 1,
    relayId: 'relay.example.com',
    challengeId: 'challenge-123',
    nonce: '4Qb0Q0X28whXqnFqOD0pSQ0123456789ab',
    issuedAt: '2026-07-16T10:00:00.000Z',
    expiresAt: '2026-07-16T10:01:00.000Z',
}

async function makeTemporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'codever-gateway-identity-'))
    temporaryDirectories.push(directory)
    return directory
}
