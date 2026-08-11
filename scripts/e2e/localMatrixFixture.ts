import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface MatrixLoginFixture {
    username: string
    password: string
    userId: string
    deviceId: string
    accessToken: string
}

export interface DisposableMatrixFixture {
    homeserver: string
    roomId: string
    gatewayId: string
    tester: MatrixLoginFixture
    gateway: MatrixLoginFixture
}

type LoginResponse = {
    user_id: string
    device_id: string
    access_token: string
}

/**
 * Starts the official local Synapse container and creates isolated accounts
 * and an encrypted room for one business-E2E run.
 */
export async function createDisposableMatrixFixture(
    repositoryRoot: string,
): Promise<DisposableMatrixFixture> {
    const matrixDirectory = join(repositoryRoot, 'dev', 'matrix')
    const composeFile = join(matrixDirectory, 'docker-compose.yml')
    const dataDirectory = join(matrixDirectory, 'data')
    const homeserverConfig = join(dataDirectory, 'homeserver.yaml')
    const homeserver = 'http://127.0.0.1:8008'

    await ensureSynapse({
        matrixDirectory,
        composeFile,
        dataDirectory,
        homeserverConfig,
        homeserver,
    })

    const suffix = randomUUID().replaceAll('-', '').slice(0, 12).toLowerCase()
    const testerUsername = `codever_e2e_t_${suffix}`
    const gatewayUsername = `codever_e2e_g_${suffix}`
    const testerPassword = `codever-e2e-tester-${suffix}`
    const gatewayPassword = `codever-e2e-gateway-${suffix}`

    await registerUser(testerUsername, testerPassword)
    await registerUser(gatewayUsername, gatewayPassword)

    const testerLogin = await login(
        homeserver,
        testerUsername,
        testerPassword,
        `CODEVER_WEB_E2E_${suffix.toUpperCase()}`,
    )
    const gatewayLogin = await login(
        homeserver,
        gatewayUsername,
        gatewayPassword,
        `CODEVER_GATEWAY_E2E_${suffix.toUpperCase()}`,
    )
    const room = await matrixRequest<{ room_id: string }>(
        homeserver,
        '/_matrix/client/v3/createRoom',
        testerLogin.access_token,
        {
            visibility: 'private',
            preset: 'trusted_private_chat',
            name: `Codever business E2E ${suffix}`,
            is_direct: true,
            invite: [gatewayLogin.user_id],
            initial_state: [{
                type: 'm.room.encryption',
                state_key: '',
                content: { algorithm: 'm.megolm.v1.aes-sha2' },
            }],
        },
    )
    await matrixRequest(
        homeserver,
        `/_matrix/client/v3/rooms/${encodeURIComponent(room.room_id)}/join`,
        gatewayLogin.access_token,
        {},
    )

    return {
        homeserver,
        roomId: room.room_id,
        gatewayId: `codever-e2e-gateway-${suffix}`,
        tester: {
            username: testerUsername,
            password: testerPassword,
            userId: testerLogin.user_id,
            deviceId: testerLogin.device_id,
            accessToken: testerLogin.access_token,
        },
        gateway: {
            username: gatewayUsername,
            password: gatewayPassword,
            userId: gatewayLogin.user_id,
            deviceId: gatewayLogin.device_id,
            accessToken: gatewayLogin.access_token,
        },
    }
}

async function ensureSynapse(input: {
    matrixDirectory: string
    composeFile: string
    dataDirectory: string
    homeserverConfig: string
    homeserver: string
}): Promise<void> {
    const compose = [
        'compose',
        '--project-directory',
        input.matrixDirectory,
        '-f',
        input.composeFile,
    ]
    await mkdir(input.dataDirectory, { recursive: true })
    let configExists = true
    try {
        await readFile(input.homeserverConfig, 'utf8')
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        configExists = false
    }
    if (!configExists) {
        await docker([...compose, 'run', '--rm', 'synapse', 'generate'])
    }

    const config = await readFile(input.homeserverConfig, 'utf8')
    let configChanged = false
    if (!config.includes('# codever-local-test-rate-limits')) {
        await appendFile(
            input.homeserverConfig,
            [
                '',
                '# codever-local-test-rate-limits',
                '# Disposable localhost fixture only. Unsafe for a public server.',
                'rc_login:',
                '  address:',
                '    per_second: 100',
                '    burst_count: 1000',
                '  account:',
                '    per_second: 100',
                '    burst_count: 1000',
                '  failed_attempts:',
                '    per_second: 100',
                '    burst_count: 1000',
                '',
            ].join('\n'),
            'utf8',
        )
        configChanged = true
    }
    if (!config.includes('# codever-local-test-message-rate-limit')) {
        await appendFile(
            input.homeserverConfig,
            [
                '',
                '# codever-local-test-message-rate-limit',
                '# Keep business E2E deterministic; public-server throttling is tested separately.',
                'rc_message:',
                '  per_second: 100',
                '  burst_count: 1000',
                '',
            ].join('\n'),
            'utf8',
        )
        configChanged = true
    }

    await docker([...compose, 'up', '-d', 'synapse'])
    if (configChanged) await docker([...compose, 'restart', 'synapse'])
    const deadline = Date.now() + 120_000
    let lastError = 'Synapse did not answer'
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${input.homeserver}/_matrix/client/versions`)
            if (response.ok) return
            lastError = `HTTP ${response.status}`
        } catch (error) {
            lastError = formatError(error)
        }
        await delay(1_000)
    }
    throw new Error(`Local Synapse did not become ready: ${lastError}`)
}

async function registerUser(username: string, password: string): Promise<void> {
    await docker([
        'exec',
        'codever-matrix-local',
        'register_new_matrix_user',
        'http://localhost:8008',
        '-c',
        '/data/homeserver.yaml',
        '--no-admin',
        '-u',
        username,
        '-p',
        password,
    ])
}

async function login(
    homeserver: string,
    username: string,
    password: string,
    deviceId: string,
): Promise<LoginResponse> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await fetch(`${homeserver}/_matrix/client/v3/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                type: 'm.login.password',
                identifier: { type: 'm.id.user', user: username },
                password,
                device_id: deviceId,
                initial_device_display_name: `Codever business E2E ${deviceId}`,
            }),
        })
        if (response.ok) return response.json() as Promise<LoginResponse>
        const body = await response.json().catch(() => ({})) as {
            retry_after_ms?: number
            error?: string
        }
        if (response.status !== 429 || attempt === 4) {
            throw new Error(
                `Matrix login failed for ${username}: HTTP ${response.status} ${body.error ?? ''}`.trim(),
            )
        }
        await delay(Math.max(250, body.retry_after_ms ?? 1_000))
    }
    throw new Error(`Matrix login failed for ${username}`)
}

async function matrixRequest<T = Record<string, unknown>>(
    homeserver: string,
    path: string,
    accessToken: string,
    body: unknown,
): Promise<T> {
    const response = await fetch(`${homeserver}${path}`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
    })
    if (!response.ok) {
        throw new Error(`Matrix request ${path} failed with HTTP ${response.status}`)
    }
    return response.json() as Promise<T>
}

async function docker(args: string[]): Promise<void> {
    try {
        await execFileAsync('docker', args, {
            encoding: 'utf8',
            maxBuffer: 8 * 1024 * 1024,
        })
    } catch (error) {
        const candidate = error as Error & { stdout?: string; stderr?: string }
        throw new Error(
            `Docker command failed: docker ${args.join(' ')}\n${candidate.stderr ?? candidate.stdout ?? candidate.message}`,
            { cause: error },
        )
    }
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds))
}
