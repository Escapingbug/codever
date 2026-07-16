import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
    AgentProvider,
    AgentQueryConfig,
    AgentQueryHandle,
    AgentQueryInput,
    ModelEntry,
    SessionEntry,
} from '@/providers/provider'
import type { AgentEvent } from '@/providers/types'
import { ProjectRegistry } from '@/gateway/projects'
import { FileConversationEventStore } from '@/platform/storage'
import type { GatewayConversationEvent } from '@/gateway/runtime'
import { GatewaySessionService } from '../gatewaySessionService'
import { FileSessionMetadataRepository } from '../sessionMetadataRepository'

const temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('GatewaySessionService', () => {
    it('discovers provider-native sessions and reuses one bridge per native session', async () => {
        const fixture = await createFixture()
        const discovery = new DiscoveryProvider()
        const service = await GatewaySessionService.open({
            ...fixture.options,
            providerFactory: () => new MockProvider(() => events({ kind: 'result', status: 'success' })),
            providerDiscoveryFactory: () => discovery,
        })

        const catalog = await service.listProviderSessions(fixture.project.id, 'mock')
        expect(catalog).toMatchObject({
            provider: 'mock',
            discoverySupported: true,
            models: [{ id: 'model-a', name: 'Model A' }],
            permissionModes: ['default', 'bypassPermissions'],
            sessions: [{ providerSessionId: 'native-1', title: 'Existing work', active: false }],
        })
        expect(discovery.destroyCalls).toBe(1)

        const input = { provider: 'mock', providerSessionId: 'native-1', title: 'Existing work', config: {} }
        const first = await service.create(fixture.project.id, input)
        const second = await service.create(fixture.project.id, input)
        expect(second.id).toBe(first.id)
        expect(first.providerSessionId).toBe('native-1')

        const connected = await service.listProviderSessions(fixture.project.id, 'mock')
        expect(connected.sessions[0]).toMatchObject({ codeverSessionId: first.id, state: 'idle' })
        await service.destroy()
        await fixture.events.close()
    })

    it('creates sessions without a provider and lazily uses only the project canonical root', async () => {
        const fixture = await createFixture()
        const providers: MockProvider[] = []
        const initializeProvider = vi.fn(async () => undefined)
        const service = await GatewaySessionService.open({
            ...fixture.options,
            providerFactory: async () => {
                const provider = new MockProvider(() => events(
                    { kind: 'session_init', sessionId: 'provider-session-1', isNewSession: true },
                    { kind: 'result', status: 'success' },
                ))
                providers.push(provider)
                return provider
            },
            initializeProvider,
        })

        const created = await service.create(fixture.project.id, {
            provider: 'mock',
            title: 'Work',
            model: 'model-a',
            config: { reasoning: 'high' },
        })
        expect(providers).toHaveLength(0)

        const observed: number[] = []
        service.subscribe((event) => observed.push(event.seq))
        await service.sendMessage(created.id, { text: 'hello' })

        expect(providers).toHaveLength(1)
        expect(initializeProvider).toHaveBeenCalledTimes(1)
        expect(providers[0]?.starts[0]?.config.cwd).toBe(fixture.project.canonicalRoot)
        expect(providers[0]?.starts[0]?.config).toMatchObject({
            model: 'model-a',
            providerSettings: { reasoning: 'high' },
        })
        const updated = await service.get(created.id)
        expect(updated).toMatchObject({
            state: 'idle',
            providerSessionId: 'provider-session-1',
            model: 'model-a',
        })
        expect(updated.lastEventSeq).toBeGreaterThan(0)
        expect(observed).toEqual(observed.map((_, index) => index + 1))

        await service.destroy()
        await fixture.events.close()
    })

    it('deduplicates mutations, serializes messages, and patches runtime config', async () => {
        const fixture = await createFixture()
        const gates = [deferred<void>(), deferred<void>()]
        const provider = new MockProvider((_input, _config, index) => iterable(async function* () {
            await gates[index]!.promise
            yield { kind: 'result', status: 'success' }
        }))
        const service = await GatewaySessionService.open({
            ...fixture.options,
            providerFactory: () => provider,
        })
        const createInput = { provider: 'mock', config: {}, idempotencyKey: 'create-key' }
        const [firstCreate, secondCreate] = await Promise.all([
            service.create(fixture.project.id, createInput),
            service.create(fixture.project.id, createInput),
        ])
        expect(secondCreate.id).toBe(firstCreate.id)

        const first = service.sendMessage(firstCreate.id, { text: 'one', idempotencyKey: 'message-1' })
        const duplicate = service.sendMessage(firstCreate.id, { text: 'ignored', idempotencyKey: 'message-1' })
        const second = service.sendMessage(firstCreate.id, { text: 'two', idempotencyKey: 'message-2' })
        await vi.waitFor(() => expect(provider.starts).toHaveLength(1))
        gates[0]!.resolve()
        await first
        await duplicate
        await vi.waitFor(() => expect(provider.starts).toHaveLength(2))
        gates[1]!.resolve()
        await second
        expect(provider.starts.map((start) => start.input)).toEqual(['one', 'two'])

        const patched = await service.patchConfig(firstCreate.id, {
            config: { reasoning: 'low' },
            model: 'model-b',
            mode: 'plan',
        })
        expect(patched).toMatchObject({
            model: 'model-b',
            mode: 'plan',
            config: { reasoning: 'low' },
        })

        await service.destroy()
        await fixture.events.close()
    })

    it('restores provider session metadata and event cursors after restart', async () => {
        const fixture = await createFixture()
        const firstProvider = new MockProvider(() => events(
            { kind: 'session_init', sessionId: 'restored-provider-session' },
            { kind: 'result', status: 'success' },
        ))
        const firstService = await GatewaySessionService.open({
            ...fixture.options,
            providerFactory: () => firstProvider,
        })
        const created = await firstService.create(fixture.project.id, { provider: 'mock', config: { trace: true } })
        await firstService.sendMessage(created.id, 'first')
        const beforeRestart = await firstService.get(created.id)
        await firstService.destroy()
        await fixture.events.close()

        const restoredRepository = await FileSessionMetadataRepository.open(fixture.metadataPath)
        const restoredEvents = new FileConversationEventStore<GatewayConversationEvent>(fixture.eventsPath)
        const restoredProvider = new MockProvider(() => events({ kind: 'result', status: 'success' }))
        const restoredService = await GatewaySessionService.open({
            gatewayId: 'gateway-1',
            projects: fixture.projects,
            repository: restoredRepository,
            eventStore: restoredEvents,
            providerFactory: () => restoredProvider,
        })

        expect(await restoredService.get(created.id)).toMatchObject({
            providerSessionId: 'restored-provider-session',
            lastEventSeq: beforeRestart.lastEventSeq,
        })
        await restoredService.sendMessage(created.id, 'second')
        expect(restoredProvider.starts[0]?.config).toMatchObject({
            cwd: fixture.project.canonicalRoot,
            sessionId: 'restored-provider-session',
            providerSettings: { trace: true },
        })
        expect((await restoredService.get(created.id)).lastEventSeq).toBeGreaterThan(beforeRestart.lastEventSeq)

        await restoredService.destroy()
        await restoredEvents.close()
    })

    it('routes decision responses and durably closes a never-started session', async () => {
        const fixture = await createFixture()
        let permissionResult: unknown
        const provider = new MockProvider((_input, config) => iterable(async function* () {
            permissionResult = await config.permissionHandler!.handleToolCall(
                'shell',
                { command: 'status' },
                { signal: config.signal },
            )
            yield { kind: 'result', status: 'success' }
        }))
        const service = await GatewaySessionService.open({
            ...fixture.options,
            providerFactory: () => provider,
        })
        const active = await service.create(fixture.project.id, { provider: 'mock', config: {} })
        const unused = await service.create(fixture.project.id, { provider: 'mock', config: {} })
        const decision = deferred<string>()
        service.subscribe((envelope) => {
            if (envelope.event.kind === 'decision' && envelope.event.phase === 'requested') {
                decision.resolve(envelope.event.decisionId)
            }
        })

        const turn = service.sendMessage(active.id, 'ask')
        await expect(service.respondDecision(active.id, await decision.promise, 'allow')).resolves.toMatchObject({
            status: 'accepted',
        })
        await turn
        expect(permissionResult).toEqual({ behavior: 'allow' })

        const closed = await service.close(unused.id)
        expect(closed.state).toBe('closed')
        expect(closed.lastEventSeq).toBe(1)
        expect(provider.starts).toHaveLength(1)

        await service.destroy()
        await fixture.events.close()
    })
})

class MockProvider implements AgentProvider {
    readonly name = 'mock'
    readonly starts: Array<{ input: AgentQueryInput; config: AgentQueryConfig }> = []
    destroyCalls = 0

    constructor(private readonly query: (
        input: AgentQueryInput,
        config: AgentQueryConfig,
        index: number,
    ) => AsyncIterable<AgentEvent>) {}

    startQuery(input: AgentQueryInput, config: AgentQueryConfig): AgentQueryHandle {
        const stream = this.query(input, config, this.starts.length)
        this.starts.push({ input, config })
        return { events: stream, interrupt: async () => undefined }
    }

    isReady(): boolean { return true }
    getInitError(): string | null { return null }
    getAvailableModels(): ModelEntry[] { return [] }
    getAvailablePermissionModes(): string[] { return [] }
    async destroy(): Promise<void> { this.destroyCalls += 1 }
}

class DiscoveryProvider extends MockProvider {
    constructor() { super(() => events()) }
    override getAvailableModels(): ModelEntry[] { return [{ id: 'model-a', name: 'Model A' }] }
    override getAvailablePermissionModes(): string[] { return ['default', 'bypassPermissions'] }
    async listSessions(cwd: string): Promise<SessionEntry[]> {
        return [{ sessionId: 'native-1', title: 'Existing work', updated: 1_752_662_400_000, cwd, firstMessage: 'Continue this work' }]
    }
}

async function createFixture() {
    const directory = await makeTemporaryDirectory()
    const root = join(directory, 'allowed', 'project')
    await mkdir(root, { recursive: true })
    const projects = await ProjectRegistry.open({
        storagePath: join(directory, 'projects.json'),
        allowedRootPolicy: { roots: [join(directory, 'allowed')] },
    })
    const project = await projects.create({ name: 'Project', rootPath: root })
    const metadataPath = join(directory, 'sessions.json')
    const eventsPath = join(directory, 'events.jsonl')
    const repository = await FileSessionMetadataRepository.open(metadataPath)
    const eventStore = new FileConversationEventStore<GatewayConversationEvent>(eventsPath)
    return {
        project,
        projects,
        metadataPath,
        eventsPath,
        events: eventStore,
        options: {
            gatewayId: 'gateway-1',
            projects,
            repository,
            eventStore,
        },
    }
}

function events(...values: AgentEvent[]): AsyncIterable<AgentEvent> {
    return iterable(async function* () { yield* values })
}

function iterable(factory: () => AsyncGenerator<AgentEvent>): AsyncIterable<AgentEvent> {
    return { [Symbol.asyncIterator]: factory }
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    const promise = new Promise<T>((settle) => { resolve = settle })
    return { promise, resolve }
}

async function makeTemporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'codever-session-service-'))
    temporaryDirectories.push(path)
    return path
}
