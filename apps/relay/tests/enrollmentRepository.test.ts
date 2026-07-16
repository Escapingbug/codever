import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serializeGatewayAuthPayload, type GatewayEnrollmentIdentity } from '@codever/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import {
    BootstrapRequiredError,
    EnrollmentChallengeStore,
    EnrollmentConflictError,
    GatewayEnrollmentRepository,
} from '../src/enrollmentRepository'
import { runLocalControlCommand, startLocalControlServer } from '../src/localControl'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))))

describe('dynamic Gateway enrollment', () => {
    it('proves private-key possession, uses one pending code, and persists approval/bootstrap', async () => {
        const directory = await tempDirectory()
        let now = new Date('2026-07-16T00:00:00.000Z')
        const repository = await GatewayEnrollmentRepository.open({ path: join(directory, 'state.json'), now: () => now, code: () => 'ABC23456' })
        const gateway = identity('gateway-1')
        const challenges = new EnrollmentChallengeStore(repository, { relayId: 'relay-1', now: () => now })
        const challenge = challenges.issue(gateway.publicIdentity, '127.0.0.1')
        const pending = await challenges.prove(gateway.proof(challenge), 600_000, '127.0.0.1')
        expect(pending).toMatchObject({ status: 'pending', code: 'ABC23456', fingerprint: gateway.publicIdentity.fingerprint })

        await expect(repository.approve('ABC23456', 'client', { workspaceId: 'home' })).rejects.toBeInstanceOf(BootstrapRequiredError)
        await expect(repository.approve('ABC23456', 'local', { fingerprint: 'sha256:wrong' })).rejects.toBeInstanceOf(EnrollmentConflictError)
        await repository.approve('ABC23456', 'local')
        expect(repository.bootstrapComplete).toBe(true)
        expect(await repository.get('gateway-1', gateway.publicIdentity.fingerprint)).toMatchObject({ enabled: true })

        const restored = await GatewayEnrollmentRepository.open({ path: join(directory, 'state.json'), now: () => now })
        expect(restored.bootstrapComplete).toBe(true)
        expect(await restored.get('gateway-1', gateway.publicIdentity.fingerprint)).toBeTruthy()
        await restored.revoke('gateway-1', 'home')
        expect((await restored.get('gateway-1', gateway.publicIdentity.fingerprint))?.enabled).toBe(false)
        expect(restored.bootstrapComplete).toBe(true)
        now = new Date('2027-01-01T00:00:00.000Z')
    })

    it('allows client approval only after bootstrap and enforces exact metadata', async () => {
        const repository = await GatewayEnrollmentRepository.open({ code: sequence('AAA23456', 'BBB23456') })
        const first = identity('gateway-1')
        await repository.createPending(first.publicIdentity, 60_000)
        await repository.approve('AAA23456', 'local')
        const second = identity('gateway-2', 'Laptop', 'windows')
        await repository.createPending(second.publicIdentity, 60_000)
        await expect(repository.approve('BBB23456', 'client', { workspaceId: 'home', fingerprint: second.publicIdentity.fingerprint, name: 'Wrong', platform: 'windows' })).rejects.toBeInstanceOf(EnrollmentConflictError)
        await expect(repository.approve('BBB23456', 'client', { workspaceId: 'home', fingerprint: second.publicIdentity.fingerprint, name: 'Laptop', platform: 'windows' })).resolves.toMatchObject({ status: 'approved' })
    })

    it('serves local list/approve/reset over authenticated host IPC', async () => {
        const directory = await tempDirectory()
        const repository = await GatewayEnrollmentRepository.open({ path: join(directory, 'state.json'), code: () => 'JPC23456' })
        await repository.createPending(identity('gateway-ipc').publicIdentity, 60_000)
        const control = await startLocalControlServer(directory, repository)
        try {
            await expect(runLocalControlCommand(directory, ['list'])).resolves.toMatchObject({ bootstrapComplete: false, enrollments: [{ code: 'JPC23456' }] })
            await expect(runLocalControlCommand(directory, ['approve', 'JPC23456'])).resolves.toMatchObject({ status: 'approved' })
            await expect(runLocalControlCommand(directory, ['reset-bootstrap', 'wrong'])).rejects.toThrow('Exact confirmation')
            await expect(runLocalControlCommand(directory, ['reset-bootstrap', 'RESET-GATEWAY-BOOTSTRAP'])).resolves.toEqual({ bootstrapComplete: false })
        } finally { await control.close() }
    })
})

function identity(gatewayId: string, name = 'Gateway', platform: GatewayEnrollmentIdentity['platform'] = 'linux') {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const publicKeySpkiPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const fingerprint = `sha256:${createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64url')}`
    const publicIdentity: GatewayEnrollmentIdentity = { gatewayId, workspaceId: 'home', name, platform, algorithm: 'ECDSA-P256-SHA256', fingerprint, publicKeySpkiPem }
    return {
        publicIdentity,
        proof: (value: ReturnType<EnrollmentChallengeStore['issue']>) => ({
            enrollmentId: value.enrollmentId, gatewayId, fingerprint,
            signature: sign('sha256', serializeGatewayAuthPayload(value.challenge, gatewayId, fingerprint), privateKey).toString('base64url'),
        }),
    }
}

function sequence(...values: string[]): () => string { let index = 0; return () => values[index++]! }
async function tempDirectory(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'codever-enroll-')); directories.push(path); return path }
