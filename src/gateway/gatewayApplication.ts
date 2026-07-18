import { existsSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import {
    PROTOCOL_VERSION,
    type ClientGatewayRequestFrame,
    type ClientGatewayResponseFrame,
    type ClientGatewayCompletedPayload,
    type GatewayPlatform,
    type Gateway,
    type InventorySnapshot,
    type SessionEventEnvelope as WireEventEnvelope,
} from '@codever/protocol'
import { GatewaySecureCredentialStore, RelayLink, type GatewaySecureCredential } from './link'
import { ProjectRegistry } from './projects'
import { GatewaySessionService, FileSessionMetadataRepository } from './sessions'
import { FileConversationEventStore } from '@/platform/storage'
import type { GatewayConversationEvent } from './runtime'
import { toWireConversationEvent } from './runtime'
import { createProviderInstance, listProviders } from '@/providers/registry'
import { registerConfiguredProviders } from '@/providers/configured'
import type { GatewayConfig } from './gatewayConfig'
import {
    DeviceAuthenticator,
    DeviceCredentialRepository,
    type DeviceCredentialRecord,
} from './security'
import type { OpaquePairingTicket } from '@codever/secure-channel'
import { GatewayRequestLedger } from './requestLedger'
import { GatewayAttachmentStore, NatsObjectBlobTransport, SwitchableBlobTransport } from './attachments'
import { GatewayJetStreamWorker, NatsDevicePairingServer } from './sync'
import type { NatsConnection } from '@nats-io/transport-node'

export const GATEWAY_FEATURES = [
    'sessions', 'events', 'tools', 'decisions', 'cancel', 'project.create', 'durable-idempotency',
    'attachment.upload', 'attachment.manage', 'nats-object-storage',
    'file.export', 'attachment.download',
]

export interface GatewayApplication {
    readonly config: GatewayConfig
    readonly projects: ProjectRegistry
    readonly sessions: GatewaySessionService
    readonly relay: RelayLink
    issueDevicePairing(): OpaquePairingTicket
    listDevices(): Promise<DeviceCredentialRecord[]>
    revokeDevice(credentialId: string): Promise<boolean>
    start(): void
    close(): Promise<void>
}

export interface GatewayApplicationOptions {
    onRelayCredentialSaved?: (credential: GatewaySecureCredential) => Promise<void>
    natsConnection?: NatsConnection
    connectNats?: (credential: GatewaySecureCredential) => Promise<NatsConnection>
}

export async function createGatewayApplication(
    config: GatewayConfig,
    options: GatewayApplicationOptions = {},
): Promise<GatewayApplication> {
    registerConfiguredProviders(config.providersPath)
    const projects = await ProjectRegistry.open({
        storagePath: join(config.dataDirectory, 'projects.json'),
    })
    const metadata = await FileSessionMetadataRepository.open(join(config.dataDirectory, 'sessions.json'))
    const events = new FileConversationEventStore<GatewayConversationEvent>(join(config.dataDirectory, 'events.jsonl'))
    const requestLedger = await GatewayRequestLedger.open(join(config.dataDirectory, 'client-request-ledger.json'))
    const sessions = await GatewaySessionService.open({
        gatewayId: config.gatewayId,
        projects,
        repository: metadata,
        eventStore: events,
        providerFactory: (name) => {
            const provider = createProviderInstance(name)
            if (!provider) throw new Error(`Unknown provider: ${name}`)
            return provider
        },
        providerDiscoveryFactory: (name) => {
            const provider = createProviderInstance(name)
            if (!provider) throw new Error(`Unknown provider: ${name}`)
            return provider
        },
    })
    const deviceCredentials = await DeviceCredentialRepository.open(
        join(config.dataDirectory, 'client-device-credentials.json'),
    )
    const deviceAuthenticator = await DeviceAuthenticator.create({
        gatewayId: config.gatewayId,
        serverSetup: deviceCredentials.serverSetup,
        credentials: deviceCredentials,
        hpkeKeyPair: deviceCredentials.hpkeKeyPair,
    })
    const blobTransport = new SwitchableBlobTransport()
    let durableWorker: GatewayJetStreamWorker | undefined
    let pairingServer: NatsDevicePairingServer | undefined
    let durableConnection: NatsConnection | undefined
    let ownsDurableConnection = false
    let presenceTimer: ReturnType<typeof setInterval> | undefined
    let started = false
    let closed = false

    let inventoryRevision = 1
    const inventory = async (): Promise<InventorySnapshot> => ({
        generatedAt: new Date().toISOString(),
        revision: inventoryRevision,
        projects: (await projects.list({ includeArchived: true }))
            .map(project => toWireProject(project, config.gatewayId)),
        sessions: await metadata.list(),
    })

    const gatewayPlatform = platform()
    const gatewayPresence = (): Gateway => ({
        id: config.gatewayId,
        workspaceId: config.workspaceId,
        name: config.name,
        platform: gatewayPlatform,
        version: '0.1.0',
        capabilities: {
            protocolVersions: [PROTOCOL_VERSION],
            providers: listProviders(),
            features: GATEWAY_FEATURES,
        },
        status: 'online',
        lastSeenAt: new Date().toISOString(),
    })
    const tls = config.tls ? await loadTls(config.tls) : undefined
    const secureCredentialStore = new GatewaySecureCredentialStore(
        join(config.dataDirectory, 'secure-relay-credential.json'),
    )
    let attachments!: GatewayAttachmentStore
    const relay = new RelayLink({
        url: config.relayUrl,
        gatewayId: config.gatewayId,
        ...(tls ? { tls } : {}),
        secure: {
            credentialStore: secureCredentialStore,
            ...(config.secure?.pairingCode ? { pairingCode: config.secure.pairingCode } : {}),
        },
        onError: (error) => console.error('[gateway:relay]', error.message),
    })
    attachments = await GatewayAttachmentStore.open(config.dataDirectory, blobTransport)

    const requestContext = (credentialId: string): ClientRequestContext => ({
        credentialId,
        gatewayId: config.gatewayId,
        inventory,
        projects,
        sessions,
        events,
        attachments,
        inventoryChanged,
    })
    const createDurableWorker = (connection: NatsConnection): GatewayJetStreamWorker =>
        new GatewayJetStreamWorker({
            connection,
            gatewayId: config.gatewayId,
            credentials: deviceCredentials,
            requestLedger,
            handleRequest: (request, credentialId) => handleClientRequest(request, requestContext(credentialId)),
            onError: error => console.error('[gateway:jetstream]', error.message),
        })

    const createPairingServer = (connection: NatsConnection): NatsDevicePairingServer =>
        new NatsDevicePairingServer({
            connection,
            gatewayId: config.gatewayId,
            authenticator: deviceAuthenticator,
            onError: error => console.error('[gateway:pairing]', error.message),
        })

    const startPresence = async (): Promise<void> => {
        if (!durableWorker) return
        await durableWorker.publishPresence(gatewayPresence())
        if (presenceTimer) return
        presenceTimer = setInterval(() => {
            void durableWorker?.publishPresence(gatewayPresence()).catch(error => {
                console.error('[gateway:presence]', error instanceof Error ? error.message : error)
            })
        }, 15_000)
        presenceTimer.unref?.()
    }

    const activateDurable = async (credential?: GatewaySecureCredential): Promise<void> => {
        if (durableWorker || closed) return
        const connection = options.natsConnection
            ?? (credential && options.connectNats ? await options.connectNats(credential) : undefined)
        if (!connection) return
        ownsDurableConnection = !options.natsConnection
        durableConnection = connection
        blobTransport.use(await NatsObjectBlobTransport.open(connection, config.gatewayId))
        durableWorker = createDurableWorker(connection)
        pairingServer = createPairingServer(connection)
        await durableWorker.start()
        pairingServer.start()
        await startPresence()
        await durableWorker.publishInventory(await inventory())
    }

    if (options.natsConnection) {
        durableConnection = options.natsConnection
        blobTransport.use(await NatsObjectBlobTransport.open(options.natsConnection, config.gatewayId))
        durableWorker = createDurableWorker(options.natsConnection)
        pairingServer = createPairingServer(options.natsConnection)
    }

    const unsubscribe = sessions.subscribe((envelope) => {
        const event = toWireConversationEvent(envelope.event)
        if (!event) return
        const wireEnvelope = { ...envelope, event }
        if (durableWorker) {
            void durableWorker.publishEvent(wireEnvelope).catch(error => {
                console.error('[gateway:jetstream:event]', error instanceof Error ? error.message : error)
            })
        }
    })

    return {
        config,
        projects,
        sessions,
        relay,
        issueDevicePairing: () => deviceAuthenticator.issuePairing(),
        listDevices: () => deviceCredentials.list(),
        revokeDevice: credentialId => deviceAuthenticator.revoke(credentialId),
        start() {
            if (started || closed) return
            started = true
            if (durableWorker) {
                pairingServer?.start()
                void durableWorker.start().then(startPresence).then(inventory).then(value => durableWorker?.publishInventory(value)).catch(error => {
                    console.error('[gateway:jetstream]', error instanceof Error ? error.message : error)
                })
            }
            void (async () => {
                if (options.connectNats) {
                    const credential = await secureCredentialStore.load(config.gatewayId)
                    if (credential) {
                        await activateDurable(credential)
                        return
                    }
                }
                while (!closed && relay.state !== 'online') {
                    try {
                        await relay.start()
                        const credential = await secureCredentialStore.load(config.gatewayId)
                        if (credential) {
                            await options.onRelayCredentialSaved?.(credential)
                            await activateDurable(credential)
                            await relay.stop()
                            return
                        }
                    } catch (error) {
                        if (!closed) console.error('[gateway:relay]', error instanceof Error ? error.message : error)
                    }
                    if (!closed && !relayIsOnline(relay)) await new Promise(resolve => setTimeout(resolve, 30_000))
                }
            })()
        },
        async close() {
            if (closed) return
            closed = true
            unsubscribe()
            if (presenceTimer) clearInterval(presenceTimer)
            await durableWorker?.stop()
            await pairingServer?.stop()
            if (ownsDurableConnection && durableConnection) await durableConnection.close()
            await relay.stop()
            await sessions.destroy()
            await events.close()
        },
    }

    function inventoryChanged(): void {
        inventoryRevision += 1
        if (durableWorker) {
            void inventory().then(value => durableWorker?.publishInventory(value)).catch(error => {
                console.error('[gateway:jetstream:inventory]', error instanceof Error ? error.message : error)
            })
        }
    }
}

export interface ClientRequestContext {
    credentialId: string
    gatewayId: string
    inventory: () => Promise<InventorySnapshot>
    projects: ProjectRegistry
    sessions: GatewaySessionService
    events: FileConversationEventStore<GatewayConversationEvent>
    attachments: GatewayAttachmentStore
    inventoryChanged: () => void
}

export async function handleClientRequest(
    request: ClientGatewayRequestFrame,
    context: ClientRequestContext,
): Promise<ClientGatewayResponseFrame> {
    const completedAt = new Date().toISOString()
    try {
        let payload: ClientGatewayCompletedPayload
        switch (request.payload.kind) {
            case 'inventory.get':
                payload = await context.inventory()
                break
            case 'project.create': {
                const project = await context.projects.create(request.payload.input)
                context.inventoryChanged()
                payload = { project: toWireProject(project, context.gatewayId) }
                break
            }
            case 'provider.sessions.list':
                payload = await context.sessions.listProviderSessions(
                    request.payload.projectId,
                    request.payload.provider,
                )
                break
            case 'session.create': {
                const input = request.payload.input
                payload = { session: await context.sessions.create(request.payload.projectId, {
                    ...input,
                    idempotencyKey: request.idempotencyKey,
                }) }
                break
            }
            case 'session.message':
                await context.sessions.get(request.payload.sessionId)
                const attachmentIds = request.payload.input.attachmentIds ?? []
                const attachmentParts = await context.attachments.resolveParts(
                    request.payload.sessionId,
                    attachmentIds,
                )
                let releaseAfterCompletion = false
                try {
                    const execution = await context.sessions.acceptMessage(request.payload.sessionId, {
                        parts: [
                            ...(request.payload.input.text.trim() ? [{ type: 'text' as const, text: request.payload.input.text }] : []),
                            ...attachmentParts,
                        ],
                    }, request.idempotencyKey, request.payload.input.clientMessageId)
                    releaseAfterCompletion = true
                    void execution.completion.then(
                        () => context.attachments.releaseParts(attachmentIds),
                        () => context.attachments.releaseParts(attachmentIds),
                    ).catch(error => {
                        console.error('[gateway:attachments]', error instanceof Error ? error.message : error)
                    })
                } finally {
                    if (!releaseAfterCompletion) {
                        await context.attachments.releaseParts(attachmentIds).catch(error => {
                            console.error('[gateway:attachments]', error instanceof Error ? error.message : error)
                        })
                    }
                }
                payload = mutationCompleted(request.idempotencyKey, completedAt)
                break
            case 'attachment.upload.begin':
                await context.sessions.get(request.payload.sessionId)
                payload = await context.attachments.begin({
                    sessionId: request.payload.sessionId,
                    credentialId: context.credentialId,
                    filename: request.payload.filename,
                    mimeType: request.payload.mimeType,
                    sizeBytes: request.payload.sizeBytes,
                })
                break
            case 'attachment.upload.chunk':
                payload = await context.attachments.appendChunk({
                    attachmentId: request.payload.attachmentId,
                    credentialId: context.credentialId,
                    offset: request.payload.offset,
                    data: request.payload.data,
                })
                break
            case 'attachment.upload.complete':
                payload = await context.attachments.complete(
                    request.payload.attachmentId,
                    context.credentialId,
                )
                break
            case 'attachment.upload.cancel':
                payload = await context.attachments.cancel(request.payload.attachmentId, context.credentialId)
                break
            case 'attachment.list':
                await context.sessions.get(request.payload.sessionId)
                payload = {
                    sessionId: request.payload.sessionId,
                    attachments: context.attachments.list(request.payload.sessionId),
                }
                break
            case 'attachment.delete':
                await context.sessions.get(request.payload.sessionId)
                await context.attachments.delete(request.payload.sessionId, request.payload.attachmentIds)
                payload = mutationCompleted(request.idempotencyKey, completedAt)
                break
            case 'file.export': {
                const session = await context.sessions.get(request.payload.sessionId)
                const project = await context.projects.get(session.projectId)
                const path = await projectFilePath(project.canonicalRoot, request.payload.path)
                payload = await context.attachments.importLocalFile({
                    sessionId: session.id,
                    credentialId: context.credentialId,
                    path,
                    filename: basename(path),
                    mimeType: mimeTypeForPath(path),
                })
                break
            }
            case 'attachment.download':
                await context.sessions.get(request.payload.sessionId)
                payload = await context.attachments.downloadChunk(
                    request.payload.sessionId,
                    request.payload.attachmentId,
                    request.payload.offset,
                    request.payload.limit,
                )
                break
            case 'session.cancel':
                await context.sessions.cancel(
                    request.payload.sessionId,
                    request.payload.input.reason,
                    request.idempotencyKey,
                )
                payload = mutationCompleted(request.idempotencyKey, completedAt)
                break
            case 'session.archive.set':
                await context.sessions.setArchived(
                    request.payload.sessionId,
                    request.payload.archived,
                    request.idempotencyKey,
                )
                payload = mutationCompleted(request.idempotencyKey, completedAt)
                break
            case 'session.config.patch':
                await context.sessions.patchConfig(request.payload.sessionId, {
                    ...request.payload.input,
                    idempotencyKey: request.idempotencyKey,
                })
                payload = mutationCompleted(request.idempotencyKey, completedAt)
                break
            case 'decision.respond': {
                const value = request.payload.input.value
                if (typeof value !== 'string') throw new Error('Decision response must be an option ID string')
                await context.sessions.respondDecision(
                    request.payload.sessionId,
                    request.payload.decisionId,
                    value,
                    context.credentialId,
                    request.idempotencyKey,
                )
                payload = mutationCompleted(request.idempotencyKey, completedAt)
                break
            }
            case 'events.list': {
                const { after, before, limit: requestedLimit, sessionId } = request.payload
                if (after !== undefined && before !== undefined) {
                    throw new Error('events.list accepts either after or before, not both')
                }
                if (after === undefined && before === undefined) {
                    await context.sessions.hydrateProviderHistory(sessionId)
                }
                const all = await loadWireEvents(
                    context.events,
                    sessionId,
                    0,
                )
                const limit = requestedLimit ?? 100
                const eligible = before !== undefined
                    ? all.filter(event => event.seq < before)
                    : after !== undefined
                        ? all.filter(event => event.seq > after)
                        : all
                const selected = after !== undefined
                    ? eligible.slice(0, limit)
                    : eligible.slice(-limit)
                const firstSeq = selected.at(0)?.seq
                const lastSeq = selected.at(-1)?.seq
                payload = {
                    sessionId,
                    events: selected,
                    previousBefore: firstSeq !== undefined && all.some(event => event.seq < firstSeq) ? firstSeq : null,
                    nextAfter: lastSeq !== undefined && all.some(event => event.seq > lastSeq) ? lastSeq : null,
                }
                break
            }
        }
        return { version: PROTOCOL_VERSION, type: 'gateway.client.response', requestId: request.requestId,
            status: 'completed', completedAt, payload }
    } catch (error) {
        return {
            version: PROTOCOL_VERSION,
            type: 'gateway.client.response',
            requestId: request.requestId,
            status: 'failed',
            failedAt: new Date().toISOString(),
            error: {
                code: 'gateway_request_failed',
                message: error instanceof Error ? error.message : String(error),
                retryable: false,
            },
        }
    }
}

async function projectFilePath(rootPath: string, requestedPath: string): Promise<string> {
    const root = await realpath(resolve(rootPath))
    const target = await realpath(resolve(isAbsolute(requestedPath) ? requestedPath : join(root, requestedPath)))
    const child = relative(root, target)
    if (child === '' || child.startsWith('..') || isAbsolute(child)) {
        throw new Error('The requested file must be inside the current Project')
    }
    return target
}

function mimeTypeForPath(path: string): string {
    switch (extname(path).toLowerCase()) {
        case '.apk': return 'application/vnd.android.package-archive'
        case '.pdf': return 'application/pdf'
        case '.png': return 'image/png'
        case '.jpg': case '.jpeg': return 'image/jpeg'
        case '.json': return 'application/json'
        case '.md': return 'text/markdown'
        case '.txt': return 'text/plain'
        case '.zip': return 'application/zip'
        default: return 'application/octet-stream'
    }
}

function isReadRequest(request: ClientGatewayRequestFrame): boolean {
    return request.payload.kind === 'inventory.get'
        || request.payload.kind === 'events.list'
        || request.payload.kind === 'provider.sessions.list'
        || request.payload.kind === 'attachment.list'
        || request.payload.kind === 'attachment.download'
}

function toWireProject(
    project: Awaited<ReturnType<ProjectRegistry['get']>>,
    gatewayId: string,
) {
    return {
        id: project.id,
        gatewayId,
        name: project.name,
        rootPath: project.rootPath,
        canonicalRoot: project.canonicalRoot,
        ...(project.defaultProvider ? { defaultProvider: project.defaultProvider } : {}),
        ...(project.archivedAt ? { archivedAt: project.archivedAt } : {}),
    }
}

function mutationCompleted(commandId: string, completedAt: string) {
    return { commandId, status: 'completed' as const, acceptedAt: completedAt, completedAt }
}

async function loadWireEvents(
    store: FileConversationEventStore<GatewayConversationEvent>,
    sessionId: string,
    after: number,
): Promise<WireEventEnvelope[]> {
    const result: WireEventEnvelope[] = []
    let cursor = after
    while (true) {
        const page = await store.list(sessionId, { after: cursor, limit: 500 })
        for (const envelope of page.events) {
            const event = toWireConversationEvent(envelope.event)
            if (event) result.push({ ...envelope, event })
        }
        cursor = page.cursor
        if (!page.hasMore) return result
    }
}

async function loadTls(tls: NonNullable<GatewayConfig['tls']>) {
    return {
        rejectUnauthorized: true,
        ...(tls.certPath ? { cert: await readFile(tls.certPath) } : {}),
        ...(tls.keyPath ? { key: await readFile(tls.keyPath) } : {}),
        ...(tls.caPath ? { ca: await readFile(tls.caPath) } : {}),
    }
}

function platform(): GatewayPlatform {
    if (process.platform === 'win32') return 'windows'
    if (process.platform === 'darwin') return 'macos'
    if (process.platform === 'linux') return existsSync('/.dockerenv') ? 'container' : 'linux'
    return 'unknown'
}

function relayIsOnline(relay: RelayLink): boolean {
    return relay.state === 'online'
}
