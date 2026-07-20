import { mkdir, realpath, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import {
    PROTOCOL_VERSION,
    type ClientGatewayRequestFrame,
    type ClientGatewayResponseFrame,
    type ClientGatewayCompletedPayload,
    type Gateway,
    type InventorySnapshot,
    type SessionEventEnvelope as WireEventEnvelope,
} from '@codever/protocol'
import { ProjectRegistry } from './projects'
import { GatewaySessionService, FileSessionMetadataRepository } from './sessions'
import { FileConversationEventStore } from '@/platform/storage'
import type { GatewayConversationEvent } from './runtime'
import { toWireConversationEvent } from './runtime'
import { createProviderInstance, listProviders } from '@/providers/registry'
import { registerConfiguredProviders } from '@/providers/configured'
import { loadMatrixCredential, writeMatrixCredential, type GatewayConfig } from './gatewayConfig'
import { ExecutionTrustRepository, FileExecutionReplayGuard, type ExecutionTrustRecord } from './security'
import type { JWK } from '@codever/execution-auth'
import { GatewayRequestLedger } from './requestLedger'
import { FileObjectBlobTransport, GatewayAttachmentStore } from './attachments'
import { AuthorizedRequestProcessor } from './authorizedRequestProcessor'
import {
    GatewayVerificationAgent, MatrixGatewayWorker, NativeMatrixTransport,
    gatewayVerificationDirectory, type MatrixTransport,
} from './matrix'
import { ConversationWakeupPublisher } from './matrix/conversationWakeupPublisher'

export const GATEWAY_FEATURES = [
    'sessions', 'events', 'tools', 'decisions', 'cancel', 'project.create', 'durable-idempotency',
    'attachment.media', 'attachment.manage', 'matrix-e2ee', 'cose-cwt-authorization',
    'file.export', 'attachment.download', 'matrix-durable-sync', 'matrix-encrypted-media',
]

export interface GatewayApplication {
    readonly config: GatewayConfig
    readonly projects: ProjectRegistry
    readonly sessions: GatewaySessionService
    trustControlRoot(ownerId: string, publicKey: JWK, label?: string): Promise<ExecutionTrustRecord>
    listControlRoots(): Promise<ExecutionTrustRecord[]>
    revokeControlRoot(keyId: string): Promise<boolean>
    start(): Promise<void>
    close(): Promise<void>
}

export interface GatewayApplicationOptions {
    matrixTransport?: MatrixTransport
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
        onDiagnostic: message => console.log(`[gateway:session] ${message}`),
    })
    const trust = await ExecutionTrustRepository.open(join(config.dataDirectory, 'execution-trust.json'))
    const replayGuard = await FileExecutionReplayGuard.open(join(config.dataDirectory, 'execution-replay.json'))
    const attachments = await GatewayAttachmentStore.open(
        config.dataDirectory,
        await FileObjectBlobTransport.open(join(config.dataDirectory, 'object-blobs')),
    )
    let started = false
    let closed = false
    let heartbeat: ReturnType<typeof setInterval> | undefined

    let inventoryRevision = 1
    const gatewaySnapshot = (): Gateway => ({
        id: config.gatewayId,
        workspaceId: config.workspaceId,
        name: config.name,
        platform: process.platform === 'win32' ? 'windows'
            : process.platform === 'darwin' ? 'macos'
                : process.platform === 'linux' ? 'linux' : 'unknown',
        version: '0.1.0',
        capabilities: {
            protocolVersions: [PROTOCOL_VERSION],
            providers: listProviders(),
            features: GATEWAY_FEATURES,
            metadata: { matrixDeviceId: config.matrix.deviceId },
        },
        status: 'online',
        lastSeenAt: new Date().toISOString(),
    })
    const inventory = async (): Promise<InventorySnapshot> => ({
        generatedAt: new Date().toISOString(),
        revision: inventoryRevision,
        projects: (await projects.list({ includeArchived: true }))
            .map(project => toWireProject(project, config.gatewayId)),
        sessions: await metadata.list(),
    })

    let transport: MatrixTransport
    const mediaStagingDirectory = join(config.dataDirectory, 'matrix-media-staging')
    const requestContext = (credentialId: string): ClientRequestContext => ({
        credentialId,
        gatewayId: config.gatewayId,
        inventory,
        projects,
        sessions,
        events,
        attachments,
        executionTrust: trust,
        matrixMedia: transport.downloadEncryptedFile
            ? { download: (file, path) => transport.downloadEncryptedFile!(file, path) }
            : undefined,
        mediaStagingDirectory,
        inventoryChanged,
    })
    const processor = new AuthorizedRequestProcessor({
        gatewayId: config.gatewayId,
        trust,
        replayGuard,
        requestLedger,
        handleRequest: (request, principalId) => handleClientRequest(request, requestContext(principalId)),
    })
    const matrixCredential = options.matrixTransport ? undefined : await loadMatrixCredential(config)
    transport = options.matrixTransport ?? new NativeMatrixTransport({
        executablePath: config.matrix.transportBinaryPath,
        session: matrixCredential!.session,
        storePath: config.matrix.storePath,
        storePassphrase: matrixCredential!.storePassphrase,
        onSessionCredential: session => writeMatrixCredential(config.matrix.credentialPath, {
            accessToken: session.accessToken,
            ...(session.refreshToken ? { refreshToken: session.refreshToken } : {}),
            storePassphrase: matrixCredential!.storePassphrase,
        }),
        onError: error => console.error('[gateway:matrix]', error.message),
    })
    const worker = new MatrixGatewayWorker({
        gatewayId: config.gatewayId,
        controlRoomId: config.matrix.controlRoomId,
        transport,
        processor,
        currentGateway: gatewaySnapshot,
        currentInventory: inventory,
        trustVerifiedDeviceRoot: async (ownerId, publicKey, label) => { await trust.trust(ownerId, publicKey, label) },
        onError: error => console.error('[gateway:matrix]', error.message),
    })
    const verificationAgent = new GatewayVerificationAgent(
        transport,
        gatewayVerificationDirectory(config.dataDirectory),
        error => console.error('[gateway:matrix:verification]', error.message),
    )

    const conversationWakeups = new ConversationWakeupPublisher({
        publish: envelope => worker.publishConversation(config.matrix.controlRoomId, envelope),
        onError: error => console.error('[gateway:matrix:event]', error.message),
    })
    const unsubscribe = sessions.subscribe((envelope) => {
        const event = toWireConversationEvent(envelope.event)
        if (!event) return
        const wireEnvelope = { ...envelope, event }
        if (started) conversationWakeups.accept(wireEnvelope)
    })

    return {
        config,
        projects,
        sessions,
        trustControlRoot: (ownerId, publicKey, label) => trust.trust(ownerId, publicKey, label),
        listControlRoots: () => trust.list(),
        revokeControlRoot: keyId => trust.revoke(keyId),
        async start() {
            if (started || closed) return
            started = true
            try {
                await worker.start()
                await verificationAgent.start()
                await worker.publishGateway(gatewaySnapshot())
                await worker.publishInventory(await inventory())
                heartbeat = setInterval(() => {
                    void worker.publishGateway(gatewaySnapshot()).catch(error => {
                        console.error('[gateway:matrix:presence]', error instanceof Error ? error.message : error)
                    })
                }, 30_000)
            } catch (error) {
                started = false
                throw error
            }
        },
        async close() {
            if (closed) return
            closed = true
            if (heartbeat) clearInterval(heartbeat)
            unsubscribe()
            conversationWakeups.close()
            await verificationAgent.stop()
            await worker.stop()
            await sessions.destroy()
            await events.close()
        },
    }

    function inventoryChanged(): void {
        inventoryRevision += 1
        if (started) void inventory().then(value => worker.publishInventory(value)).catch(error => {
            console.error('[gateway:matrix:inventory]', error instanceof Error ? error.message : error)
        })
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
    executionTrust: ExecutionTrustRepository
    matrixMedia?: { download(encryptedFile: Record<string, unknown>, destinationPath: string): Promise<void> }
    mediaStagingDirectory?: string
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
            case 'attachment.media.import': {
                await context.sessions.get(request.payload.sessionId)
                if (!context.matrixMedia || !context.mediaStagingDirectory) {
                    throw new Error('Matrix encrypted media is unavailable on this Gateway')
                }
                await mkdir(context.mediaStagingDirectory, { recursive: true, mode: 0o700 })
                const path = join(context.mediaStagingDirectory, `${randomUUID()}.media`)
                try {
                    await context.matrixMedia.download(request.payload.encryptedFile, path)
                    const downloaded = await stat(path)
                    if (!downloaded.isFile() || downloaded.size !== request.payload.sizeBytes) {
                        throw new Error(`Matrix media size mismatch: expected ${request.payload.sizeBytes}, received ${downloaded.size}`)
                    }
                    payload = await context.attachments.importLocalFile({
                        sessionId: request.payload.sessionId,
                        credentialId: context.credentialId,
                        path,
                        filename: request.payload.filename,
                        mimeType: request.payload.mimeType,
                    })
                } finally {
                    await rm(path, { force: true })
                }
                break
            }
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
            case 'session.rename':
                await context.sessions.rename(
                    request.payload.sessionId,
                    request.payload.input.title,
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
            case 'execution.root.trust':
                await context.executionTrust.trust(
                    request.payload.ownerId,
                    request.payload.publicKey,
                    request.payload.label,
                )
                payload = mutationCompleted(request.idempotencyKey, completedAt)
                break
            case 'execution.root.revoke':
                if (!await context.executionTrust.revoke(request.payload.keyId)) {
                    throw new Error('Execution trust root is unknown or already revoked')
                }
                payload = mutationCompleted(request.idempotencyKey, completedAt)
                break
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
