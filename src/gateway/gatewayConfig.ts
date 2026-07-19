import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { MatrixSessionCredential } from './matrix'

export interface GatewayMatrixConfig {
    homeserver: string
    userId: string
    deviceId: string
    controlRoomId: string
    credentialPath: string
    storePath: string
    transportBinaryPath: string
}

export interface GatewayConfig {
    version: 2
    gatewayId: string
    workspaceId: string
    name: string
    dataDirectory: string
    providersPath?: string
    matrix: GatewayMatrixConfig
}

interface MatrixCredentialSnapshot {
    version: 1
    accessToken: string
    refreshToken?: string
    storePassphrase: string
}

export function defaultGatewayConfigPath(): string {
    return join(homedir(), '.config', 'codever', 'gateway.json')
}

export async function loadGatewayConfig(path = defaultGatewayConfigPath()): Promise<GatewayConfig> {
    try {
        return parseGatewayConfig(JSON.parse(await readFile(resolve(path), 'utf8')))
    } catch (error) {
        throw new Error(`Unable to read Gateway config at ${resolve(path)}`, { cause: error })
    }
}

export async function writeGatewayConfig(
    input: Pick<GatewayConfig, 'name' | 'matrix'> & Partial<GatewayConfig>,
    path = defaultGatewayConfigPath(),
): Promise<GatewayConfig> {
    const target = resolve(path)
    const config = parseGatewayConfig({
        version: 2,
        gatewayId: input.gatewayId ?? `gateway_${randomUUID()}`,
        workspaceId: input.workspaceId ?? 'default',
        name: input.name,
        dataDirectory: input.dataDirectory ?? join(dirname(target), 'gateway-data'),
        ...(input.providersPath ? { providersPath: input.providersPath } : {}),
        matrix: input.matrix,
    })
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(target, 0o600)
    return config
}

export async function writeMatrixCredential(
    path: string,
    input: Pick<MatrixCredentialSnapshot, 'accessToken' | 'storePassphrase'> & Partial<MatrixCredentialSnapshot>,
): Promise<void> {
    const snapshot = parseMatrixCredential({
        version: 1,
        accessToken: input.accessToken,
        ...(input.refreshToken ? { refreshToken: input.refreshToken } : {}),
        storePassphrase: input.storePassphrase,
    })
    const target = resolve(path)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(target, 0o600)
}

export async function loadMatrixCredential(config: GatewayConfig): Promise<{
    session: MatrixSessionCredential
    storePassphrase: string
}> {
    let snapshot: MatrixCredentialSnapshot
    try {
        snapshot = parseMatrixCredential(JSON.parse(await readFile(config.matrix.credentialPath, 'utf8')))
        await chmod(config.matrix.credentialPath, 0o600)
    } catch (error) {
        throw new Error(`Unable to read Matrix credential at ${config.matrix.credentialPath}`, { cause: error })
    }
    return {
        session: {
            homeserver: config.matrix.homeserver,
            userId: config.matrix.userId,
            deviceId: config.matrix.deviceId,
            accessToken: snapshot.accessToken,
            ...(snapshot.refreshToken ? { refreshToken: snapshot.refreshToken } : {}),
        },
        storePassphrase: snapshot.storePassphrase,
    }
}

export function parseGatewayConfig(value: unknown): GatewayConfig {
    if (!isRecord(value) || value.version !== 2) throw new Error('Gateway config version must be 2')
    const matrix = parseMatrix(value.matrix)
    return {
        version: 2,
        gatewayId: text(value.gatewayId, 'gatewayId'),
        workspaceId: text(value.workspaceId, 'workspaceId'),
        name: text(value.name, 'name'),
        dataDirectory: absolute(value.dataDirectory, 'dataDirectory'),
        ...(value.providersPath === undefined ? {} : { providersPath: absolute(value.providersPath, 'providersPath') }),
        matrix,
    }
}

function parseMatrix(value: unknown): GatewayMatrixConfig {
    if (!isRecord(value)) throw new Error('matrix configuration is required')
    const homeserver = new URL(text(value.homeserver, 'matrix.homeserver'))
    if (homeserver.protocol !== 'https:' && !(homeserver.protocol === 'http:' && isLoopback(homeserver.hostname))) {
        throw new Error('Matrix homeserver must use https except on loopback')
    }
    const userId = text(value.userId, 'matrix.userId')
    const deviceId = text(value.deviceId, 'matrix.deviceId')
    const controlRoomId = text(value.controlRoomId, 'matrix.controlRoomId')
    if (!/^@[^:]+:.+$/.test(userId)) throw new Error('matrix.userId is invalid')
    if (!/^![^:]+:.+$/.test(controlRoomId)) throw new Error('matrix.controlRoomId is invalid')
    return {
        homeserver: homeserver.toString(),
        userId,
        deviceId,
        controlRoomId,
        credentialPath: absolute(value.credentialPath, 'matrix.credentialPath'),
        storePath: absolute(value.storePath, 'matrix.storePath'),
        transportBinaryPath: absolute(value.transportBinaryPath, 'matrix.transportBinaryPath'),
    }
}

function parseMatrixCredential(value: unknown): MatrixCredentialSnapshot {
    if (!isRecord(value) || value.version !== 1) throw new Error('Matrix credential version must be 1')
    return {
        version: 1,
        accessToken: text(value.accessToken, 'accessToken'),
        ...(value.refreshToken === undefined ? {} : { refreshToken: text(value.refreshToken, 'refreshToken') }),
        storePassphrase: text(value.storePassphrase, 'storePassphrase'),
    }
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
