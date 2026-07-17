import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export interface GatewayTlsConfig {
    certPath?: string
    keyPath?: string
    caPath?: string
}

export interface GatewayConfig {
    version: 1
    gatewayId: string
    workspaceId: string
    name: string
    relayUrl: string
    dataDirectory: string
    allowedRoots: string[]
    providersPath?: string
    tls?: GatewayTlsConfig
    secure: { pairingCode?: string }
}

export function defaultGatewayConfigPath(): string {
    return join(homedir(), '.config', 'codever', 'gateway.json')
}

export async function loadGatewayConfig(path = defaultGatewayConfigPath()): Promise<GatewayConfig> {
    let value: unknown
    try {
        value = JSON.parse(await readFile(resolve(path), 'utf8'))
    } catch (error) {
        throw new Error(`Unable to read Gateway config at ${resolve(path)}`, { cause: error })
    }
    return parseGatewayConfig(value)
}

export async function writeGatewayConfig(
    input: Pick<GatewayConfig, 'name' | 'relayUrl' | 'allowedRoots'> & Partial<GatewayConfig>,
    path = defaultGatewayConfigPath(),
): Promise<GatewayConfig> {
    const target = resolve(path)
    const config = parseGatewayConfig({
        version: 1,
        gatewayId: input.gatewayId ?? `gateway_${randomUUID()}`,
        workspaceId: input.workspaceId ?? 'default',
        name: input.name,
        relayUrl: input.relayUrl,
        dataDirectory: input.dataDirectory ?? join(dirname(target), 'gateway-data'),
        allowedRoots: input.allowedRoots,
        ...(input.providersPath ? { providersPath: input.providersPath } : {}),
        ...(input.tls ? { tls: input.tls } : {}),
        secure: input.secure ?? {},
    })
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    return config
}

export function parseGatewayConfig(value: unknown): GatewayConfig {
    if (!isRecord(value) || value.version !== 1) throw new Error('Gateway config version must be 1')
    const gatewayId = text(value.gatewayId, 'gatewayId')
    const workspaceId = text(value.workspaceId, 'workspaceId')
    const name = text(value.name, 'name')
    const relayUrl = text(value.relayUrl, 'relayUrl')
    const relay = new URL(relayUrl)
    if (value.secure === undefined) throw new Error('secure configuration is required')
    const secure = parseSecure(value.secure)
    if (relay.protocol !== 'wss:' && !(relay.protocol === 'ws:' && (isLoopback(relay.hostname) || secure))) {
        throw new Error('relayUrl must use wss://; public ws:// requires secure OPAQUE transport')
    }
    const dataDirectory = absolute(value.dataDirectory, 'dataDirectory')
    if (!Array.isArray(value.allowedRoots) || value.allowedRoots.length === 0) {
        throw new Error('allowedRoots must contain at least one absolute directory')
    }
    const allowedRoots = [...new Set(value.allowedRoots.map((root) => absolute(root, 'allowedRoots item')))]
    const providersPath = value.providersPath === undefined ? undefined : absolute(value.providersPath, 'providersPath')
    const tls = value.tls === undefined ? undefined : parseTls(value.tls)
    return {
        version: 1,
        gatewayId,
        workspaceId,
        name,
        relayUrl: relay.toString(),
        dataDirectory,
        allowedRoots,
        ...(providersPath ? { providersPath } : {}),
        ...(tls ? { tls } : {}),
        secure,
    }
}

function parseSecure(value: unknown): GatewayConfig['secure'] {
    if (!isRecord(value)) throw new Error('secure must be an object')
    if (Object.keys(value).some(key => key !== 'pairingCode')) throw new Error('secure contains an unknown option')
    if (value.pairingCode === undefined) return {}
    const pairingCode = text(value.pairingCode, 'secure.pairingCode').toUpperCase()
    if (!/^[A-HJ-NP-Z2-9]{6}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/.test(pairingCode)) {
        throw new Error('secure.pairingCode is invalid')
    }
    return { pairingCode }
}

function parseTls(value: unknown): GatewayTlsConfig {
    if (!isRecord(value)) throw new Error('tls must be an object')
    const result: GatewayTlsConfig = {}
    if (value.certPath !== undefined) result.certPath = absolute(value.certPath, 'tls.certPath')
    if (value.keyPath !== undefined) result.keyPath = absolute(value.keyPath, 'tls.keyPath')
    if (value.caPath !== undefined) result.caPath = absolute(value.caPath, 'tls.caPath')
    if ((result.certPath === undefined) !== (result.keyPath === undefined)) {
        throw new Error('tls.certPath and tls.keyPath must be supplied together')
    }
    return result
}

function absolute(value: unknown, field: string): string {
    const path = text(value, field)
    if (!isAbsolute(path)) throw new Error(`${field} must be an absolute path`)
    return resolve(path)
}

function text(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`)
    return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLoopback(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}
