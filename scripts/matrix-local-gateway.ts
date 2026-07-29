import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createClient } from 'matrix-js-sdk'
import type { Logger } from 'matrix-js-sdk/lib/logger.js'
import QRCode from 'qrcode'
import { PairingOfferGuard } from '@codever/security'
import { FileReplayStore } from '@codever/security/node'
import {
    FileGatewayIdentityStore,
    FileTrustedDeviceRegistry,
    GatewayPairingService,
    listenForMatrixPairingRequests,
    announceMatrixDeviceRotation,
    pairingVerificationCode,
    trustedDeviceFromRecord,
    waitForMatrixPairing,
} from '../src/gateway/pairing/index.js'
import {
    MatrixGatewayRunner,
    MatrixJsSdkGatewayClient,
    type MatrixGatewayConfig,
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

const quietLogger: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn(message) {
        process.stderr.write(`[matrix] ${String(message)}\n`)
    },
    error(message) {
        process.stderr.write(`[matrix] ${String(message)}\n`)
    },
    getChild: () => quietLogger,
}

const fixture = await readJson<LocalMatrixFixture>(
    process.env.CODEVER_MATRIX_FIXTURE
        ?? join(process.cwd(), 'dev', 'matrix', 'local-test.json'),
)
assertAllowedHomeserver(fixture.homeserver)

const registered = registerConfiguredProviders()
const providerName = process.env.CODEVER_PROVIDER
    ?? registered.defaultProvider
    ?? 'codex'
const cwd = process.env.CODEVER_CWD ?? process.cwd()
const runId = Date.now().toString(36).toUpperCase()
const login = await loginGateway(fixture.homeserver, `CODEVER_GATEWAY_${runId}`)
const sdkClient = createClient({
    baseUrl: fixture.homeserver,
    accessToken: login.access_token,
    userId: login.user_id,
    deviceId: login.device_id,
    logger: quietLogger,
})
const client = new MatrixJsSdkGatewayClient(sdkClient, 30_000, message => {
    process.stderr.write(`${message}\n`)
})
const dataDirectory = process.env.CODEVER_MATRIX_DATA_DIR
    ?? join(process.cwd(), 'dev', 'matrix', 'gateway-data')
const identity = await new FileGatewayIdentityStore(
    join(dataDirectory, 'gateway-identity.json'),
).loadOrCreate(fixture.gatewayId)
const registry = new FileTrustedDeviceRegistry(
    join(dataDirectory, 'trusted-devices.json'),
)
const pairingService = new GatewayPairingService(
    identity,
    registry,
    new PairingOfferGuard(
        new FileReplayStore(join(dataDirectory, 'pairing-replay.json')),
    ),
)

await client.initializeCrypto({
    useIndexedDB: false,
    databasePrefix: `codever-local-gateway-${runId}`,
    allowInMemoryForTesting: true,
})
await client.start()
await client.waitUntilReady()
await client.assertRoomEncrypted(fixture.roomId)
const ownKeys = await sdkClient.getCrypto()?.getOwnDeviceKeys()
if (!ownKeys) throw new Error('Gateway Matrix device keys are unavailable')
const currentTransport = {
    homeserver: fixture.homeserver,
    roomId: fixture.roomId,
    userId: login.user_id,
    deviceId: login.device_id,
    ed25519: ownKeys.ed25519,
}

let active = await registry.listActive()
let acceptNewOffers = false
if (active.length === 0) {
    const created = await pairingService.createOffer({
        gatewayName: process.env.CODEVER_GATEWAY_NAME ?? 'Codever local Gateway',
        gatewayTransport: currentTransport,
    })
    const invitationCode = await pairingVerificationCode(
        created.signedOffer.offer.offerId,
        created.signedOffer.offer.challenge,
        created.signedOffer.offer.gatewayKey.keyId,
    )
    process.stdout.write('\nPair this Gateway from Codever:\n\n')
    process.stdout.write(await QRCode.toString(created.link, {
        type: 'terminal',
        small: true,
        errorCorrectionLevel: 'L',
    }))
    process.stdout.write(`\nInvitation code: ${formatCode(invitationCode)}\n`)
    process.stdout.write(`Pairing link (paste fallback):\n${created.link}\n\n`)
    process.stdout.write('Waiting for one encrypted pairing request…\n')
    const paired = await waitForMatrixPairing({
        client,
        service: pairingService,
        registry,
        gatewayTransport: currentTransport,
        timeoutMs: Math.max(1, created.signedOffer.offer.expiresAt - Date.now()),
        onRejected: error => {
            process.stderr.write(`[matrix-pairing] rejected: ${formatError(error)}\n`)
        },
    })
    process.stdout.write(
        `Paired ${paired.certificate.certificate.deviceName}. Starting the agent…\n`,
    )
    active = await registry.listActive()
} else {
    const rotated = await announceMatrixDeviceRotation({
        client,
        service: pairingService,
        registry,
        nextTransport: currentTransport,
        trustedDevices: active,
    })
    if (rotated) {
        process.stdout.write('Gateway Matrix transport key rotated and signed automatically.\n')
    }
    if (process.env.CODEVER_PAIR_NEW_DEVICE === '1') {
        const created = await pairingService.createOffer({
            gatewayName: process.env.CODEVER_GATEWAY_NAME ?? 'Codever local Gateway',
            gatewayTransport: currentTransport,
        })
        const invitationCode = await pairingVerificationCode(
            created.signedOffer.offer.offerId,
            created.signedOffer.offer.challenge,
            created.signedOffer.offer.gatewayKey.keyId,
        )
        process.stdout.write('\nAdd another Codever device:\n\n')
        process.stdout.write(await QRCode.toString(created.link, {
            type: 'terminal',
            small: true,
            errorCorrectionLevel: 'L',
        }))
        process.stdout.write(`\nInvitation code: ${formatCode(invitationCode)}\n`)
        process.stdout.write(`Pairing link (paste fallback):\n${created.link}\n\n`)
        acceptNewOffers = true
    }
}

const trustedDevices = active.map(trustedDeviceFromRecord)
let runner: MatrixGatewayRunner | null = null
const stopPairingRecovery = listenForMatrixPairingRequests({
    client,
    service: pairingService,
    registry,
    gatewayTransport: currentTransport,
    acceptNewOffers,
    onAccepted: async record => {
        process.stdout.write(`Device ${record.certificate.certificate.deviceName} is now active.\n`)
        await runner?.syncState()
    },
    onRejected: error => {
        process.stderr.write(`[matrix-pairing-recovery] rejected: ${formatError(error)}\n`)
    },
})
const config: MatrixGatewayConfig = {
    gatewayId: identity.gatewayId,
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
    trustedDevices,
    replayLedgerPath: join(dataDirectory, 'gateway-replay.jsonl'),
    applicationSecurity: {
        gatewayDeviceId: identity.gatewayId,
        gatewayKeyPair: identity.serialized,
        envelopeReplayLedgerPath: join(dataDirectory, 'envelope-replay.json'),
    },
}
runner = new MatrixGatewayRunner(config, {
    client,
    listTrustedDevices: async () =>
        (await registry.listActive()).map(trustedDeviceFromRecord),
    isTrustedDeviceActive: async deviceId =>
        (await registry.get(deviceId))?.status === 'active',
    onRejected: (event, error) => {
        process.stderr.write(
            `[matrix-gateway] rejected ${event.eventId}: ${formatError(error)}\n`,
        )
    },
})

await runner.start()
process.stdout.write(`Gateway ready with ${trustedDevices.length} trusted device(s).\n`)
process.stdout.write(`Provider: ${providerName}\nWorking directory: ${cwd}\n`)
process.stdout.write('Press Ctrl+C to stop the Gateway.\n')

await new Promise<void>(resolve => {
    let stopping = false
    const stop = (): void => {
        if (stopping) return
        stopping = true
        void runner!.stop().finally(resolve)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
})
stopPairingRecovery()

async function readJson<T>(path: string): Promise<T> {
    try {
        const text = (await readFile(path, 'utf8')).replace(/^\uFEFF/u, '')
        return JSON.parse(text) as T
    } catch (error) {
        throw new Error(`Could not read ${path}: ${formatError(error)}`)
    }
}

async function loginGateway(
    homeserver: string,
    deviceId: string,
): Promise<LoginResult> {
    const user = process.env.CODEVER_MATRIX_GATEWAY_USER ?? 'gateway'
    const password = process.env.CODEVER_MATRIX_GATEWAY_PASSWORD
        ?? (isLoopbackHomeserver(homeserver) ? 'codever-gateway-local' : undefined)
    if (!password) {
        throw new Error(
            'CODEVER_MATRIX_GATEWAY_PASSWORD is required for a non-local Matrix homeserver',
        )
    }
    const requestBody = JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password,
        device_id: deviceId,
        initial_device_display_name: `${
            process.env.CODEVER_GATEWAY_NAME ?? 'Codever local Gateway'
        } ${deviceId}`,
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

function assertAllowedHomeserver(homeserver: string): void {
    const url = new URL(homeserver)
    if (isLoopbackHomeserver(homeserver)) return
    if (url.protocol !== 'https:') {
        throw new Error('A non-local Matrix homeserver must use HTTPS')
    }
}

function isLoopbackHomeserver(homeserver: string): boolean {
    const url = new URL(homeserver)
    return url.protocol === 'http:'
        && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
}

function formatCode(code: string): string {
    return code.replace(/(\d{3})(\d{3})/u, '$1 $2')
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
