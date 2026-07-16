import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRelayConfig, StaticEnrolledGatewayKeyRepository } from '../src/config'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Relay runtime configuration', () => {
    it('loads JSON, relative TLS files, and a public-only enrollment file with environment overrides', async () => {
        const directory = await temporaryDirectory()
        const enrollment = gatewayEnrollment('gateway-1')
        await writeFile(join(directory, 'relay.crt'), 'test certificate')
        await writeFile(join(directory, 'relay.key'), 'test TLS server key')
        await writeFile(join(directory, 'enrollment.json'), JSON.stringify({ gateways: [enrollment] }))
        await writeFile(join(directory, 'relay.json'), JSON.stringify({
            host: '0.0.0.0',
            port: 8787,
            relayId: 'relay-from-file',
            logger: false,
            tls: { certFile: './relay.crt', keyFile: './relay.key' },
            enrollmentFile: './enrollment.json',
        }))

        const config = await loadRelayConfig({
            CODEVER_RELAY_CONFIG: join(directory, 'relay.json'),
            CODEVER_RELAY_PORT: '9443',
        })

        expect(config).toMatchObject({
            host: '0.0.0.0', port: 9443, relayId: 'relay-from-file', logger: false,
            insecureDevAuth: false, gateways: [{ gatewayId: 'gateway-1', enabled: true }],
            dataDirectory: join(directory, 'data'), repositoryMode: 'durable',
        })
        expect(config.tls?.cert.toString()).toBe('test certificate')
        expect(config.tls?.key.toString()).toBe('test TLS server key')
        const repository = new StaticEnrolledGatewayKeyRepository(config.gateways)
        await expect(repository.get('gateway-1', enrollment.fingerprint)).resolves.toMatchObject({ gatewayId: 'gateway-1' })
    })

    it('enables insecure client auth only for the exact explicit environment value true', async () => {
        await expect(loadRelayConfig({ CODEVER_RELAY_INSECURE_DEV_AUTH: '1' }))
            .resolves.toMatchObject({ insecureDevAuth: false })
        await expect(loadRelayConfig({ CODEVER_RELAY_INSECURE_DEV_AUTH: 'TRUE' }))
            .resolves.toMatchObject({ insecureDevAuth: false })
        await expect(loadRelayConfig({ CODEVER_RELAY_INSECURE_DEV_AUTH: 'true' }))
            .resolves.toMatchObject({ insecureDevAuth: true })
    })

    it('rejects Gateway private-key fields and mismatched public-key fingerprints', async () => {
        const enrollment = gatewayEnrollment('gateway-1')
        await expect(loadRelayConfig({
            CODEVER_RELAY_GATEWAYS_JSON: JSON.stringify([{ ...enrollment, privateKeyPem: 'forbidden' }]),
        })).rejects.toThrow('must never contain a Gateway private key')

        await expect(loadRelayConfig({
            CODEVER_RELAY_GATEWAYS_JSON: JSON.stringify([{ ...enrollment, fingerprint: 'sha256:wrong' }]),
        })).rejects.toThrow('fingerprint does not match')
    })

    it('requires TLS certificate and key paths as a pair', async () => {
        await expect(loadRelayConfig({ CODEVER_RELAY_TLS_CERT_FILE: 'relay.crt' }))
            .rejects.toThrow('TLS requires both certFile and keyFile')
    })

    it('uses durable storage by default and requires an explicit valid memory mode', async () => {
        const directory = await temporaryDirectory()
        await writeFile(join(directory, 'relay.json'), JSON.stringify({
            dataDirectory: './relay-state',
            repositoryMode: 'memory',
        }))
        await expect(loadRelayConfig({ CODEVER_RELAY_CONFIG: join(directory, 'relay.json') })).resolves.toMatchObject({
            dataDirectory: join(directory, 'relay-state'),
            repositoryMode: 'memory',
        })
        await expect(loadRelayConfig({ CODEVER_RELAY_REPOSITORY_MODE: 'volatile' }))
            .rejects.toThrow('repositoryMode must be durable or memory')
    })
})

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'codever-relay-config-'))
    temporaryDirectories.push(directory)
    return directory
}

function gatewayEnrollment(gatewayId: string): {
    gatewayId: string
    fingerprint: string
    publicKeySpkiPem: string
    enabled: true
} {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const publicKeySpkiPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const fingerprint = `sha256:${createHash('sha256')
        .update(publicKey.export({ type: 'spki', format: 'der' }))
        .digest('base64url')}`
    return { gatewayId, fingerprint, publicKeySpkiPem, enabled: true }
}
