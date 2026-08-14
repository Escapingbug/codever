import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface MatrixGatewayLogin {
    user_id: string
    access_token: string
    device_id: string
}

interface PersistedMatrixGatewayLogin extends MatrixGatewayLogin {
    version: 1
    homeserver: string
    loginUser: string
}

export interface MatrixGatewayLoginOptions {
    homeserver: string
    loginUser: string
    deviceId: string
    deviceDisplayName?: string
    sessionPath: string
    readPassword(): Promise<string | undefined>
    fetch?: typeof fetch
    sleep?: (durationMs: number) => Promise<void>
    onLog?: (message: string) => void
}

/**
 * Reuses the Gateway's Matrix access token across supervisor restarts.
 *
 * Password login is deliberately the fallback, not the startup path. Besides
 * avoiding Synapse's strict login rate limit, this keeps a stable Matrix
 * device ID so an in-memory crypto transport can announce a key rotation
 * without manufacturing a new Matrix device on every process restart.
 */
export async function loadOrLoginMatrixGateway(
    options: MatrixGatewayLoginOptions,
): Promise<MatrixGatewayLogin> {
    const homeserver = normalizeHomeserver(options.homeserver)
    const fetchImpl = options.fetch ?? fetch
    const sleep = options.sleep ?? wait
    const persisted = await readPersistedLogin(options.sessionPath)
    if (persisted) {
        if (
            persisted.homeserver !== homeserver
            || persisted.loginUser !== options.loginUser
        ) {
            throw new Error(
                'Persisted Matrix Gateway login does not match the configured homeserver or user',
            )
        }
        if (await validatePersistedLogin(persisted, fetchImpl, sleep, options.onLog)) {
            options.onLog?.('Reusing the persisted Matrix Gateway login.')
            return publicLogin(persisted)
        }
        options.onLog?.('The persisted Matrix Gateway login expired; requesting a replacement.')
    }

    const password = await options.readPassword()
    if (!password) {
        throw new Error('A Matrix Gateway password is required when no reusable login is available')
    }
    const requestBody = JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: options.loginUser },
        password,
        device_id: options.deviceId,
        initial_device_display_name: options.deviceDisplayName ?? options.deviceId,
    })
    while (true) {
        const response = await fetchImpl(`${homeserver}/_matrix/client/v3/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: requestBody,
        })
        if (response.ok) {
            const login = validateLoginResponse(await response.json())
            const persistedLogin: PersistedMatrixGatewayLogin = {
                version: 1,
                homeserver,
                loginUser: options.loginUser,
                ...login,
            }
            await writePersistedLogin(options.sessionPath, persistedLogin)
            options.onLog?.('Persisted the Matrix Gateway login for supervisor restarts.')
            return login
        }
        if (response.status !== 429) {
            throw new Error(`Gateway Matrix login failed: HTTP ${response.status}`)
        }
        const retryAfterMs = await responseRetryAfterMs(response)
        options.onLog?.(`Matrix login rate limited; retrying in ${retryAfterMs}ms.`)
        await sleep(retryAfterMs)
    }
}

async function validatePersistedLogin(
    login: PersistedMatrixGatewayLogin,
    fetchImpl: typeof fetch,
    sleep: (durationMs: number) => Promise<void>,
    onLog: ((message: string) => void) | undefined,
): Promise<boolean> {
    while (true) {
        const response = await fetchImpl(
            `${login.homeserver}/_matrix/client/v3/account/whoami`,
            { headers: { authorization: `Bearer ${login.access_token}` } },
        )
        if (response.status === 401 || response.status === 403) return false
        if (response.status === 429) {
            const retryAfterMs = await responseRetryAfterMs(response)
            onLog?.(`Matrix session validation rate limited; retrying in ${retryAfterMs}ms.`)
            await sleep(retryAfterMs)
            continue
        }
        if (!response.ok) {
            throw new Error(`Matrix Gateway session validation failed: HTTP ${response.status}`)
        }
        const body = asRecord(await response.json())
        if (
            body?.user_id !== login.user_id
            || (
                body.device_id !== undefined
                && body.device_id !== login.device_id
            )
        ) {
            throw new Error('Matrix Gateway session validation returned a different identity')
        }
        return true
    }
}

async function readPersistedLogin(path: string): Promise<PersistedMatrixGatewayLogin | null> {
    let value: unknown
    try {
        value = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
        if (isMissingFile(error)) return null
        throw new Error(`Could not read persisted Matrix Gateway login: ${formatError(error)}`)
    }
    const record = asRecord(value)
    if (
        record?.version !== 1
        || typeof record.homeserver !== 'string'
        || typeof record.loginUser !== 'string'
        || typeof record.user_id !== 'string'
        || typeof record.access_token !== 'string'
        || typeof record.device_id !== 'string'
        || !record.homeserver
        || !record.loginUser
        || !record.user_id
        || !record.access_token
        || !record.device_id
    ) {
        throw new Error('Invalid persisted Matrix Gateway login')
    }
    return record as unknown as PersistedMatrixGatewayLogin
}

async function writePersistedLogin(
    path: string,
    login: PersistedMatrixGatewayLogin,
): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
        await handle.writeFile(`${JSON.stringify(login)}\n`, 'utf8')
        await handle.sync()
    } finally {
        await handle.close()
    }
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, path)
    await chmod(path, 0o600)
}

function validateLoginResponse(value: unknown): MatrixGatewayLogin {
    const record = asRecord(value)
    if (
        typeof record?.user_id !== 'string'
        || typeof record.access_token !== 'string'
        || typeof record.device_id !== 'string'
        || !record.user_id
        || !record.access_token
        || !record.device_id
    ) {
        throw new Error('Matrix Gateway login returned invalid credentials')
    }
    return {
        user_id: record.user_id,
        access_token: record.access_token,
        device_id: record.device_id,
    }
}

async function responseRetryAfterMs(response: Response): Promise<number> {
    const body = asRecord(await response.json().catch(() => null))
    const requested = body?.retry_after_ms
    if (typeof requested !== 'number' || !Number.isFinite(requested)) return 1_000
    return Math.min(300_000, Math.max(250, Math.ceil(requested)))
}

function publicLogin(login: PersistedMatrixGatewayLogin): MatrixGatewayLogin {
    return {
        user_id: login.user_id,
        access_token: login.access_token,
        device_id: login.device_id,
    }
}

function normalizeHomeserver(value: string): string {
    const url = new URL(value)
    return url.toString().replace(/\/$/u, '')
}

function wait(durationMs: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, durationMs))
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function isMissingFile(error: unknown): boolean {
    return asRecord(error)?.code === 'ENOENT'
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
