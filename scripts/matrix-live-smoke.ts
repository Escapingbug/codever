import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    ClientEvent,
    EventType,
    MsgType,
    SyncState,
    createClient,
    type MatrixClient,
    type MatrixEvent,
} from 'matrix-js-sdk'
import { logger, type Logger } from 'matrix-js-sdk/lib/logger.js'
import type { CodeverCommand } from '@codever/protocol'
import {
    generateCommandNonce,
    generateDeviceKeyPair,
    signCommand,
} from '@codever/security'
import type {
    AgentProvider,
    AgentQueryHandle,
} from '../src/providers/provider.js'
import {
    CODEVER_MATRIX_EXTENSION,
} from '../src/channel/matrix/index.js'
import {
    MatrixGatewayRunner,
    MatrixJsSdkGatewayClient,
    type MatrixGatewayConfig,
} from '../src/gateway/matrix/index.js'

interface LocalMatrixFixture {
    homeserver: string
    roomId: string
    gatewayId: string
    tester: { userId: string }
    gateway: { userId: string }
}

interface LoginResult {
    user_id: string
    access_token: string
    device_id: string
}

(logger as typeof logger & { setLevel(level: string): void }).setLevel('ERROR')
const quietLogger: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    getChild: () => quietLogger,
}

const fixturePath = join(process.cwd(), 'dev', 'matrix', 'local-test.json')
const fixtureJson = (await readFile(fixturePath, 'utf8')).replace(/^\uFEFF/, '')
const fixture = JSON.parse(fixtureJson) as LocalMatrixFixture
assertLocalHomeserver(fixture.homeserver)

const runId = Date.now().toString(36).toUpperCase()
const testerLogin = await login(
    fixture.homeserver,
    'tester',
    'codever-tester-local',
    `CODEVER_PWA_${runId}`,
)
const gatewayLogin = await login(
    fixture.homeserver,
    'gateway',
    'codever-gateway-local',
    `CODEVER_GATEWAY_${runId}`,
)
const replayDirectory = await mkdtemp(join(tmpdir(), 'codever-matrix-live-'))
const tester = createClient({
    baseUrl: fixture.homeserver,
    accessToken: testerLogin.access_token,
    userId: testerLogin.user_id,
    deviceId: testerLogin.device_id,
    logger: quietLogger,
})
let gateway: MatrixGatewayRunner | undefined
let commandSending = false

try {
    process.stdout.write('[1/5] Initializing a real encrypted Matrix tester device...\n')
    await tester.initRustCrypto({ useIndexedDB: false })
    await tester.startClient()
    await waitUntilReady(tester)
    const testerCrypto = tester.getCrypto()
    if (!testerCrypto) throw new Error('Tester Matrix crypto did not initialize')
    const testerMatrixKeys = await testerCrypto.getOwnDeviceKeys()
    if (!await testerCrypto.isEncryptionEnabledInRoom(fixture.roomId)) {
        throw new Error(`Local room ${fixture.roomId} is not encrypted`)
    }

    process.stdout.write('[2/5] Pairing an independent P-256 command identity...\n')
    const commandKeys = await generateDeviceKeyPair()
    const providerResponse = `live Matrix response ${runId}`
    const config: MatrixGatewayConfig = {
        gatewayId: fixture.gatewayId,
        connection: {
            baseUrl: fixture.homeserver,
            accessToken: gatewayLogin.access_token,
            userId: gatewayLogin.user_id,
            deviceId: gatewayLogin.device_id,
            initialSyncTimeoutMs: 30_000,
        },
        crypto: {
            useIndexedDB: false,
            databasePrefix: `codever-live-${runId}`,
            allowInMemoryForTesting: true,
        },
        rooms: [{
            roomId: fixture.roomId,
            conversationId: fixture.roomId,
            cwd: process.cwd(),
            providerName: 'live-smoke-provider',
        }],
        trustedDevices: [{
            deviceId: testerLogin.device_id,
            publicKey: commandKeys.publicJwk,
            allowedRoomIds: [fixture.roomId],
            allowedOperations: ['prompt'],
            matrixUserId: testerLogin.user_id,
            matrixDeviceId: testerLogin.device_id,
            matrixDeviceKeys: [testerMatrixKeys.ed25519],
        }],
        replayLedgerPath: join(replayDirectory, 'replay.jsonl'),
    }

    process.stdout.write('[3/5] Starting the real Matrix Gateway and Rust crypto...\n')
    const gatewaySdkClient = createClient({
        baseUrl: fixture.homeserver,
        accessToken: gatewayLogin.access_token,
        userId: gatewayLogin.user_id,
        deviceId: gatewayLogin.device_id,
        logger: quietLogger,
    })
    gateway = new MatrixGatewayRunner(config, {
        client: new MatrixJsSdkGatewayClient(
            gatewaySdkClient,
            config.connection.initialSyncTimeoutMs,
            message => {
                if (commandSending) process.stderr.write(`${message}\n`)
            },
        ),
        providerFactory: () => smokeProvider(providerResponse),
        onRejected: (event, error) => {
            if (!commandSending) return
            const reason = error instanceof Error ? error.message : String(error)
            process.stderr.write(`[matrix-gateway] rejected ${event.eventId}: ${reason}\n`)
        },
    })
    await gateway.start()
    await waitForDevice(
        tester,
        gatewayLogin.user_id,
        gatewayLogin.device_id,
    )

    const responsePromise = waitForGatewayResponse(
        tester,
        fixture.roomId,
        gatewayLogin.user_id,
        providerResponse,
    )
    const now = Date.now()
    const command: CodeverCommand = {
        kind: 'codever.command',
        version: 1,
        commandId: crypto.randomUUID(),
        gatewayId: fixture.gatewayId,
        deviceId: testerLogin.device_id,
        conversationId: fixture.roomId,
        operation: 'prompt',
        issuedAt: now,
        expiresAt: now + 120_000,
        nonce: generateCommandNonce(),
        payload: {
            operation: 'prompt',
            text: `live Matrix prompt ${runId}`,
        },
    }
    const signedCommand = await signCommand(
        command,
        commandKeys.privateKey,
        commandKeys.keyId,
    )

    process.stdout.write('[4/5] Sending an application-signed command through Megolm E2EE...\n')
    commandSending = true
    await tester.sendEvent(
        fixture.roomId,
        EventType.RoomMessage,
        {
            msgtype: MsgType.Text,
            body: 'Codever live smoke command',
            [CODEVER_MATRIX_EXTENSION]: {
                version: 1,
                kind: 'signed_command',
                signed_command: signedCommand,
            },
        },
        `codever.live.${command.commandId}`,
    )

    const response = await responsePromise
    process.stdout.write(
        `[5/5] PASS — decrypted Gateway reply received as ${response.eventId}: ${response.body}\n`,
    )
} finally {
    await gateway?.stop().catch(() => undefined)
    tester.stopClient()
    await rm(replayDirectory, { recursive: true, force: true })
}

// matrix-js-sdk's Rust/WASM worker can retain a Node event-loop handle after
// both clients stop. All resources and assertions are complete at this point.
process.exit(0)

async function login(
    homeserver: string,
    username: string,
    password: string,
    deviceId: string,
): Promise<LoginResult> {
    const requestBody = JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: username },
        password,
        device_id: deviceId,
        initial_device_display_name: `Codever live smoke ${deviceId}`,
    })
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await fetch(`${homeserver}/_matrix/client/v3/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: requestBody,
        })
        if (response.ok) return response.json() as Promise<LoginResult>
        if (response.status !== 429 || attempt === 3) {
            throw new Error(`Matrix login failed for ${username}: HTTP ${response.status}`)
        }
        const body = await response.json() as { retry_after_ms?: number }
        await new Promise(resolve =>
            setTimeout(resolve, Math.max(250, body.retry_after_ms ?? 1_000)),
        )
    }
    throw new Error(`Matrix login failed for ${username}`)
}

async function waitUntilReady(client: MatrixClient, timeoutMs = 30_000): Promise<void> {
    if (isReady(client.getSyncState())) return
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup()
            reject(new Error(`Matrix sync did not become ready within ${timeoutMs}ms`))
        }, timeoutMs)
        const onSync = (state: SyncState): void => {
            if (isReady(state)) {
                cleanup()
                resolve()
            } else if (state === SyncState.Error || state === SyncState.Stopped) {
                cleanup()
                reject(new Error(`Matrix sync stopped in state ${state}`))
            }
        }
        const cleanup = (): void => {
            clearTimeout(timeout)
            client.off(ClientEvent.Sync, onSync)
        }
        client.on(ClientEvent.Sync, onSync)
    })
}

async function waitForGatewayResponse(
    client: MatrixClient,
    roomId: string,
    gatewayUserId: string,
    expectedText: string,
    timeoutMs = 45_000,
): Promise<{ eventId: string; body: string }> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup()
            reject(new Error(`No encrypted Gateway reply arrived within ${timeoutMs}ms`))
        }, timeoutMs)
        const onEvent = (event: MatrixEvent): void => {
            if (
                event.getRoomId() !== roomId
                || event.getSender() !== gatewayUserId
            ) return
            void client.decryptEventIfNeeded(event).then(() => {
                if (event.getType() !== EventType.RoomMessage) return
                const content = event.getContent() as Record<string, unknown>
                const body = typeof content.body === 'string' ? content.body : ''
                if (!body.includes(expectedText)) return
                const eventId = event.getId()
                if (!eventId) return
                cleanup()
                resolve({ eventId, body })
            }).catch(error => {
                cleanup()
                reject(error)
            })
        }
        const cleanup = (): void => {
            clearTimeout(timeout)
            client.off(ClientEvent.Event, onEvent)
        }
        client.on(ClientEvent.Event, onEvent)
    })
}

async function waitForDevice(
    client: MatrixClient,
    userId: string,
    deviceId: string,
    timeoutMs = 30_000,
): Promise<void> {
    const cryptoApi = client.getCrypto()
    if (!cryptoApi) throw new Error('Matrix crypto is unavailable')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const devices = await cryptoApi.getUserDeviceInfo([userId], true)
        if (devices.get(userId)?.has(deviceId)) return
        await new Promise(resolve => setTimeout(resolve, 200))
    }
    throw new Error(`Matrix device ${deviceId} was not visible within ${timeoutMs}ms`)
}

function isReady(state: SyncState | null): boolean {
    return state === SyncState.Prepared
        || state === SyncState.Syncing
        || state === SyncState.Catchup
}

function smokeProvider(response: string): AgentProvider {
    return {
        name: 'live-smoke-provider',
        startQuery(): AgentQueryHandle {
            return {
                events: (async function* () {
                    yield { kind: 'text' as const, text: response }
                    yield { kind: 'result' as const, status: 'success' as const }
                })(),
                async interrupt() {},
            }
        },
        isReady: () => true,
        getInitError: () => null,
        getAvailableModels: () => [],
        getAvailablePermissionModes: () => [],
    }
}

function assertLocalHomeserver(homeserver: string): void {
    const url = new URL(homeserver)
    if (
        url.protocol !== 'http:'
        || (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')
    ) {
        throw new Error(
            'The live smoke test only accepts the disposable localhost Synapse fixture.',
        )
    }
}
