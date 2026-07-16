import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
    CodeverSession,
    CommandRequest,
    InventorySnapshot,
    JsonValue,
    Project as WireProject,
    SessionEventEnvelope,
} from '@codever/protocol'
import WebSocket, { type RawData } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import {
    EcdsaP256GatewayAuthenticator,
    createRelayServer,
    type ClientAuthenticator,
    type EnrolledGatewayKeyRepository,
} from '../apps/relay/src/index'
import { initializeGatewayIdentity } from '../src/gateway/identity/index'
import { RelayLink, type RelayCommandHandler } from '../src/gateway/link/index'
import { ProjectRegistry, type Project } from '../src/gateway/projects/index'
import {
    GatewaySessionService,
    MemorySessionMetadataRepository,
} from '../src/gateway/sessions/index'
import {
    toWireConversationEvent,
    type GatewayConversationEvent,
} from '../src/gateway/runtime/index'
import { MemoryConversationEventStore } from '../src/platform/storage/index'
import type {
    AgentProvider,
    AgentQueryConfig,
    AgentQueryHandle,
    AgentQueryInput,
} from '../src/providers/provider'
import type { AgentEvent } from '../src/providers/types'

const temporaryDirectories: string[] = []
const openSockets: WebSocket[] = []

afterEach(async () => {
    for (const socket of openSockets.splice(0)) socket.close()
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('multi-Gateway platform', () => {
    it('executes a Relay-routed session and resumes replicated events over WebSocket and REST', async () => {
        const root = await temporaryDirectory()
        const projectRoot = join(root, 'project')
        await mkdir(projectRoot)

        const gatewayId = 'gateway-e2e'
        const workspaceId = 'workspace-e2e'
        const identity = await initializeGatewayIdentity(join(root, 'identity'))
        const enrollment = identity.enrollmentBundle()
        const enrollmentLookups: Array<{ gatewayId: string; fingerprint: string }> = []
        const enrolledKeys: EnrolledGatewayKeyRepository = {
            async get(requestedGatewayId, fingerprint) {
                enrollmentLookups.push({ gatewayId: requestedGatewayId, fingerprint })
                if (requestedGatewayId !== gatewayId || fingerprint !== enrollment.fingerprint) return undefined
                return {
                    gatewayId,
                    fingerprint: enrollment.fingerprint,
                    publicKey: enrollment.publicKeySpkiPem,
                    enabled: true,
                }
            },
        }
        const clients: ClientAuthenticator = {
            async authenticate() {
                return { id: 'user-e2e', workspaceId, deviceId: 'browser-e2e' }
            },
            async authorize(identity) {
                return identity.workspaceId === workspaceId
            },
        }
        const relay = await createRelayServer({
            relayId: 'relay-e2e',
            clientAuthenticator: clients,
            gatewayAuthenticator: new EcdsaP256GatewayAuthenticator(enrolledKeys),
        })
        const address = await relay.listen({ host: '127.0.0.1', port: 0 })

        const projects = await ProjectRegistry.open({
            storagePath: join(root, 'projects.json'),
            allowedRootPolicy: { roots: [root] },
        })
        const localProject = await projects.create({ name: 'E2E Project', rootPath: projectRoot, defaultProvider: 'mock' })
        const metadata = new MemorySessionMetadataRepository()
        const eventStore = new MemoryConversationEventStore<GatewayConversationEvent>()
        const providers: MockAgentProvider[] = []
        const sessions = await GatewaySessionService.open({
            gatewayId,
            projects,
            repository: metadata,
            eventStore,
            providerFactory: () => {
                const provider = new MockAgentProvider()
                providers.push(provider)
                return provider
            },
        })

        let revision = 1
        let link!: RelayLink
        const inventory = async (): Promise<InventorySnapshot> => ({
            generatedAt: new Date().toISOString(),
            revision,
            projects: [wireProject(gatewayId, localProject)],
            sessions: await metadata.list(),
        })
        const handleCommand: RelayCommandHandler = async (request, context) => {
            const result = await executeCommand(sessions, request, context.idempotencyKey)
            revision += 1
            await link.refreshInventory()
            return asJson(result)
        }
        link = new RelayLink({
            url: `${address.replace('http:', 'ws:')}/v1/gateway/connect`,
            gatewayId,
            identity,
            hello: {
                workspaceId,
                name: 'E2E Gateway',
                platform: 'windows',
                gatewayVersion: 'e2e',
                supportedProtocolVersions: [1],
                capabilities: {
                    protocolVersions: [1],
                    providers: ['mock'],
                    features: ['sessions', 'events'],
                },
            },
            getInventory: inventory,
            handleCommand,
            loadEventsAfter: async (sessionId, afterSeq) => {
                const page = await eventStore.list(sessionId, { after: afterSeq, limit: 1_000 })
                return page.events.flatMap(toWireEnvelope)
            },
            heartbeatIntervalMs: 1_000,
            reconnect: { initialDelayMs: 10, maxDelayMs: 50, jitter: 0 },
        })
        const unsubscribe = sessions.subscribe(envelope => {
            const wire = toWireEnvelope(envelope)
            if (wire.length > 0) link.enqueueEvents(wire)
        })

        try {
            await link.start()
            expect(enrollmentLookups).toEqual([{ gatewayId, fingerprint: enrollment.fingerprint }])
            await eventually(async () => {
                const response = await fetch(`${address}/v1/gateways/${gatewayId}/projects`)
                const body = await response.json() as { projects?: WireProject[] }
                return response.ok && body.projects?.some(project => project.id === localProject.id) === true
            })

            const createResponse = await fetch(`${address}/v1/projects/${localProject.id}/sessions`, {
                method: 'POST',
                headers: jsonHeaders('create-e2e'),
                body: JSON.stringify({ provider: 'mock', title: 'Remote session', config: { effort: 'high' } }),
            })
            expect(createResponse.status).toBe(201)
            const created = await createResponse.json() as { session: CodeverSession }
            expect(created.session).toMatchObject({ title: 'Remote session', provider: 'mock' })
            const session = created.session

            const firstResponse = await sendMessage(address, session.id, 'first request', 'message-e2e-1')
            expect(firstResponse.status).toBe(202)
            await eventually(async () => providers[0]?.prompts.includes('first request') === true)

            let firstEvents: SessionEventEnvelope[] = []
            await eventually(async () => {
                const response = await fetch(`${address}/v1/sessions/${session.id}/events?after=0`)
                const body = await response.json() as { events?: SessionEventEnvelope[] }
                firstEvents = body.events ?? []
                return firstEvents.some(event => event.event.kind === 'assistant_text_delta')
                    && firstEvents.some(event => event.event.kind === 'session_state' && event.event.state === 'idle')
            })
            expect(firstEvents.map(event => event.seq)).toEqual(firstEvents.map((_, index) => index + 1))
            const firstCursor = firstEvents.at(-1)!.seq

            const stream = await JsonSocket.connect(
                `${address.replace('http:', 'ws:')}/v1/sessions/${session.id}/events/ws?after=${firstCursor}`,
            )
            openSockets.push(stream.socket)
            const secondResponse = await sendMessage(address, session.id, 'second request', 'message-e2e-2')
            expect(secondResponse.status).toBe(202)

            const streamed: SessionEventEnvelope[] = []
            while (!streamed.some(event => event.event.kind === 'session_state' && event.event.state === 'idle')) {
                const message = await stream.next()
                expect(message.type).toBe('session.event')
                streamed.push(message.event as SessionEventEnvelope)
            }
            expect(streamed[0]!.seq).toBe(firstCursor + 1)
            expect(streamed.some(event =>
                event.event.kind === 'user_message' && event.event.text === 'second request',
            )).toBe(true)
            expect(streamed.some(event =>
                event.event.kind === 'assistant_text_delta' && event.event.text === 'mock: second request',
            )).toBe(true)

            stream.socket.close()
            const recoveryResponse = await fetch(`${address}/v1/sessions/${session.id}/events?after=${firstCursor}`)
            expect(recoveryResponse.ok).toBe(true)
            const recovery = await recoveryResponse.json() as { events: SessionEventEnvelope[]; nextAfter: number }
            expect(recovery.events.map(event => event.eventId)).toEqual(streamed.map(event => event.eventId))
            expect(recovery.nextAfter).toBe(streamed.at(-1)!.seq)
            expect(link.acknowledgedCursors[session.id]).toBe(recovery.nextAfter)
        } finally {
            unsubscribe()
            await link.stop()
            await sessions.destroy()
            await eventStore.close()
            await relay.close()
        }
    })

    it('backfills an empty Relay from Gateway-local history requested at cursor zero', async () => {
        const root = await temporaryDirectory()
        const projectRoot = join(root, 'history-project')
        await mkdir(projectRoot)

        const gatewayId = 'gateway-history-e2e'
        const workspaceId = 'workspace-history-e2e'
        const identity = await initializeGatewayIdentity(join(root, 'identity'))
        const enrollment = identity.enrollmentBundle()
        const clients: ClientAuthenticator = {
            async authenticate() {
                return { id: 'history-user', workspaceId }
            },
            async authorize() {
                return true
            },
        }
        const keys: EnrolledGatewayKeyRepository = {
            async get(requestedGatewayId, fingerprint) {
                if (requestedGatewayId !== gatewayId || fingerprint !== enrollment.fingerprint) return undefined
                return {
                    gatewayId,
                    fingerprint,
                    publicKey: enrollment.publicKeySpkiPem,
                    enabled: true,
                }
            },
        }
        const relay = await createRelayServer({
            clientAuthenticator: clients,
            gatewayAuthenticator: new EcdsaP256GatewayAuthenticator(keys),
        })
        const address = await relay.listen({ host: '127.0.0.1', port: 0 })

        const projects = await ProjectRegistry.open({
            storagePath: join(root, 'projects.json'),
            allowedRootPolicy: { roots: [root] },
        })
        const project = await projects.create({ name: 'History Project', rootPath: projectRoot })
        const metadata = new MemorySessionMetadataRepository()
        const eventStore = new MemoryConversationEventStore<GatewayConversationEvent>()
        const sessions = await GatewaySessionService.open({
            gatewayId,
            projects,
            repository: metadata,
            eventStore,
            providerFactory: () => new MockAgentProvider(),
        })
        const localSession = await sessions.create(project.id, {
            provider: 'mock',
            title: 'Existing local session',
            config: {},
        })
        await sessions.sendMessage(localSession.id, 'created while relay was absent')
        const localHistory = await eventStore.list(localSession.id, { after: 0, limit: 1_000 })
        expect(localHistory.events.length).toBeGreaterThan(0)
        const wireHistory = localHistory.events.flatMap(toWireEnvelope)
        expect(wireHistory.some((event, index) => index > 0 && event.seq > wireHistory[index - 1]!.seq + 1)).toBe(true)
        expect(await relay.relay.repositories.events.highestSeq(localSession.id)).toBe(0)

        const syncLoads: Array<{ sessionId: string; afterSeq: number }> = []
        const linkErrors: string[] = []
        let link!: RelayLink
        link = new RelayLink({
            url: `${address.replace('http:', 'ws:')}/v1/gateway/connect`,
            gatewayId,
            identity,
            hello: {
                workspaceId,
                name: 'History Gateway',
                platform: 'windows',
                gatewayVersion: 'e2e',
                supportedProtocolVersions: [1],
                capabilities: { protocolVersions: [1], providers: ['mock'], features: ['event-replay'] },
            },
            getInventory: async () => ({
                generatedAt: new Date().toISOString(),
                revision: 1,
                projects: [wireProject(gatewayId, project)],
                sessions: await metadata.list(),
            }),
            handleCommand: async () => null,
            loadEventsAfter: async (sessionId, afterSeq) => {
                syncLoads.push({ sessionId, afterSeq })
                const page = await eventStore.list(sessionId, { after: afterSeq, limit: 1_000 })
                return page.events.flatMap(toWireEnvelope)
            },
            heartbeatIntervalMs: 1_000,
            reconnect: { initialDelayMs: 10, maxDelayMs: 50, jitter: 0 },
            onError: error => linkErrors.push(error.message),
        })

        try {
            await link.start()
            await eventually(async () => Boolean(await relay.relay.repositories.sessions.get(localSession.id)))
            try {
                await eventually(() => syncLoads.some(load =>
                    load.sessionId === localSession.id && load.afterSeq === 0,
                ))
            } catch {
                throw new Error(`Relay sync was not observed: ${linkErrors.join('; ') || 'no RelayLink error reported'}`)
            }

            let recovered: SessionEventEnvelope[] = []
            await eventually(async () => {
                const response = await fetch(`${address}/v1/sessions/${localSession.id}/events?after=0`)
                if (!response.ok) return false
                recovered = ((await response.json()) as { events: SessionEventEnvelope[] }).events
                return recovered.length === wireHistory.length
            })
            expect(recovered.map(event => event.seq)).toEqual(wireHistory.map(event => event.seq))
            expect(recovered.some(event =>
                event.event.kind === 'user_message' && event.event.text === 'created while relay was absent',
            )).toBe(true)

            const stream = await JsonSocket.connect(
                `${address.replace('http:', 'ws:')}/v1/sessions/${localSession.id}/events/ws?after=0`,
            )
            openSockets.push(stream.socket)
            const replayed: SessionEventEnvelope[] = []
            while (replayed.length < recovered.length) {
                const message = await stream.next()
                expect(message.type).toBe('session.event')
                replayed.push(message.event as SessionEventEnvelope)
            }
            expect(replayed.map(event => event.eventId)).toEqual(recovered.map(event => event.eventId))
            expect(await relay.relay.repositories.events.highestSeq(localSession.id)).toBe(recovered.at(-1)!.seq)
        } finally {
            await link.stop()
            await sessions.destroy()
            await eventStore.close()
            await relay.close()
        }
    })
})

async function executeCommand(
    sessions: GatewaySessionService,
    request: CommandRequest,
    idempotencyKey: string,
): Promise<unknown> {
    switch (request.command.kind) {
        case 'session.create':
            return sessions.create(request.projectId, {
                ...request.command,
                sessionId: request.sessionId,
                idempotencyKey,
            })
        case 'session.message':
            return sessions.sendMessage(request.sessionId, { text: request.command.text, idempotencyKey })
        case 'session.cancel':
            return { cancelled: await sessions.cancel(request.sessionId, request.command.reason, idempotencyKey) }
        case 'session.config.patch':
            return sessions.patchConfig(request.sessionId, request.command.config, idempotencyKey)
        case 'session.close':
            return sessions.close(request.sessionId, idempotencyKey)
        case 'decision.respond':
            if (typeof request.command.value !== 'string') throw new Error('Mock decision value must be a string')
            return sessions.respondDecision(
                request.sessionId,
                request.command.decisionId,
                request.command.value,
                request.actorId,
                idempotencyKey,
            )
    }
}

function toWireEnvelope(
    envelope: import('../src/platform/storage/index').SessionEventEnvelope<GatewayConversationEvent>,
): SessionEventEnvelope[] {
    const event = toWireConversationEvent(envelope.event)
    return event ? [{ ...envelope, event }] : []
}

function wireProject(gatewayId: string, project: Project): WireProject {
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

class MockAgentProvider implements AgentProvider {
    readonly name = 'mock'
    readonly prompts: string[] = []

    startQuery(input: AgentQueryInput, _config: AgentQueryConfig): AgentQueryHandle {
        const prompt = typeof input === 'string' ? input : '[rich input]'
        this.prompts.push(prompt)
        return {
            events: agentEvents(prompt),
            interrupt: async () => undefined,
        }
    }

    isReady(): boolean { return true }
    getInitError(): string | null { return null }
    getAvailableModels() { return [] }
    getAvailablePermissionModes() { return ['default'] }
}

async function* agentEvents(prompt: string): AsyncIterable<AgentEvent> {
    yield { kind: 'text', text: `mock: ${prompt}` }
    if (prompt.includes('relay was absent')) {
        yield { kind: 'raw', providerName: 'mock', rawMessage: { internal: true } }
    }
    yield { kind: 'result', status: 'success', summary: 'done' }
}

class JsonSocket {
    private readonly queued: unknown[] = []
    private readonly waiters: Array<{ resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }> = []

    private constructor(readonly socket: WebSocket) {
        socket.on('message', data => this.receive(data))
        socket.on('error', error => this.fail(error))
        socket.on('close', () => this.fail(new Error('WebSocket closed before the expected message arrived')))
    }

    static async connect(url: string): Promise<JsonSocket> {
        const socket = new WebSocket(url)
        const stream = new JsonSocket(socket)
        await new Promise<void>((resolve, reject) => {
            socket.once('open', resolve)
            socket.once('error', reject)
        })
        return stream
    }

    next(timeoutMs = 5_000): Promise<Record<string, unknown>> {
        const queued = this.queued.shift()
        if (queued !== undefined) return Promise.resolve(asRecord(queued))
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject }
            this.waiters.push(waiter)
            const timeout = setTimeout(() => {
                const index = this.waiters.indexOf(waiter)
                if (index >= 0) this.waiters.splice(index, 1)
                reject(new Error('Timed out waiting for WebSocket event'))
            }, timeoutMs)
            waiter.resolve = value => {
                clearTimeout(timeout)
                resolve(value)
            }
            waiter.reject = error => {
                clearTimeout(timeout)
                reject(error)
            }
        })
    }

    private receive(data: RawData): void {
        const value: unknown = JSON.parse(data.toString())
        const waiter = this.waiters.shift()
        if (waiter) waiter.resolve(asRecord(value))
        else this.queued.push(value)
    }

    private fail(error: Error): void {
        for (const waiter of this.waiters.splice(0)) waiter.reject(error)
    }
}

async function sendMessage(address: string, sessionId: string, text: string, key: string): Promise<Response> {
    return fetch(`${address}/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: jsonHeaders(key),
        body: JSON.stringify({ text }),
    })
}

function jsonHeaders(idempotencyKey: string): Record<string, string> {
    return { 'content-type': 'application/json', 'idempotency-key': idempotencyKey }
}

async function temporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'codever-e2e-'))
    temporaryDirectories.push(path)
    return path
}

async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
        try {
            if (await check()) return
        } catch (error) {
            lastError = error
        }
        await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw lastError instanceof Error ? lastError : new Error('Condition was not met before timeout')
}

function asJson(value: unknown): JsonValue {
    return JSON.parse(JSON.stringify(value)) as JsonValue
}

function asRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected a JSON object')
    return value as Record<string, unknown>
}
