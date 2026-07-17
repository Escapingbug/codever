import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadGatewayConfig, parseGatewayConfig, writeGatewayConfig } from '../gatewayConfig'

const paths: string[] = []

afterEach(async () => {
    await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Gateway config', () => {
    it('persists a stable identity without private key material', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-gateway-config-'))
        paths.push(directory)
        const configPath = join(directory, 'gateway.json')
        const written = await writeGatewayConfig({
            name: 'Office PC',
            relayUrl: 'wss://relay.example.com/connect',
        }, configPath)
        const loaded = await loadGatewayConfig(configPath)

        expect(loaded).toEqual(written)
        expect(loaded.gatewayId).toMatch(/^gateway_/)
        expect(await readFile(configPath, 'utf8')).not.toContain('PRIVATE KEY')
    })

    it('requires the OPAQUE application encryption layer on every network', () => {
        const base = {
            version: 1,
            gatewayId: 'gateway-1',
            workspaceId: 'workspace-1',
            name: 'Gateway',
            dataDirectory: resolve('codever-data'),
        }
        expect(() => parseGatewayConfig({ ...base, relayUrl: 'ws://relay.example.com/connect' })).toThrow('secure configuration')
        expect(parseGatewayConfig({ ...base, relayUrl: 'ws://127.0.0.1:3000/connect', secure: {} }).relayUrl).toContain('127.0.0.1')
        expect(parseGatewayConfig({
            ...base,
            relayUrl: 'ws://relay.example.com/v2/gateway/connect',
            secure: { pairingCode: 'ABC234-DEFGH-JKLMN' },
        })).toMatchObject({
            relayUrl: 'ws://relay.example.com/v2/gateway/connect',
            secure: { pairingCode: 'ABC234-DEFGH-JKLMN' },
        })
        expect(parseGatewayConfig({
            ...base, relayUrl: 'ws://relay.example.com/v2/gateway/connect', secure: {},
        }).secure).toEqual({})
    })
})
