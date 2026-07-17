import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
    PROTOCOL_VERSION,
    type CommandRequest,
    type GatewayPlatform,
    type InventorySnapshot,
    type JsonValue,
    type SessionEventEnvelope as WireEventEnvelope,
} from '@codever/protocol'
import { initializeGatewayIdentity, type GatewayIdentity } from './identity'
import { ensureGatewayEnrollment, GatewaySecureCredentialStore, RelayCommandError, RelayLink } from './link'
import { ProjectRegistry } from './projects'
import { GatewaySessionService, FileSessionMetadataRepository } from './sessions'
import { FileConversationEventStore } from '@/platform/storage'
import type { GatewayConversationEvent } from './runtime'
import { toWireConversationEvent } from './runtime'
import { createProviderInstance, listProviders } from '@/providers/registry'
import { registerConfiguredProviders } from '@/providers/configured'
import type { GatewayConfig } from './gatewayConfig'

export interface GatewayApplication {
    readonly config: GatewayConfig
    readonly identity: GatewayIdentity
    readonly projects: ProjectRegistry
    readonly sessions: GatewaySessionService
    readonly relay: RelayLink
    start(): void
    close(): Promise<void>
}

export async function createGatewayApplication(config: GatewayConfig): Promise<GatewayApplication> {
    registerConfiguredProviders(config.providersPath)
    const identity = await initializeGatewayIdentity(join(config.dataDirectory, 'identity'))
    const projects = await ProjectRegistry.open({
        storagePath: join(config.dataDirectory, 'projects.json'),
        allowedRootPolicy: { roots: config.allowedRoots },
    })
    const metadata = await FileSessionMetadataRepository.open(join(config.dataDirectory, 'sessions.json'))
    const events = new FileConversationEventStore<GatewayConversationEvent>(join(config.dataDirectory, 'events.jsonl'))
    const sessions = await GatewaySessionService.open({
        gatewayId: config.gatewayId,
        projects,
        repository: metadata,
        eventStore: events,
        providerFactory: (name) => {
            const provider = createProviderInstance(name)
            if (!provider) throw new RelayCommandError(`Unknown provider: ${name}`, 'unknown_provider')
            return provider
        },
        providerDiscoveryFactory: (name) => {
            const provider = createProviderInstance(name)
            if (!provider) throw new RelayCommandError(`Unknown provider: ${name}`, 'unknown_provider')
            return provider
        },
    })

    let inventoryRevision = 1
    const inventory = async (): Promise<InventorySnapshot> => ({
        generatedAt: new Date().toISOString(),
        revision: inventoryRevision,
        projects: (await projects.list({ includeArchived: true })).map((project) => ({
            id: project.id,
            gatewayId: config.gatewayId,
            name: project.name,
            rootPath: project.rootPath,
            canonicalRoot: project.canonicalRoot,
            ...(project.defaultProvider ? { defaultProvider: project.defaultProvider } : {}),
            ...(project.archivedAt ? { archivedAt: project.archivedAt } : {}),
        })),
        sessions: await metadata.list(),
    })

    const gatewayPlatform = platform()
    const tls = config.tls ? await loadTls(config.tls) : undefined
    const secureCredentialStore = config.secure
        ? new GatewaySecureCredentialStore(join(config.dataDirectory, 'secure-relay-credential.json'))
        : undefined
    const relay = new RelayLink({
        url: config.relayUrl,
        gatewayId: config.gatewayId,
        identity,
        hello: {
            workspaceId: config.workspaceId,
            name: config.name,
            platform: gatewayPlatform,
            gatewayVersion: '0.1.0',
            supportedProtocolVersions: [PROTOCOL_VERSION],
            capabilities: {
                protocolVersions: [PROTOCOL_VERSION],
                providers: listProviders(),
                features: ['sessions', 'events', 'tools', 'decisions', 'cancel'],
            },
        },
        getInventory: inventory,
        loadEventsAfter: async (sessionId, afterSeq) => loadWireEvents(events, sessionId, afterSeq),
        handleCommand: async (request) => {
            const result = await handleCommand(sessions, request)
            inventoryRevision += 1
            await relay.refreshInventory()
            return result
        },
        getHeartbeat: async () => ({
            inventoryRevision,
            sessionStates: Object.fromEntries((await metadata.list()).map((session) => [session.id, session.state])),
        }),
        ...(tls ? { tls } : {}),
        ...(secureCredentialStore ? {
            secure: {
                credentialStore: secureCredentialStore,
                ...(config.secure?.pairingCode ? { pairingCode: config.secure.pairingCode } : {}),
            },
        } : {}),
        onError: (error) => console.error('[gateway:relay]', error.message),
    })

    const unsubscribe = sessions.subscribe((envelope) => {
        const event = toWireConversationEvent(envelope.event)
        if (!event) return
        relay.enqueueEvent({ ...envelope, event })
    })

    let started = false
    let closed = false
    return {
        config,
        identity,
        projects,
        sessions,
        relay,
        start() {
            if (started || closed) return
            started = true
            void (async () => {
                while (!closed && relay.state !== 'online') {
                    if (!config.secure) {
                        try {
                            const enrollment = await ensureGatewayEnrollment({
                                relayWebSocketUrl: config.relayUrl,
                                gatewayId: config.gatewayId,
                                workspaceId: config.workspaceId,
                                name: config.name,
                                platform: gatewayPlatform,
                                identity,
                                ...(tls && { tls }),
                            })
                            if (enrollment.status === 'pending') {
                                console.log(`[gateway:enrollment] Pairing code ${enrollment.code}; fingerprint ${enrollment.fingerprint}; expires ${enrollment.expiresAt}`)
                            }
                        } catch (error) {
                            if (!closed) console.error('[gateway:enrollment]', error instanceof Error ? error.message : error)
                        }
                    }
                    try {
                        await relay.start()
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
            await relay.stop()
            await sessions.destroy()
            await events.close()
        },
    }
}

async function handleCommand(sessions: GatewaySessionService, request: CommandRequest): Promise<JsonValue> {
    const command = request.command
    switch (command.kind) {
        case 'session.create':
            return sessions.create(request.projectId, {
                sessionId: request.sessionId,
                provider: command.provider,
                config: command.config,
                ...(command.title ? { title: command.title } : {}),
                ...(command.model ? { model: command.model } : {}),
                ...(command.mode ? { mode: command.mode } : {}),
                ...(command.providerSessionId ? { providerSessionId: command.providerSessionId } : {}),
                idempotencyKey: request.commandId,
            })
        case 'provider.sessions.list':
            return sessions.listProviderSessions(request.projectId, command.provider)
        case 'session.message':
            return jsonValue(await sessions.sendMessage(request.sessionId, { text: command.text, idempotencyKey: request.commandId }))
        case 'session.cancel':
            return { cancelled: await sessions.cancel(request.sessionId, command.reason, request.commandId) }
        case 'session.config.patch':
            return sessions.patchConfig(request.sessionId, {
                config: command.config,
                ...('model' in command ? { model: command.model } : {}),
                ...('mode' in command ? { mode: command.mode } : {}),
                idempotencyKey: request.commandId,
            })
        case 'session.close':
            return sessions.close(request.sessionId, request.commandId)
        case 'decision.respond':
            if (typeof command.value !== 'string') {
                throw new RelayCommandError('Decision response value must be an option ID string', 'invalid_decision')
            }
            return jsonValue(await sessions.respondDecision(request.sessionId, command.decisionId, command.value, request.actorId, request.commandId))
    }
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
    if (process.platform === 'linux') return 'linux'
    return 'unknown'
}

function relayIsOnline(relay: RelayLink): boolean {
    return relay.state === 'online'
}

function jsonValue(value: unknown): JsonValue {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) return null
    return JSON.parse(serialized) as JsonValue
}
