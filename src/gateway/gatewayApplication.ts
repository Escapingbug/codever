import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
    PROTOCOL_VERSION,
    type ClientGatewayRequestFrame,
    type ClientGatewayResponseFrame,
    type ClientGatewayCompletedPayload,
    type GatewayPlatform,
    type InventorySnapshot,
    type SessionEventEnvelope as WireEventEnvelope,
} from '@codever/protocol'
import { GatewaySecureCredentialStore, RelayLink } from './link'
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
    DeviceSecureSession,
    type DeviceCredentialRecord,
} from './security'
import type { OpaquePairingTicket } from '@codever/secure-channel'

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

export async function createGatewayApplication(config: GatewayConfig): Promise<GatewayApplication> {
    registerConfiguredProviders(config.providersPath)
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
    })
    const deviceSessions = new Map<string, DeviceSecureSession>()

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
    const secureCredentialStore = new GatewaySecureCredentialStore(join(config.dataDirectory, 'secure-relay-credential.json'))
    const relay = new RelayLink({
        url: config.relayUrl,
        gatewayId: config.gatewayId,
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
        handleDeviceTunnel: async (payload, actions) => {
            if ('openedAt' in payload) {
                if (deviceSessions.has(payload.tunnelId)) throw new Error('Device tunnel is already open')
                deviceSessions.set(payload.tunnelId, new DeviceSecureSession({
                    gatewayId: config.gatewayId,
                    authenticator: deviceAuthenticator,
                    send: actions.send,
                    handleRequest: (request, credentialId) => handleClientRequest(
                        request, credentialId, inventory, sessions, events,
                    ),
                }))
                return
            }
            const device = deviceSessions.get(payload.tunnelId)
            if ('opaquePayload' in payload) {
                if (!device) throw new Error('Unknown device tunnel')
                await device.receive(payload.opaquePayload)
                return
            }
            device?.close()
            deviceSessions.delete(payload.tunnelId)
        },
        ...(tls ? { tls } : {}),
        secure: {
            credentialStore: secureCredentialStore,
            ...(config.secure?.pairingCode ? { pairingCode: config.secure.pairingCode } : {}),
        },
        onError: (error) => console.error('[gateway:relay]', error.message),
    })

    const unsubscribe = sessions.subscribe((envelope) => {
        const event = toWireConversationEvent(envelope.event)
        if (!event) return
        for (const [tunnelId, device] of deviceSessions) {
            if (!device.ready) continue
            void device.sendEvent({
                version: PROTOCOL_VERSION,
                type: 'gateway.client.event',
                payload: { events: [{ ...envelope, event }] },
            }).catch(error => {
                console.error('[gateway:device]', error instanceof Error ? error.message : error)
                device.close()
                deviceSessions.delete(tunnelId)
            })
        }
    })

    let started = false
    let closed = false
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
            void (async () => {
                while (!closed && relay.state !== 'online') {
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
            for (const device of deviceSessions.values()) device.close()
            deviceSessions.clear()
            await relay.stop()
            await sessions.destroy()
            await events.close()
        },
    }
}

async function handleClientRequest(
    request: ClientGatewayRequestFrame,
    credentialId: string,
    inventory: () => Promise<InventorySnapshot>,
    sessions: GatewaySessionService,
    events: FileConversationEventStore<GatewayConversationEvent>,
): Promise<ClientGatewayResponseFrame> {
    const completedAt = new Date().toISOString()
    try {
        let payload: ClientGatewayCompletedPayload
        switch (request.payload.kind) {
            case 'inventory.get':
                payload = await inventory()
                break
            case 'provider.sessions.list':
                payload = await sessions.listProviderSessions(request.payload.projectId, request.payload.provider)
                break
            case 'session.create': {
                const input = request.payload.input
                payload = { session: await sessions.create(request.payload.projectId, {
                    ...input,
                    idempotencyKey: request.idempotencyKey,
                }) }
                break
            }
            case 'session.message':
                await sessions.sendMessage(request.payload.sessionId, {
                    text: request.payload.input.text,
                    idempotencyKey: request.idempotencyKey,
                })
                payload = mutationCompleted(request.idempotencyKey, completedAt)
                break
            case 'session.cancel':
                await sessions.cancel(
                    request.payload.sessionId,
                    request.payload.input.reason,
                    request.idempotencyKey,
                )
                payload = mutationCompleted(request.idempotencyKey, completedAt)
                break
            case 'session.config.patch':
                await sessions.patchConfig(request.payload.sessionId, {
                    ...request.payload.input,
                    idempotencyKey: request.idempotencyKey,
                })
                payload = mutationCompleted(request.idempotencyKey, completedAt)
                break
            case 'decision.respond': {
                const value = request.payload.input.value
                if (typeof value !== 'string') throw new Error('Decision response must be an option ID string')
                await sessions.respondDecision(
                    request.payload.sessionId,
                    request.payload.decisionId,
                    value,
                    credentialId,
                    request.idempotencyKey,
                )
                payload = mutationCompleted(request.idempotencyKey, completedAt)
                break
            }
            case 'events.list': {
                const all = await loadWireEvents(events, request.payload.sessionId, request.payload.after ?? 0)
                const selected = all.slice(0, request.payload.limit ?? 500)
                payload = {
                    sessionId: request.payload.sessionId,
                    events: selected,
                    nextAfter: selected.at(-1)?.seq ?? null,
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
    if (process.platform === 'linux') return 'linux'
    return 'unknown'
}

function relayIsOnline(relay: RelayLink): boolean {
    return relay.state === 'online'
}
