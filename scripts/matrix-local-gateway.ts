import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createClient } from 'matrix-js-sdk'
import type { Logger } from 'matrix-js-sdk/lib/logger.js'
import QRCode from 'qrcode'
import { PairingOfferGuard } from '@codever/security'
import { FileReplayStore } from '@codever/security/node'
import {
    FileGatewayIdentityStore,
    FileTrustedDeviceRegistry,
    DeviceInvitationCoordinator,
    GatewayPairingService,
    listenForMatrixPairingRequests,
    announceMatrixDeviceRotation,
    publishMatrixTransportSnapshot,
    pairingVerificationCode,
    trustedDeviceFromRecord,
} from '../src/gateway/pairing/index.js'
import {
    FileMatrixLoginTokenIssuer,
    startGatewayAdminServer,
} from '../src/gateway/admin/index.js'
import {
    MatrixGatewayRunner,
    MatrixJsSdkGatewayClient,
    watchMatrixSyncHealth,
    type MatrixGatewayConfig,
} from '../src/gateway/matrix/index.js'
import { registerConfiguredProviders } from '../src/providers/configured.js'
import type {
    AgentProvider,
    AgentQueryHandle,
    AgentQueryInput,
} from '../src/providers/provider.js'
import { createSessionExtensionRegistryFromEnvironment } from '../src/runtime/sessionExtensionConfig.js'

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
const deterministicE2eProvider = process.env.CODEVER_MATRIX_E2E_PROVIDER === '1'
if (deterministicE2eProvider && !isLoopbackHomeserver(fixture.homeserver)) {
    throw new Error('CODEVER_MATRIX_E2E_PROVIDER is allowed only with a loopback homeserver')
}
const providerName = deterministicE2eProvider
    ? 'codex'
    : process.env.CODEVER_PROVIDER
        ?? registered.defaultProvider
        ?? 'codex'
const cwd = process.env.CODEVER_CWD ?? process.cwd()
const sessionExtensionRegistry = createSessionExtensionRegistryFromEnvironment()
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
const pwaLoginPath = process.env.CODEVER_PWA_LOGIN_FILE
    ?? join(dirname(dataDirectory), 'pwa-login.json')
const invitationCoordinator = new DeviceInvitationCoordinator(
    pairingService,
    registry,
    {
        gatewayName: process.env.CODEVER_GATEWAY_NAME ?? 'Codever local Gateway',
        gatewayTransport: () => currentTransport,
        matrixLoginTokenIssuer: new FileMatrixLoginTokenIssuer({
            credentialsPath: pwaLoginPath,
        }),
        onAudit: event => {
            if (event.action === 'created') {
                process.stdout.write(
                    `Created ${event.source.kind} pairing invitation `
                    + `${event.invitationId ?? '(unknown)'}.\n`,
                )
                return
            }
            process.stderr.write(
                `[device-invitation] ${event.source.kind} failed: `
                + `${event.errorCode ?? 'unknown'}\n`,
            )
        },
    },
)

const active = await registry.listActive()
let startupPairing: {
    link: string
    expiresAt: number
    verificationCode: string
} | null = null
if (active.length === 0) {
    const created = await pairingService.createOffer({
        gatewayName: process.env.CODEVER_GATEWAY_NAME ?? 'Codever local Gateway',
        gatewayTransport: currentTransport,
        source: { kind: 'gateway-startup' },
    })
    const invitationCode = await pairingVerificationCode(
        created.signedOffer.offer.offerId,
        created.signedOffer.offer.challenge,
        created.signedOffer.offer.gatewayKey.keyId,
    )
    startupPairing = {
        link: created.link,
        expiresAt: created.signedOffer.offer.expiresAt,
        verificationCode: invitationCode,
    }
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
    await publishMatrixTransportSnapshot({
        client,
        service: pairingService,
        registry,
        transport: currentTransport,
    })
    process.stdout.write('Published the durable Gateway profile recovery snapshot.\n')
    if (process.env.CODEVER_PAIR_NEW_DEVICE === '1') {
        const created = await invitationCoordinator.create({
            source: { kind: 'gateway-startup' },
            matrixLogin: 'disabled',
        })
        process.stdout.write('\nAdd another Codever device:\n\n')
        process.stdout.write(await QRCode.toString(created.invitationLink, {
            type: 'terminal',
            small: true,
            errorCorrectionLevel: 'L',
        }))
        process.stdout.write(
            `\nInvitation code: ${formatCode(created.verificationCode)}\n`,
        )
        process.stdout.write(
            `Pairing link (paste fallback):\n${created.pairingLink}\n\n`,
        )
    }
}

const trustedDevices = active.map(trustedDeviceFromRecord)
let runner: MatrixGatewayRunner | null = null
const stopPairingRecovery = listenForMatrixPairingRequests({
    client,
    service: pairingService,
    registry,
    gatewayTransport: currentTransport,
    // Only offers persisted by GatewayPairingService can be accepted, so the
    // listener can remain available for invitations created by an active PWA.
    acceptNewOffers: true,
    onProvisioned: async () => {
        if (!runner || runner.getState() !== 'running') {
            throw new Error('Gateway Room State is not ready for pairing')
        }
        await runner.provisionCurrentState()
    },
    onAccepted: async record => {
        process.stdout.write(`Device ${record.certificate.certificate.deviceName} is now active.\n`)
        process.stdout.write(
            `Gateway ready with ${(await registry.listActive()).length} trusted device(s).\n`,
        )
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
    sessionExtensionRegistry,
    ...(deterministicE2eProvider
        ? { providerFactory: () => e2eProvider(providerName) }
        : {}),
    listTrustedDevices: async () =>
        (await registry.listActive()).map(trustedDeviceFromRecord),
    isTrustedDeviceActive: async deviceId =>
        (await registry.get(deviceId))?.status === 'active',
    createDeviceInvitation: async ({ requestedByDeviceId, commandId, lifetimeMs }) => {
        const created = await invitationCoordinator.create({
            source: {
                kind: 'paired-device',
                deviceId: requestedByDeviceId,
                commandId,
            },
            matrixLogin: 'disabled',
            ...(lifetimeMs === undefined ? {} : { lifetimeMs }),
        })
        process.stdout.write(
            `Device ${requestedByDeviceId} authorized a new pairing invitation.\n`,
        )
        return {
            pairingLink: created.pairingLink,
            expiresAt: created.expiresAt,
        }
    },
    onRejected: (event, error) => {
        process.stderr.write(
            `[matrix-gateway] rejected ${event.eventId}: ${formatError(error)}\n`,
        )
    },
    ...(deterministicE2eProvider
        ? { onLog: (message: string) => process.stderr.write(`${message}\n`) }
        : {}),
})

await runner.start()
const adminServer = await startGatewayAdminServer({
    socketPath: process.env.CODEVER_GATEWAY_ADMIN_SOCKET
        ?? join(dataDirectory, 'admin.sock'),
    gatewayId: identity.gatewayId,
    coordinator: invitationCoordinator,
    pairingService,
    registry,
    getGatewayState: () => runner?.getState() ?? 'starting',
    syncGatewayState: async () => {
        await runner?.syncState()
    },
    onLog: message => process.stdout.write(`${message}\n`),
})
process.stdout.write(`Gateway ready with ${trustedDevices.length} trusted device(s).\n`)
if (startupPairing) {
    process.stdout.write('\nPair this Gateway from Codever:\n\n')
    process.stdout.write(await QRCode.toString(startupPairing.link, {
        type: 'terminal',
        small: true,
        errorCorrectionLevel: 'L',
    }))
    process.stdout.write(`\nInvitation code: ${formatCode(startupPairing.verificationCode)}\n`)
    process.stdout.write(`Pairing link (paste fallback):\n${startupPairing.link}\n\n`)
    process.stdout.write(
        `Waiting for one encrypted pairing request until ${startupPairing.expiresAt}. `
        + 'Gateway will commit current Room State before accepting it.\n',
    )
}
process.stdout.write(`Provider: ${providerName}\nWorking directory: ${cwd}\n`)
if (sessionExtensionRegistry.descriptors().length > 0) {
    process.stdout.write(
        `Session extensions: ${sessionExtensionRegistry.descriptors().map(item => item.name).join(', ')}\n`,
    )
}
process.stdout.write(`Gateway admin socket: ${adminServer.socketPath}\n`)
process.stdout.write('Press Ctrl+C to stop the Gateway.\n')

const syncStallTimeoutMs = positiveDurationFromEnvironment(
    'CODEVER_MATRIX_SYNC_STALL_TIMEOUT_MS',
    120_000,
)
const shutdownTimeoutMs = positiveDurationFromEnvironment(
    'CODEVER_MATRIX_SHUTDOWN_TIMEOUT_MS',
    10_000,
)
let requestStop: (failure?: Error) => void = () => undefined
const stopped = new Promise<{ failure: Error | null; forced: boolean }>(resolve => {
    let stopping = false
    requestStop = (failure?: Error): void => {
        if (stopping) return
        stopping = true
        const shutdown = adminServer.stop()
            .catch(error => {
                process.stderr.write(
                    `[gateway-admin] shutdown failed: ${formatError(error)}\n`,
                )
            })
            .then(() => runner!.stop())
            .catch(error => {
                process.stderr.write(
                    `[matrix-gateway] shutdown failed: ${formatError(error)}\n`,
                )
            })
        void completeWithin(shutdown, shutdownTimeoutMs).then(completed => {
            if (!completed) {
                process.stderr.write(
                    `[matrix-gateway] shutdown exceeded ${shutdownTimeoutMs}ms; forcing exit.\n`,
                )
            }
            resolve({ failure: failure ?? null, forced: !completed })
        })
    }
    process.once('SIGINT', () => requestStop())
    process.once('SIGTERM', () => requestStop())
})
const stopSyncWatchdog = watchMatrixSyncHealth(sdkClient, {
    stallTimeoutMs: syncStallTimeoutMs,
}, error => {
    process.stderr.write(
        `[matrix-gateway] ${error.message}; stopping for supervisor restart.\n`,
    )
    requestStop(error)
})
const stopResult = await stopped
stopSyncWatchdog()
stopPairingRecovery()
const exitCode = stopResult.failure ? 1 : 0
if (stopResult.forced) process.exit(exitCode)
if (stopResult.failure) process.exitCode = exitCode

async function readJson<T>(path: string): Promise<T> {
    try {
        const text = (await readFile(path, 'utf8')).replace(/^\uFEFF/u, '')
        return JSON.parse(text) as T
    } catch (error) {
        throw new Error(`Could not read ${path}: ${formatError(error)}`)
    }
}

function positiveDurationFromEnvironment(name: string, fallbackMs: number): number {
    const raw = process.env[name]
    if (raw === undefined) return fallbackMs
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be a positive duration in milliseconds`)
    }
    return value
}

async function completeWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            operation.then(() => true),
            new Promise<boolean>(resolve => {
                timeout = setTimeout(() => resolve(false), timeoutMs)
            }),
        ])
    } finally {
        if (timeout) clearTimeout(timeout)
    }
}

async function loginGateway(
    homeserver: string,
    deviceId: string,
): Promise<LoginResult> {
    const user = process.env.CODEVER_MATRIX_GATEWAY_USER ?? 'gateway'
    const password = process.env.CODEVER_MATRIX_GATEWAY_PASSWORD
        ?? await readPasswordFile(process.env.CODEVER_MATRIX_GATEWAY_PASSWORD_FILE)
        ?? (isLoopbackHomeserver(homeserver) ? 'codever-gateway-local' : undefined)
    if (!password) {
        throw new Error(
            'A Matrix Gateway password environment value or file is required for a non-local homeserver',
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

async function readPasswordFile(path: string | undefined): Promise<string | undefined> {
    if (!path) return undefined
    const password = (await readFile(path, 'utf8')).trim()
    if (!password) throw new Error(`Matrix Gateway password file is empty: ${path}`)
    return password
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

function e2eProvider(name: string): AgentProvider {
    const delayMs = Number.parseInt(
        process.env.CODEVER_MATRIX_E2E_PROVIDER_DELAY_MS ?? '0',
        10,
    )
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 30_000) {
        throw new Error('CODEVER_MATRIX_E2E_PROVIDER_DELAY_MS must be between 0 and 30000')
    }
    return {
        name,
        startQuery(input): AgentQueryHandle {
            const prompt = providerInputText(input)
            process.stdout.write(
                `[e2e-provider] invocation sha256=${createHash('sha256').update(prompt).digest('hex')}\n`,
            )
            return {
                events: (async function* () {
                    if (delayMs > 0) {
                        await new Promise(resolve => setTimeout(resolve, delayMs))
                    }
                    yield {
                        kind: 'text' as const,
                        text: await deterministicE2eResponse(input),
                    }
                    yield {
                        kind: 'text' as const,
                        text: `\n\nAgent received exactly: ${prompt}`,
                    }
                    yield { kind: 'result' as const, status: 'success' as const }
                })(),
                async interrupt() {},
            }
        },
        isReady: () => true,
        getInitError: () => null,
        getAvailableModels: () => [],
        getAvailablePermissionModes: () => ['default'],
    }
}

function providerInputText(input: Parameters<AgentProvider['startQuery']>[0]): string {
    return typeof input === 'string'
        ? input
        : input.parts.map(part => part.type === 'text' ? part.text : '').join('\n')
}

async function deterministicE2eResponse(input: AgentQueryInput): Promise<string> {
    if (typeof input === 'string') return 'Codever deterministic E2E response'
    const attachmentMarkerPattern = /CODEVER_E2E_ATTACHMENT_MARKER:([A-Z0-9-]+)/u
    const fileReferencePattern = /^- ([^:\n]+): (.+) \(([^,\n]+), (\d+) bytes\)$/gmu
    const attachments: Array<{
        label: string
        bytes: Buffer
        expectedBytes?: number
    }> = []
    for (const part of input.parts) {
        if (part.type === 'text') {
            for (const match of part.text.matchAll(fileReferencePattern)) {
                const [, filename, path, , size] = match
                if (!filename || !path || !size) continue
                attachments.push({
                    label: filename,
                    bytes: await readFile(path),
                    expectedBytes: Number.parseInt(size, 10),
                })
            }
            continue
        }
        if (part.type === 'file') {
            attachments.push({
                label: part.filename,
                bytes: await readFile(part.path),
                expectedBytes: part.sizeBytes,
            })
            continue
        }
        attachments.push({
            label: part.filename ?? part.type,
            bytes: Buffer.from(part.data, 'base64'),
            expectedBytes: part.sizeBytes,
        })
    }
    if (attachments.length === 0) return 'Codever deterministic E2E response'

    const markers: string[] = []
    for (const attachment of attachments) {
        if (
            attachment.expectedBytes !== undefined
            && attachment.bytes.byteLength !== attachment.expectedBytes
        ) {
            throw new Error(
                `E2E Agent received the wrong byte count for ${attachment.label}`,
            )
        }
        const marker = attachment.bytes.toString('utf8').match(attachmentMarkerPattern)?.[1]
        if (!marker) {
            throw new Error(
                `E2E Agent could not read the attachment marker from ${attachment.label}`,
            )
        }
        markers.push(marker)
    }
    return `Codever deterministic E2E attachment result: ${markers.join(', ')}`
}
