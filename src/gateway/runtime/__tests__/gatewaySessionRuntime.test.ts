import { describe, expect, it, vi } from 'vitest'
import { MemoryConversationEventStore } from '@/platform/storage'
import type {
    AgentProvider,
    AgentQueryConfig,
    AgentQueryHandle,
    AgentQueryInput,
    ModelEntry,
} from '@/providers/provider'
import type { AgentEvent } from '@/providers/types'
import type { GatewayConversationEvent } from '../events'
import { GatewaySessionRuntime } from '../gatewaySessionRuntime'

describe('GatewaySessionRuntime', () => {
    it('serializes queries and publishes each event only after durable append', async () => {
        const gates = [deferred<void>(), deferred<void>()]
        const provider = new MockProvider((_prompt, _config, index) => iterable(async function* () {
            await gates[index].promise
            yield { kind: 'result', status: 'success' }
        }))
        const store = new TrackingStore()
        const runtime = createRuntime(provider, store)
        const observedSequences: number[] = []
        runtime.subscribe((envelope) => {
            expect(store.appendedEventIds.has(envelope.eventId)).toBe(true)
            observedSequences.push(envelope.seq)
        })

        const first = runtime.startQuery('first')
        const second = runtime.startQuery('second')
        await waitFor(() => provider.starts.length === 1)
        expect(provider.maxConcurrent).toBe(1)

        gates[0].resolve()
        await first
        await waitFor(() => provider.starts.length === 2)
        expect(provider.maxConcurrent).toBe(1)
        gates[1].resolve()
        await second

        expect(provider.starts.map((start) => start.prompt)).toEqual(['first', 'second'])
        expect(observedSequences).toEqual(observedSequences.map((_, index) => index + 1))
        const events = (await store.list('session-1')).events.map((envelope) => envelope.event)
        expect(events.filter((event) => event.kind === 'user_message')).toHaveLength(2)
        expect(events.filter((event) => event.kind === 'turn')).toMatchObject([
            { phase: 'started' },
            { phase: 'finished', status: 'success' },
            { phase: 'started' },
            { phase: 'finished', status: 'success' },
        ])
        expect(events.filter((event) => event.kind === 'state').map((event) => event.state)).toEqual([
            'querying', 'idle', 'querying', 'idle',
        ])
    })

    it('tracks provider session IDs and passes model and provider settings to the provider', async () => {
        const provider = new MockProvider(() => iterable(async function* () {
            yield { kind: 'session_init', sessionId: 'provider-session-2', isNewSession: true }
            yield { kind: 'text', text: 'hello' }
            yield { kind: 'result', status: 'max_turns', summary: 'limit' }
        }))
        provider.resolveModel = (model) => `resolved:${model}`
        const store = new MemoryConversationEventStore<GatewayConversationEvent>()
        const runtime = createRuntime(provider, store, {
            providerSessionId: 'provider-session-1',
            model: 'model-a',
            providerSettings: { reasoning: 'high' },
        })
        await runtime.updateSettings({
            model: 'model-b',
            providerSettings: { reasoning: 'low', trace: true },
        })

        const result = await runtime.startQuery('hello')

        expect(result).toMatchObject({ status: 'max_turns', summary: 'limit' })
        expect(runtime.getProviderSessionId()).toBe('provider-session-2')
        expect(provider.starts[0]?.config).toMatchObject({
            sessionId: 'provider-session-1',
            model: 'resolved:model-b',
            providerSettings: { reasoning: 'low', trace: true },
        })
        const events = (await store.list('session-1')).events.map((envelope) => envelope.event)
        expect(events).toContainEqual(expect.objectContaining({
            kind: 'provider_session',
            providerSessionId: 'provider-session-2',
            isNewSession: true,
        }))
        expect(events).toContainEqual(expect.objectContaining({ kind: 'assistant_text_delta', text: 'hello' }))
        expect(events).toContainEqual(expect.objectContaining({
            kind: 'settings',
            model: 'model-b',
            providerSettings: { reasoning: 'low', trace: true },
        }))
    })

    it('interrupts an active turn, records cancellation, and destroys provider resources', async () => {
        const interrupted = deferred<void>()
        const provider = new MockProvider((_prompt, config) => ({
            events: iterable(async function* () {
                await new Promise<void>((resolve) => config.signal.addEventListener('abort', () => resolve(), { once: true }))
            }),
            interrupt: async () => { provider.interruptCalls += 1; interrupted.resolve() },
        }))
        const store = new MemoryConversationEventStore<GatewayConversationEvent>()
        const runtime = createRuntime(provider, store)

        const turn = runtime.startQuery('keep running')
        await waitFor(() => provider.starts.length === 1)
        await expect(runtime.cancel('operator cancelled')).resolves.toBe(true)
        await interrupted.promise
        await expect(turn).resolves.toMatchObject({ status: 'cancelled' })
        await runtime.destroy()

        expect(provider.interruptCalls).toBe(1)
        expect(provider.destroyCalls).toBe(1)
        expect(runtime.getState()).toBe('closed')
        const events = (await store.list('session-1')).events.map((envelope) => envelope.event)
        expect(events).toContainEqual(expect.objectContaining({ kind: 'turn', phase: 'finished', status: 'cancelled' }))
        expect(events.filter((event) => event.kind === 'state').map((event) => event.state)).toEqual([
            'querying', 'canceling', 'idle', 'closed',
        ])
    })

    it('acknowledges a started turn before completion so cancellation is independently reachable', async () => {
        const provider = new MockProvider((_prompt, config) => ({
            events: iterable(async function* () {
                await new Promise<void>(resolve => config.signal.addEventListener('abort', () => resolve(), { once: true }))
            }),
            interrupt: async () => { provider.interruptCalls += 1 },
        }))
        const runtime = createRuntime(provider, new MemoryConversationEventStore<GatewayConversationEvent>())

        const execution = await runtime.beginQuery('long running turn')
        expect(runtime.getState()).toBe('querying')
        await expect(runtime.cancel('stop now')).resolves.toBe(true)
        await expect(execution.completion).resolves.toMatchObject({ status: 'cancelled' })
    })

    it('routes tool permissions through a durable first-response-wins decision', async () => {
        let permissionResult: unknown
        const provider = new MockProvider((_prompt, config) => iterable(async function* () {
            permissionResult = await config.permissionHandler?.handleToolCall(
                'shell',
                { command: 'git status' },
                { signal: config.signal },
            )
            yield { kind: 'result', status: 'success' }
        }))
        const store = new MemoryConversationEventStore<GatewayConversationEvent>()
        const runtime = createRuntime(provider, store)
        const decision = deferred<string>()
        runtime.subscribe((envelope) => {
            if (envelope.event.kind === 'decision' && envelope.event.phase === 'requested') {
                decision.resolve(envelope.event.decisionId)
            }
        })

        const turn = runtime.startQuery('run a command')
        const decisionId = await decision.promise
        await expect(runtime.respondDecision(decisionId, 'allow')).resolves.toMatchObject({ status: 'accepted' })
        await turn

        expect(permissionResult).toEqual({ behavior: 'allow' })
        const decisions = (await store.list('session-1')).events
            .map((envelope) => envelope.event)
            .filter((event) => event.kind === 'decision')
        expect(decisions.map((event) => event.phase)).toEqual(['requested', 'resolved'])
    })

    it('applies permission mode selected by the client UI without a decision prompt', async () => {
        let permissionResult: unknown
        const provider = new MockProvider((_prompt, config) => iterable(async function* () {
            permissionResult = await config.permissionHandler?.handleToolCall('shell', {}, { signal: config.signal })
            yield { kind: 'result', status: 'success' }
        }))
        const store = new MemoryConversationEventStore<GatewayConversationEvent>()
        const runtime = createRuntime(provider, store, { providerSettings: { permissionMode: 'bypassPermissions' } })

        await runtime.startQuery('run without prompting')

        expect(permissionResult).toEqual({ behavior: 'allow', permanent: true })
        expect((await store.list('session-1')).events.some(envelope => envelope.event.kind === 'decision')).toBe(false)
    })

    it('records provider failures as explicit error and error-state events', async () => {
        const provider = new MockProvider(() => iterable(async function* () {
            throw new Error('provider exploded')
        }))
        const store = new MemoryConversationEventStore<GatewayConversationEvent>()
        const runtime = createRuntime(provider, store)

        await expect(runtime.startQuery('fail')).resolves.toMatchObject({
            status: 'error',
            summary: 'provider exploded',
        })
        expect(runtime.getState()).toBe('error')
        const events = (await store.list('session-1')).events.map((envelope) => envelope.event)
        expect(events).toContainEqual(expect.objectContaining({
            kind: 'error',
            code: 'provider_query_failed',
            message: 'provider exploded',
        }))
        expect(events).toContainEqual(expect.objectContaining({ kind: 'state', state: 'error' }))
    })

    it('initializes a cold provider before the first query', async () => {
        const provider = new MockProvider(() => iterable(async function* () {
            yield { kind: 'result', status: 'success' }
        }))
        provider.ready = false
        provider.init = vi.fn(async () => { provider.ready = true })
        const store = new MemoryConversationEventStore<GatewayConversationEvent>()
        const runtime = createRuntime(provider, store)

        await expect(runtime.startQuery('continue')).resolves.toMatchObject({ status: 'success' })

        expect(provider.init).toHaveBeenCalledOnce()
        expect(provider.starts).toHaveLength(1)
        expect(runtime.getState()).toBe('idle')
    })

    it('does not make cancellation wait for a cold provider initialization', async () => {
        const initialization = deferred<void>()
        const provider = new MockProvider(() => iterable(async function* () {
            yield { kind: 'result', status: 'success' }
        }))
        provider.ready = false
        provider.init = vi.fn(() => initialization.promise)
        const runtime = createRuntime(provider, new MemoryConversationEventStore<GatewayConversationEvent>())

        const execution = await runtime.beginQuery('start slowly')
        await expect(runtime.cancel('cancel initialization')).resolves.toBe(true)
        await expect(execution.completion).resolves.toMatchObject({ status: 'cancelled' })
        expect(provider.starts).toHaveLength(0)

        initialization.resolve()
        await initialization.promise
        await runtime.destroy()
    })

    it('coalesces token-sized text deltas before durable publication', async () => {
        const provider = new MockProvider(() => iterable(async function* () {
            for (let index = 0; index < 1_000; index += 1) yield { kind: 'text', text: 'x' }
            yield { kind: 'result', status: 'success' }
        }))
        const store = new MemoryConversationEventStore<GatewayConversationEvent>()
        const runtime = createRuntime(provider, store)

        await runtime.startQuery('stream text')

        const text = (await store.list('session-1')).events
            .map(value => value.event)
            .filter((event): event is Extract<GatewayConversationEvent, { kind: 'assistant_text_delta' }> =>
                event.kind === 'assistant_text_delta')
        expect(text).toHaveLength(4)
        expect(text.map(event => event.text).join('')).toBe('x'.repeat(1_000))
    })
})

class TrackingStore extends MemoryConversationEventStore<GatewayConversationEvent> {
    readonly appendedEventIds = new Set<string>()

    override async append(event: Parameters<MemoryConversationEventStore<GatewayConversationEvent>['append']>[0]) {
        const envelope = await super.append(event)
        this.appendedEventIds.add(envelope.eventId)
        return envelope
    }
}

class MockProvider implements AgentProvider {
    readonly name = 'mock-acp'
    readonly starts: Array<{ prompt: AgentQueryInput; config: AgentQueryConfig }> = []
    resolveModel?: (model: string) => string | undefined
    interruptCalls = 0
    destroyCalls = 0
    maxConcurrent = 0
    ready = true
    init?: () => Promise<void>
    private concurrent = 0

    constructor(private readonly query: (
        prompt: AgentQueryInput,
        config: AgentQueryConfig,
        index: number,
    ) => AsyncIterable<AgentEvent> | AgentQueryHandle) {}

    startQuery(prompt: AgentQueryInput, config: AgentQueryConfig): AgentQueryHandle {
        const index = this.starts.length
        this.starts.push({ prompt, config })
        this.concurrent += 1
        this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent)
        const created = this.query(prompt, config, index)
        const handle = isHandle(created)
            ? created
            : { events: created, interrupt: async () => { this.interruptCalls += 1 } }
        return {
            ...handle,
            events: this.trackCompletion(handle.events),
        }
    }

    isReady(): boolean { return this.ready }
    getInitError(): string | null { return null }
    getAvailableModels(): ModelEntry[] { return [] }
    getAvailablePermissionModes(): string[] { return [] }
    async destroy(): Promise<void> { this.destroyCalls += 1 }

    private async *trackCompletion(events: AsyncIterable<AgentEvent>): AsyncIterable<AgentEvent> {
        try {
            yield* events
        } finally {
            this.concurrent -= 1
        }
    }
}

function createRuntime(
    provider: AgentProvider,
    store: MemoryConversationEventStore<GatewayConversationEvent>,
    overrides: Partial<ConstructorParameters<typeof GatewaySessionRuntime>[0]> = {},
): GatewaySessionRuntime {
    return new GatewaySessionRuntime({
        gatewayId: 'gateway-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        cwd: 'D:/project',
        provider,
        eventStore: store,
        ...overrides,
    })
}

function iterable(factory: () => AsyncGenerator<AgentEvent>): AsyncIterable<AgentEvent> {
    return { [Symbol.asyncIterator]: factory }
}

function isHandle(value: AsyncIterable<AgentEvent> | AgentQueryHandle): value is AgentQueryHandle {
    return 'events' in value
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

async function waitFor(predicate: () => boolean): Promise<void> {
    await vi.waitFor(() => expect(predicate()).toBe(true))
}
