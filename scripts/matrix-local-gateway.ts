import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createClient } from 'matrix-js-sdk'
import {
    MatrixGatewayRunner,
    MatrixJsSdkGatewayClient,
    type MatrixGatewayConfig,
    type MatrixGatewayTrustedDevice,
} from '../src/gateway/matrix/index.js'
import { registerConfiguredProviders } from '../src/providers/configured.js'

interface LocalMatrixFixture {
    homeserver: string
    roomId: string
    gatewayId: string
    gateway: { userId: string }
}

interface LoginResult {
    user_id: string
    access_token: string
    device_id: string
}

const fixture = await readJson<LocalMatrixFixture>(
    join(process.cwd(), 'dev', 'matrix', 'local-test.json'),
)
assertLocalHomeserver(fixture.homeserver)
const pairingPath = process.env.CODEVER_MATRIX_PAIRING
    ?? join(process.cwd(), 'dev', 'matrix', 'pairing.json')
const trustedDevice = await readJson<MatrixGatewayTrustedDevice>(pairingPath)
if (!trustedDevice.allowedRoomIds.includes(fixture.roomId)) {
    throw new Error(`Pairing record does not allow local room ${fixture.roomId}`)
}

const registered = registerConfiguredProviders()
const providerName = process.env.CODEVER_PROVIDER
    ?? registered.defaultProvider
    ?? 'codex'
const cwd = process.env.CODEVER_CWD ?? process.cwd()
const runId = Date.now().toString(36).toUpperCase()
const login = await loginGateway(
    fixture.homeserver,
    `CODEVER_GATEWAY_${runId}`,
)
const sdkClient = createClient({
    baseUrl: fixture.homeserver,
    accessToken: login.access_token,
    userId: login.user_id,
    deviceId: login.device_id,
})
const config: MatrixGatewayConfig = {
    gatewayId: fixture.gatewayId,
    connection: {
        baseUrl: fixture.homeserver,
        accessToken: login.access_token,
        userId: login.user_id,
        deviceId: login.device_id,
        initialSyncTimeoutMs: 30_000,
    },
    crypto: {
        useIndexedDB: false,
        databasePrefix: `codever-local-gateway-${runId}`,
        allowInMemoryForTesting: true,
    },
    rooms: [{
        roomId: fixture.roomId,
        conversationId: fixture.roomId,
        cwd,
        providerName,
    }],
    trustedDevices: [trustedDevice],
    replayLedgerPath: join(
        process.cwd(),
        'dev',
        'matrix',
        'data',
        'gateway-replay.jsonl',
    ),
}
const runner = new MatrixGatewayRunner(config, {
    client: new MatrixJsSdkGatewayClient(
        sdkClient,
        config.connection.initialSyncTimeoutMs,
    ),
    onRejected: (event, error) => {
        const reason = error instanceof Error ? error.message : String(error)
        process.stderr.write(`[matrix-gateway] rejected ${event.eventId}: ${reason}\n`)
    },
})

await runner.start()
const ownKeys = await sdkClient.getCrypto()?.getOwnDeviceKeys()
if (!ownKeys) throw new Error('Gateway Matrix device keys are unavailable')

process.stdout.write('\nGateway is ready. Pin these exact values in the PWA settings:\n')
process.stdout.write(`${JSON.stringify({
    gatewayMatrixUserId: login.user_id,
    gatewayMatrixDeviceId: login.device_id,
    gatewayMatrixEd25519: ownKeys.ed25519,
}, null, 2)}\n\n`)
process.stdout.write(`Provider: ${providerName}\nWorking directory: ${cwd}\n`)
process.stdout.write('Press Ctrl+C to stop the Gateway.\n')

await new Promise<void>(resolve => {
    let stopping = false
    const stop = (): void => {
        if (stopping) return
        stopping = true
        void runner.stop().finally(resolve)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
})

async function readJson<T>(path: string): Promise<T> {
    try {
        const text = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '')
        return JSON.parse(text) as T
    } catch (error) {
        throw new Error(
            `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
        )
    }
}

async function loginGateway(
    homeserver: string,
    deviceId: string,
): Promise<LoginResult> {
    const requestBody = JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'gateway' },
        password: 'codever-gateway-local',
        device_id: deviceId,
        initial_device_display_name: `Codever local Gateway ${deviceId}`,
    })
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await fetch(`${homeserver}/_matrix/client/v3/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: requestBody,
        })
        if (response.ok) return response.json() as Promise<LoginResult>
        if (response.status !== 429 || attempt === 3) {
            throw new Error(`Gateway Matrix login failed: HTTP ${response.status}`)
        }
        const body = await response.json() as { retry_after_ms?: number }
        await new Promise(resolve =>
            setTimeout(resolve, Math.max(250, body.retry_after_ms ?? 1_000)),
        )
    }
    throw new Error('Gateway Matrix login failed')
}

function assertLocalHomeserver(homeserver: string): void {
    const url = new URL(homeserver)
    if (
        url.protocol !== 'http:'
        || (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')
    ) {
        throw new Error('This helper only accepts the disposable localhost Synapse fixture')
    }
}
