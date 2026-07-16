import { createHash, createPublicKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { EnrolledGatewayKey, EnrolledGatewayKeyRepository } from './auth'

export interface RelayTlsConfig {
    cert: Buffer
    key: Buffer
    certFile: string
    keyFile: string
}

export interface RelayRuntimeConfig {
    host: string
    port: number
    relayId: string
    logger: boolean
    tls?: RelayTlsConfig
    gateways: EnrolledGatewayKey[]
    insecureDevAuth: boolean
    devWorkspaceId: string
    dataDirectory: string
    repositoryMode: 'durable' | 'memory'
}

interface JsonRelayConfig extends Record<string, unknown> {
    host?: unknown
    port?: unknown
    relayId?: unknown
    logger?: unknown
    tls?: unknown
    enrollmentFile?: unknown
    gateways?: unknown
    dataDirectory?: unknown
    repositoryMode?: unknown
}

const CONFIG_KEYS = new Set(['host', 'port', 'relayId', 'logger', 'tls', 'enrollmentFile', 'gateways', 'dataDirectory', 'repositoryMode'])
const GATEWAY_KEYS = new Set(['gatewayId', 'fingerprint', 'publicKeySpkiPem', 'enabled'])

export async function loadRelayConfig(env: NodeJS.ProcessEnv = process.env): Promise<RelayRuntimeConfig> {
    const configPath = optionalString(env.CODEVER_RELAY_CONFIG, 'CODEVER_RELAY_CONFIG')
    const configDirectory = configPath ? dirname(resolve(configPath)) : process.cwd()
    const json = configPath ? await readJsonObject(resolve(configPath), 'Relay config') : {}
    rejectUnknownKeys(json, CONFIG_KEYS, 'Relay config')

    const host = optionalString(env.CODEVER_RELAY_HOST, 'CODEVER_RELAY_HOST')
        ?? optionalString(json.host, 'host')
        ?? '127.0.0.1'
    const port = parsePort(env.CODEVER_RELAY_PORT ?? json.port ?? 8787)
    const relayId = optionalString(env.CODEVER_RELAY_ID, 'CODEVER_RELAY_ID')
        ?? optionalString(json.relayId, 'relayId')
        ?? 'codever-relay'
    const logger = parseBoolean(env.CODEVER_RELAY_LOGGER ?? json.logger ?? true, 'logger')
    const insecureDevAuth = env.CODEVER_RELAY_INSECURE_DEV_AUTH === 'true'
    const devWorkspaceId = optionalString(env.CODEVER_RELAY_DEV_WORKSPACE_ID, 'CODEVER_RELAY_DEV_WORKSPACE_ID')
        ?? 'development'
    const dataDirectoryValue = optionalString(env.CODEVER_RELAY_DATA_DIRECTORY, 'CODEVER_RELAY_DATA_DIRECTORY')
        ?? optionalString(json.dataDirectory, 'dataDirectory')
        ?? './data'
    const dataDirectory = resolveFrom(configDirectory, dataDirectoryValue)
    const repositoryMode = parseRepositoryMode(
        env.CODEVER_RELAY_REPOSITORY_MODE ?? json.repositoryMode ?? 'durable',
    )

    const tlsJson = json.tls === undefined ? undefined : requireObject(json.tls, 'tls')
    if (tlsJson) rejectUnknownKeys(tlsJson, new Set(['certFile', 'keyFile']), 'tls')
    const certFile = optionalString(env.CODEVER_RELAY_TLS_CERT_FILE, 'CODEVER_RELAY_TLS_CERT_FILE')
        ?? optionalString(tlsJson?.certFile, 'tls.certFile')
    const keyFile = optionalString(env.CODEVER_RELAY_TLS_KEY_FILE, 'CODEVER_RELAY_TLS_KEY_FILE')
        ?? optionalString(tlsJson?.keyFile, 'tls.keyFile')
    if (Boolean(certFile) !== Boolean(keyFile)) throw new Error('TLS requires both certFile and keyFile')
    const tls = certFile && keyFile
        ? await loadTls(resolveFrom(configDirectory, certFile), resolveFrom(configDirectory, keyFile))
        : undefined

    const enrollmentFile = optionalString(env.CODEVER_RELAY_ENROLLMENT_FILE, 'CODEVER_RELAY_ENROLLMENT_FILE')
        ?? optionalString(json.enrollmentFile, 'enrollmentFile')
    const inlineFromEnvironment = env.CODEVER_RELAY_GATEWAYS_JSON === undefined
        ? []
        : parseGatewayCollection(parseJsonText(env.CODEVER_RELAY_GATEWAYS_JSON, 'CODEVER_RELAY_GATEWAYS_JSON'), 'CODEVER_RELAY_GATEWAYS_JSON')
    const inlineFromConfig = json.gateways === undefined ? [] : parseGatewayCollection(json.gateways, 'gateways')
    const fromFile = enrollmentFile
        ? parseGatewayCollection(
            await readJson(resolveFrom(configDirectory, enrollmentFile), 'Gateway enrollment file'),
            'Gateway enrollment file',
        )
        : []
    const gateways = uniqueGateways([...fromFile, ...inlineFromConfig, ...inlineFromEnvironment])

    return {
        host,
        port,
        relayId,
        logger,
        ...(tls && { tls }),
        gateways,
        insecureDevAuth,
        devWorkspaceId,
        dataDirectory,
        repositoryMode,
    }
}

export class StaticEnrolledGatewayKeyRepository implements EnrolledGatewayKeyRepository {
    private readonly keys = new Map<string, EnrolledGatewayKey>()

    constructor(keys: EnrolledGatewayKey[]) {
        for (const key of keys) this.keys.set(`${key.gatewayId}\0${key.fingerprint}`, key)
    }

    async get(gatewayId: string, fingerprint: string): Promise<EnrolledGatewayKey | undefined> {
        return this.keys.get(`${gatewayId}\0${fingerprint}`)
    }
}

async function loadTls(certFile: string, keyFile: string): Promise<RelayTlsConfig> {
    const [cert, key] = await Promise.all([readFile(certFile), readFile(keyFile)])
    return { cert, key, certFile, keyFile }
}

async function readJsonObject(path: string, label: string): Promise<JsonRelayConfig> {
    return requireObject(await readJson(path, label), label)
}

async function readJson(path: string, label: string): Promise<unknown> {
    let text: string
    try {
        text = await readFile(path, 'utf8')
    } catch (error) {
        throw new Error(`Unable to read ${label} at ${path}`, { cause: error })
    }
    try {
        return JSON.parse(text)
    } catch (error) {
        throw new Error(`${label} at ${path} is not valid JSON`, { cause: error })
    }
}

function parseGatewayCollection(value: unknown, label: string): EnrolledGatewayKey[] {
    let collection: unknown
    if (Array.isArray(value)) {
        collection = value
    } else {
        const object = requireObject(value, label)
        for (const key of Object.keys(object)) {
            if (/private/i.test(key)) throw new Error(`${label} must never contain a Gateway private key`)
        }
        rejectUnknownKeys(object, new Set(['gateways']), label)
        collection = object.gateways
    }
    if (!Array.isArray(collection)) throw new Error(`${label} must be an array or an object with a gateways array`)
    return collection.map((entry, index) => parseGateway(entry, `${label}[${index}]`))
}

function parseJsonText(text: string, label: string): unknown {
    try {
        return JSON.parse(text)
    } catch (error) {
        throw new Error(`${label} is not valid JSON`, { cause: error })
    }
}

function parseGateway(value: unknown, label: string): EnrolledGatewayKey {
    const entry = requireObject(value, label)
    for (const key of Object.keys(entry)) {
        if (/private/i.test(key)) throw new Error(`${label} must never contain a Gateway private key`)
    }
    rejectUnknownKeys(entry, GATEWAY_KEYS, label)
    const gatewayId = requiredString(entry.gatewayId, `${label}.gatewayId`)
    const fingerprint = requiredString(entry.fingerprint, `${label}.fingerprint`)
    const publicKeySpkiPem = requiredString(entry.publicKeySpkiPem, `${label}.publicKeySpkiPem`)
    if (publicKeySpkiPem.includes('PRIVATE KEY')) throw new Error(`${label} must contain only a public SPKI PEM key`)
    const publicKey = createPublicKey(publicKeySpkiPem)
    if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
        throw new Error(`${label}.publicKeySpkiPem must be an EC P-256 public key`)
    }
    const actualFingerprint = `sha256:${createHash('sha256')
        .update(publicKey.export({ type: 'spki', format: 'der' }))
        .digest('base64url')}`
    if (fingerprint !== actualFingerprint) throw new Error(`${label}.fingerprint does not match its public key`)
    const enabled = entry.enabled === undefined ? true : parseBoolean(entry.enabled, `${label}.enabled`)
    return { gatewayId, fingerprint, publicKey: publicKeySpkiPem, enabled }
}

function uniqueGateways(keys: EnrolledGatewayKey[]): EnrolledGatewayKey[] {
    const result = new Map<string, EnrolledGatewayKey>()
    for (const key of keys) {
        const id = `${key.gatewayId}\0${key.fingerprint}`
        if (result.has(id)) throw new Error(`Duplicate enrolled Gateway key: ${key.gatewayId} / ${key.fingerprint}`)
        result.set(id, key)
    }
    return [...result.values()]
}

function resolveFrom(directory: string, path: string): string {
    return isAbsolute(path) ? path : resolve(directory, path)
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
    return value as Record<string, unknown>
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
    const unknown = Object.keys(value).filter(key => !allowed.has(key))
    if (unknown.length) throw new Error(`${label} contains unknown field(s): ${unknown.join(', ')}`)
}

function requiredString(value: unknown, label: string): string {
    const result = optionalString(value, label)
    if (!result) throw new Error(`${label} is required`)
    return result
}

function optionalString(value: unknown, label: string): string | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`)
    return value.trim()
}

function parseBoolean(value: unknown, label: string): boolean {
    if (value === true || value === 'true') return true
    if (value === false || value === 'false') return false
    throw new Error(`${label} must be true or false`)
}

function parsePort(value: unknown): number {
    const port = typeof value === 'number' ? value : Number(value)
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('Relay port must be an integer from 1 to 65535')
    return port
}

function parseRepositoryMode(value: unknown): 'durable' | 'memory' {
    if (value === 'durable' || value === 'memory') return value
    throw new Error('repositoryMode must be durable or memory')
}
