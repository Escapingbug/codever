import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import QRCode from 'qrcode'
import { pairingOperationSchema, type PairingOperation } from '@codever/protocol'
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
    MatrixCvp3GatewayRunner,
    MatrixNodeSdkGatewayClient,
    loadOrCreateMatrixCryptoPassphrase,
    loadOrLoginMatrixGateway,
    type MatrixGatewayConfig,
} from '../src/gateway/matrix/index.js'
import { registerConfiguredProviders } from '../src/providers/configured.js'
import { registerProvider } from '../src/providers/registry.js'
import type {
    AgentProvider,
    AgentQueryHandle,
    AgentQueryInput,
} from '../src/providers/provider.js'
import { createSessionExtensionRegistryFromEnvironment } from '../src/runtime/sessionExtensionConfig.js'
import { UnixSocketPrivilegeExecutor } from '../src/privilege/index.js'

interface LocalMatrixFixture {
    homeserver: string
    roomId: string
    gatewayId: string
    gateway: { userId: string }
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
const e2eStartupPairingOperations = parseE2eStartupPairingOperations(
    process.env.CODEVER_MATRIX_E2E_STARTUP_PAIRING_OPERATIONS,
    deterministicE2eProvider,
)
const providerName = deterministicE2eProvider
    ? 'codex'
    : process.env.CODEVER_PROVIDER
        ?? registered.defaultProvider
        ?? 'codex'
if (deterministicE2eProvider) {
    registerProvider(
        e2eProvider(providerName),
        () => e2eProvider(providerName),
        { type: 'codex' },
    )
}
const cwd = process.env.CODEVER_CWD ?? process.cwd()
const sessionExtensionRegistry = await createSessionExtensionRegistryFromEnvironment()
const dataDirectory = process.env.CODEVER_MATRIX_DATA_DIR
    ?? join(process.cwd(), 'dev', 'matrix', 'gateway-data')
const adminSocketPath = process.env.CODEVER_GATEWAY_ADMIN_SOCKET
    ?? join(dataDirectory, 'admin.sock')
process.env.CODEVER_GATEWAY_ADMIN_SOCKET = adminSocketPath
const defaultPrivilegeCredentialPath = join(dataDirectory, 'privilege-client.json')
const privilegeCredentialPath = process.env.CODEVER_PRIVILEGE_CREDENTIAL_FILE?.trim()
    || (existsSync(defaultPrivilegeCredentialPath) ? defaultPrivilegeCredentialPath : undefined)
const privilegeExecutor = privilegeCredentialPath
    ? new UnixSocketPrivilegeExecutor(privilegeCredentialPath)
    : undefined
if (privilegeExecutor) process.env.CODEVER_PRIVILEGE_AVAILABLE = '1'
const runId = Date.now().toString(36).toUpperCase()
const loginUser = process.env.CODEVER_MATRIX_GATEWAY_USER ?? 'gateway'
const gatewayMatrixDeviceId = `CODEVER_GATEWAY_${runId}`
const login = await loadOrLoginMatrixGateway({
    homeserver: fixture.homeserver,
    loginUser,
    deviceId: gatewayMatrixDeviceId,
    deviceDisplayName: `${
        process.env.CODEVER_GATEWAY_NAME ?? 'Codever local Gateway'
    } ${gatewayMatrixDeviceId}`,
    sessionPath: process.env.CODEVER_MATRIX_GATEWAY_SESSION_FILE
        ?? join(dataDirectory, 'matrix-session.json'),
    readPassword: async () => process.env.CODEVER_MATRIX_GATEWAY_PASSWORD
        ?? await readPasswordFile(process.env.CODEVER_MATRIX_GATEWAY_PASSWORD_FILE)
        ?? (isLoopbackHomeserver(fixture.homeserver) ? 'codever-gateway-local' : undefined),
    onLog: message => process.stderr.write(`[matrix-login] ${message}\n`),
})
const client = new MatrixNodeSdkGatewayClient({
    baseUrl: fixture.homeserver,
    accessToken: login.access_token,
    userId: login.user_id,
    deviceId: login.device_id,
    initialSyncTimeoutMs: 30_000,
}, 30_000, message => {
    process.stderr.write(`${message}\n`)
})
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

const cryptoConfig = {
    backend: 'node-sqlite' as const,
    storagePath: join(dataDirectory, 'matrix-crypto'),
    storagePassword: await loadOrCreateMatrixCryptoPassphrase(
        join(dataDirectory, 'matrix-crypto.passphrase'),
    ),
    syncTokenPath: join(dataDirectory, 'matrix-sync-token.json'),
}
await client.initializeCrypto(cryptoConfig)
await client.start()
await client.waitUntilReady()
await client.assertRoomEncrypted(fixture.roomId)
const ownKeys = client.getOwnDeviceKeys()
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
        ...(e2eStartupPairingOperations
            ? { allowedOperations: e2eStartupPairingOperations }
            : {}),
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
let runner: MatrixCvp3GatewayRunner | null = null
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
    crypto: cryptoConfig,
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
    gatewayHeartbeatIntervalMs: positiveDurationFromEnvironment(
        'CODEVER_MATRIX_GATEWAY_HEARTBEAT_INTERVAL_MS',
        30_000,
    ),
}
runner = new MatrixCvp3GatewayRunner(config, {
    client,
    sessionExtensionRegistry,
    ...(privilegeExecutor ? { privilegeExecutor } : {}),
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
    socketPath: adminSocketPath,
    gatewayId: identity.gatewayId,
    coordinator: invitationCoordinator,
    pairingService,
    registry,
    getGatewayState: () => runner?.getState() ?? 'starting',
    syncGatewayState: async () => {
        await runner?.syncState()
    },
    receiveWorkspaceFile: async input => {
        if (!runner) throw new Error('Gateway runtime is unavailable')
        return runner.receiveWorkspaceFile(input)
    },
    publishNativeClientRelease: async release => {
        if (!runner) throw new Error('Gateway runtime is unavailable')
        return runner.publishNativeClientRelease(release)
    },
    ...(privilegeExecutor
        ? {
            onPrivilegedExecution: async ({ sessionId, ...request }) =>
                await runner!.requestPrivilegedExecution(sessionId, request),
        }
        : {}),
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
let stopping = false
const stopped = new Promise<{ failure: Error | null; forced: boolean }>(resolve => {
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
let stopSyncWatchdog = (): void => undefined
const armSyncWatchdog = (): void => {
    stopSyncWatchdog = client.watchSyncHealth({
        stallTimeoutMs: syncStallTimeoutMs,
    }, error => {
        process.stderr.write(
            `[matrix-gateway] ${error.message}; restarting Matrix sync in place.\n`,
        )
        void (async () => {
            try {
                await client.restartSync()
            } catch (restartError) {
                const failure = restartError instanceof Error
                    ? restartError
                    : new Error(formatError(restartError))
                process.stderr.write(
                    `[matrix-gateway] Matrix sync restart failed: ${failure.message}\n`,
                )
                requestStop(failure)
                return
            }
            if (stopping) return
            process.stderr.write('[matrix-gateway] Matrix sync restarted in place.\n')
            try {
                await runner!.syncState()
            } catch (stateError) {
                process.stderr.write(
                    `[matrix-gateway] post-restart Room State sync failed: ${formatError(stateError)}\n`,
                )
            }
            if (!stopping) armSyncWatchdog()
        })()
    })
}
armSyncWatchdog()
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

function parseE2eStartupPairingOperations(
    serialized: string | undefined,
    deterministicE2eProvider: boolean,
): PairingOperation[] | undefined {
    if (serialized === undefined) return undefined
    if (!deterministicE2eProvider) {
        throw new Error(
            'CODEVER_MATRIX_E2E_STARTUP_PAIRING_OPERATIONS requires the loopback-only E2E provider',
        )
    }
    const candidate: unknown = JSON.parse(serialized)
    if (!Array.isArray(candidate) || candidate.length === 0) {
        throw new Error('E2E startup pairing operations must be a non-empty JSON array')
    }
    const operations = candidate.map(operation => pairingOperationSchema.parse(operation))
    if (new Set(operations).size !== operations.length) {
        throw new Error('E2E startup pairing operations must be unique')
    }
    return operations
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
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 300_000) {
        throw new Error('CODEVER_MATRIX_E2E_PROVIDER_DELAY_MS must be between 0 and 300000')
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
        getAvailableModels: () => [{
            id: 'codever-e2e-model',
            name: 'Codever E2E Model',
            defaultReasoningLevel: 'high',
            supportedReasoningLevels: [
                { effort: 'medium', description: 'Deterministic medium reasoning' },
                { effort: 'high', description: 'Deterministic high reasoning' },
            ],
        }],
        getAvailablePermissionModes: () => ['default'],
    }
}

function providerInputText(input: Parameters<AgentProvider['startQuery']>[0]): string {
    return typeof input === 'string'
        ? input
        : input.parts.map(part => part.type === 'text' ? part.text : '').join('\n')
}

async function deterministicE2eResponse(input: AgentQueryInput): Promise<string> {
    const prompt = providerInputText(input)
    const largeResponse = prompt.match(/CODEVER_E2E_LARGE_RESPONSE:([A-Z0-9-]+)/u)?.[1]
    if (largeResponse) {
        const lines = Array.from({ length: 640 }, (_, index) =>
            `large-output-${largeResponse}-${index.toString().padStart(4, '0')}-` +
            '持久化分页恢复必须完整且可重复验证',
        )
        return [
            `CODEVER-E2E-LARGE-BEGIN-${largeResponse}`,
            ...lines,
            `CODEVER-E2E-LARGE-END-${largeResponse}`,
        ].join('\n')
    }
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
