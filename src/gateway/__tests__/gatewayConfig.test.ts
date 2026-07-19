import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
    loadGatewayConfig,
    loadMatrixCredential,
    parseGatewayConfig,
    writeGatewayConfig,
    writeMatrixCredential,
} from '../gatewayConfig'

const paths: string[] = []

afterEach(async () => {
    await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Gateway Matrix config', () => {
    it('separates public topology from Matrix tokens and crypto-store secrets', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-gateway-config-'))
        paths.push(directory)
        const configPath = join(directory, 'gateway.json')
        const credentialPath = join(directory, 'matrix-credential.json')
        await writeMatrixCredential(credentialPath, {
            accessToken: 'secret-access-token',
            refreshToken: 'secret-refresh-token',
            storePassphrase: 'secret-store-passphrase',
        })
        const written = await writeGatewayConfig({
            name: 'Office PC',
            matrix: matrixConfig(directory, credentialPath),
        }, configPath)
        const loaded = await loadGatewayConfig(configPath)
        const credential = await loadMatrixCredential(loaded)

        expect(loaded).toEqual(written)
        expect(loaded.version).toBe(2)
        expect(await readFile(configPath, 'utf8')).not.toContain('secret-')
        expect(credential).toMatchObject({
            session: { accessToken: 'secret-access-token', refreshToken: 'secret-refresh-token' },
            storePassphrase: 'secret-store-passphrase',
        })
    })

    it('rejects old Relay config and public plaintext Matrix transport', () => {
        expect(() => parseGatewayConfig({ version: 1, relayUrl: 'wss://relay.example' })).toThrow('version must be 2')
        const directory = resolve('codever-data')
        const base = {
            version: 2, gatewayId: 'gateway-1', workspaceId: 'workspace-1', name: 'Gateway',
            dataDirectory: directory,
            matrix: matrixConfig(directory, join(directory, 'credential.json')),
        }
        expect(() => parseGatewayConfig({
            ...base, matrix: { ...base.matrix, homeserver: 'http://matrix.example.com' },
        })).toThrow('must use https')
        expect(parseGatewayConfig({
            ...base, matrix: { ...base.matrix, homeserver: 'http://127.0.0.1:8008' },
        }).matrix.homeserver).toContain('127.0.0.1')
    })
})

function matrixConfig(directory: string, credentialPath: string) {
    return {
        homeserver: 'https://matrix.example.com',
        userId: '@gateway:example.com',
        deviceId: 'GATEWAY',
        controlRoomId: '!control:example.com',
        credentialPath: resolve(credentialPath),
        storePath: resolve(directory, 'matrix-store'),
        transportBinaryPath: resolve(directory, 'codever-matrix-transport.exe'),
    }
}
