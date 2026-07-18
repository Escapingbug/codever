import { dirname, isAbsolute, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'

export interface RelayRuntimeConfig {
    host: string
    port: number
    relayId: string
    logger: boolean
    dataDirectory: string
    natsUrl: string
    natsGatewayUrl: string
    natsWebSocketUrl: string
    natsCredentialsFile?: string
    nscExecutable: string
    nscConfigDirectory: string
    nscStoreDirectory: string
    nscKeysDirectory: string
    nscOperator: string
    nscAccount: string
}

const CONFIG_KEYS = new Set([
    'host', 'port', 'relayId', 'logger', 'dataDirectory', 'natsUrl', 'natsGatewayUrl',
    'natsWebSocketUrl', 'natsCredentialsFile', 'nscExecutable', 'nscConfigDirectory', 'nscStoreDirectory', 'nscKeysDirectory',
    'nscOperator', 'nscAccount',
])
const REMOVED_ENVIRONMENT_KEYS = [
    'CODEVER_RELAY_ENROLLMENT_FILE',
    'CODEVER_RELAY_GATEWAYS_JSON',
    'CODEVER_RELAY_INSECURE_DEV_AUTH',
    'CODEVER_RELAY_DEV_WORKSPACE_ID',
    'CODEVER_RELAY_USERS_FILE',
    'CODEVER_RELAY_USERS_JSON',
    'CODEVER_RELAY_SESSION_TTL_SECONDS',
    'CODEVER_RELAY_TLS_CERT_FILE',
    'CODEVER_RELAY_TLS_KEY_FILE',
]

export async function loadRelayConfig(env: NodeJS.ProcessEnv = process.env): Promise<RelayRuntimeConfig> {
    const removed = REMOVED_ENVIRONMENT_KEYS.filter(key => env[key] !== undefined)
    if (removed.length) throw new Error(`Removed Relay configuration: ${removed.join(', ')}`)
    const configPath = optionalString(env.CODEVER_RELAY_CONFIG, 'CODEVER_RELAY_CONFIG')
    const configDirectory = configPath ? dirname(resolve(configPath)) : process.cwd()
    const json = configPath ? requireObject(await readJson(resolve(configPath), 'Relay config'), 'Relay config') : {}
    rejectUnknownKeys(json, CONFIG_KEYS, 'Relay config')

    const dataDirectoryValue = optionalString(env.CODEVER_RELAY_DATA_DIRECTORY, 'CODEVER_RELAY_DATA_DIRECTORY')
        ?? optionalString(json.dataDirectory, 'dataDirectory') ?? './data'
    const dataDirectory = resolveFrom(configDirectory, dataDirectoryValue)
    const natsUrl = parseNatsUrl(env.CODEVER_RELAY_NATS_URL ?? json.natsUrl ?? 'nats://127.0.0.1:4222')
    return {
        host: optionalString(env.CODEVER_RELAY_HOST, 'CODEVER_RELAY_HOST') ?? optionalString(json.host, 'host') ?? '127.0.0.1',
        port: parsePort(env.CODEVER_RELAY_PORT ?? json.port ?? 8787),
        relayId: optionalString(env.CODEVER_RELAY_ID, 'CODEVER_RELAY_ID') ?? optionalString(json.relayId, 'relayId') ?? 'codever-relay',
        logger: parseBoolean(env.CODEVER_RELAY_LOGGER ?? json.logger ?? true, 'logger'),
        dataDirectory,
        natsUrl,
        natsGatewayUrl: parseNatsUrl(env.CODEVER_RELAY_NATS_GATEWAY_URL ?? json.natsGatewayUrl ?? natsUrl),
        natsWebSocketUrl: parseNatsWebSocketUrl(
            env.CODEVER_RELAY_NATS_WEBSOCKET_URL ?? json.natsWebSocketUrl ?? 'ws://127.0.0.1:8080',
        ),
        natsCredentialsFile: resolveOptionalPath(configDirectory,
            optionalString(env.CODEVER_RELAY_NATS_CREDENTIALS_FILE ?? json.natsCredentialsFile, 'natsCredentialsFile')),
        nscExecutable: optionalString(env.CODEVER_RELAY_NSC_EXECUTABLE ?? json.nscExecutable, 'nscExecutable') ?? 'nsc',
        nscConfigDirectory: resolveFrom(configDirectory,
            optionalString(env.CODEVER_RELAY_NSC_CONFIG_DIRECTORY ?? json.nscConfigDirectory, 'nscConfigDirectory')
                ?? resolve(dataDirectory, 'nsc-config')),
        nscStoreDirectory: resolveFrom(configDirectory,
            optionalString(env.CODEVER_RELAY_NSC_STORE_DIRECTORY ?? json.nscStoreDirectory, 'nscStoreDirectory')
                ?? resolve(dataDirectory, 'nsc-store')),
        nscKeysDirectory: resolveFrom(configDirectory,
            optionalString(env.CODEVER_RELAY_NSC_KEYS_DIRECTORY ?? json.nscKeysDirectory, 'nscKeysDirectory')
                ?? resolve(dataDirectory, 'nsc-keys')),
        nscOperator: optionalString(env.CODEVER_RELAY_NSC_OPERATOR ?? json.nscOperator, 'nscOperator') ?? 'CODEVER',
        nscAccount: optionalString(env.CODEVER_RELAY_NSC_ACCOUNT ?? json.nscAccount, 'nscAccount') ?? 'CODEVER',
    }
}

async function readJson(path: string, label: string): Promise<unknown> {
    try {
        return JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
        throw new Error(`Unable to read valid ${label} at ${path}`, { cause: error })
    }
}

function resolveFrom(directory: string, path: string): string { return isAbsolute(path) ? path : resolve(directory, path) }
function resolveOptionalPath(directory: string, path: string | undefined): string | undefined {
    return path === undefined ? undefined : resolveFrom(directory, path)
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
    return value as Record<string, unknown>
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
    const unknown = Object.keys(value).filter(key => !allowed.has(key))
    if (unknown.length) throw new Error(`${label} contains unknown field(s): ${unknown.join(', ')}`)
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

function parseNatsUrl(value: unknown): string {
    const url = new URL(optionalString(value, 'natsUrl')!)
    if (url.protocol !== 'nats:' && url.protocol !== 'tls:') throw new Error('natsUrl must use nats:// or tls://')
    return url.toString()
}

function parseNatsWebSocketUrl(value: unknown): string {
    const url = new URL(optionalString(value, 'natsWebSocketUrl')!)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('natsWebSocketUrl must use ws:// or wss://')
    return url.toString()
}
