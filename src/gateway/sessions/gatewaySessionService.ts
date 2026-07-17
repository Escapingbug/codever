import { randomUUID } from 'node:crypto'
import type { CodeverSession, JsonObject, ProviderSession, ProviderSessionListDto } from '@codever/protocol'
import type { AgentQueryInput } from '@/providers/provider'
import type { SessionEventEnvelope } from '@/platform/storage'
import {
    GatewaySessionRuntime,
    type DecisionResponseResult,
    type GatewayConversationEvent,
    type GatewayEventSubscriber,
    type GatewayTurnResult,
} from '@/gateway/runtime'
import type {
    CreateGatewaySessionInput,
    GatewaySessionServiceOptions,
    PatchGatewaySessionConfigInput,
    SendSessionMessageInput,
    SessionProviderContext,
} from './types'
import { GatewaySessionServiceError } from './types'

interface ManagedRuntime {
    runtime: GatewaySessionRuntime
    provider: import('@/providers/provider').AgentProvider
    unsubscribe: () => void
}

export class GatewaySessionService {
    private readonly runtimes = new Map<string, Promise<ManagedRuntime>>()
    private readonly subscribers = new Set<GatewayEventSubscriber>()
    private readonly mutationQueues = new Map<string, Promise<void>>()
    private readonly idempotentResults = new Map<string, Promise<unknown>>()
    private metadataQueue: Promise<void> = Promise.resolve()
    private metadataError: unknown
    private readonly now: () => number
    private readonly createId: () => string
    private readonly ready: Promise<void>
    private destroyed = false

    constructor(private readonly options: GatewaySessionServiceOptions) {
        this.now = options.now ?? Date.now
        this.createId = options.createId ?? (() => `sess_${randomUUID()}`)
        this.ready = this.restoreMetadataFromEvents()
    }

    static async open(options: GatewaySessionServiceOptions): Promise<GatewaySessionService> {
        const service = new GatewaySessionService(options)
        await service.ready
        return service
    }

    async create(projectId: string, input: CreateGatewaySessionInput): Promise<CodeverSession> {
        return this.idempotent('create', input.idempotencyKey, () => this.serialize('__create__', async () => {
            await this.assertUsable()
            const project = await this.options.projects.get(projectId)
            if (project.archivedAt) throw new GatewaySessionServiceError('invalid_argument', `Project is archived: ${projectId}`)
            const provider = requireText(input.provider, 'provider')
            const providerSessionId = input.providerSessionId?.trim()
            if (providerSessionId) {
                const existing = (await this.options.repository.list(projectId)).find(session =>
                    session.provider === provider
                    && session.providerSessionId === providerSessionId
                    && session.state !== 'closed')
                if (existing) return existing
            }
            const timestamp = new Date(this.now()).toISOString()
            const session: CodeverSession = {
                id: input.sessionId?.trim() || this.createId(),
                gatewayId: this.options.gatewayId,
                projectId,
                ...(input.title ? { title: input.title.trim() } : {}),
                state: 'idle',
                provider,
                ...(providerSessionId ? { providerSessionId } : {}),
                ...(input.model ? { model: input.model } : {}),
                ...(input.mode ? { mode: input.mode } : {}),
                config: structuredClone(input.config),
                createdAt: timestamp,
                updatedAt: timestamp,
                lastEventSeq: 0,
            }
            if (await this.options.repository.get(session.id)) {
                throw new GatewaySessionServiceError('invalid_argument', `Session ID already exists: ${session.id}`)
            }
            return this.options.repository.save(session)
        }))
    }

    async list(projectId: string): Promise<CodeverSession[]> {
        await this.assertUsable()
        await this.options.projects.get(projectId)
        return this.options.repository.list(projectId)
    }

    async listProviderSessions(projectId: string, providerName: string): Promise<ProviderSessionListDto> {
        await this.assertUsable()
        const project = await this.options.projects.get(projectId)
        const provider = requireText(providerName, 'provider')
        const bridges = (await this.options.repository.list(projectId))
            .filter(session => session.provider === provider && session.state !== 'closed' && session.providerSessionId)
        const bridgeByProviderId = new Map(bridges.map(session => [session.providerSessionId!, session]))
        const factory = this.options.providerDiscoveryFactory
        if (!factory) return {
            projectId, provider, discoverySupported: false, models: [], permissionModes: [],
            capabilities: providerCapabilities(false, false, false), sessions: [],
        }

        const discoveryProvider = await factory(provider, project)
        try {
            const models = discoveryProvider.getAvailableModels()
            const permissionModes = discoveryProvider.getAvailablePermissionModes()
            const capabilities = providerCapabilities(Boolean(discoveryProvider.listSessions), models.length > 0, permissionModes.length > 0)
            if (!discoveryProvider.listSessions) {
                return { projectId, provider, discoverySupported: false, models, permissionModes, capabilities, sessions: [] }
            }
            const discovered = await discoveryProvider.listSessions(project.canonicalRoot)
            const latestByProviderSessionId = new Map<string, (typeof discovered)[number]>()
            for (const entry of discovered) {
                const existing = latestByProviderSessionId.get(entry.sessionId)
                if (!existing || normalizeEpoch(entry.updated) > normalizeEpoch(existing.updated)) {
                    latestByProviderSessionId.set(entry.sessionId, entry)
                }
            }
            const sessions: ProviderSession[] = [...latestByProviderSessionId.values()].map(entry => {
                const bridge = bridgeByProviderId.get(entry.sessionId)
                return {
                    provider,
                    providerSessionId: entry.sessionId,
                    title: entry.title.trim() || entry.firstMessage?.trim() || 'Untitled session',
                    updatedAt: new Date(normalizeEpoch(entry.updated)).toISOString(),
                    ...(entry.cwd ? { cwd: entry.cwd } : {}),
                    ...(entry.firstMessage !== undefined ? { firstMessage: entry.firstMessage } : {}),
                    ...(bridge ? {
                        codeverSessionId: bridge.id,
                        state: bridge.state,
                        ...(bridge.archivedAt ? { archivedAt: bridge.archivedAt } : {}),
                    } : {}),
                }
            })
            return { projectId, provider, discoverySupported: true, models, permissionModes, capabilities, sessions }
        } finally {
            await discoveryProvider.destroy?.().catch(() => undefined)
        }
    }

    async get(sessionId: string): Promise<CodeverSession> {
        await this.assertUsable()
        return this.requireSession(sessionId)
    }

    subscribe(subscriber: GatewayEventSubscriber): () => void {
        if (this.destroyed) throw new Error('Gateway session service is closed')
        this.subscribers.add(subscriber)
        return () => this.subscribers.delete(subscriber)
    }

    sendMessage(
        sessionId: string,
        input: string | AgentQueryInput | SendSessionMessageInput,
        idempotencyKey?: string,
    ): Promise<GatewayTurnResult> {
        const key = typeof input === 'object' && input !== null && 'idempotencyKey' in input
            ? input.idempotencyKey
            : idempotencyKey
        const queryInput = isSendMessageDto(input) ? input.text : input as AgentQueryInput
        return this.idempotent(`${sessionId}:send`, key, () => this.serialize(sessionId, async () => {
            const session = await this.requireOpenSession(sessionId)
            if (session.archivedAt) {
                await this.options.repository.save({
                    ...session,
                    archivedAt: undefined,
                    updatedAt: new Date(this.now()).toISOString(),
                })
            }
            const runtime = await this.runtimeFor(sessionId)
            const result = await runtime.startQuery(queryInput)
            await this.flushMetadata()
            return result
        }))
    }

    cancel(sessionId: string, reason?: string, idempotencyKey?: string): Promise<boolean> {
        return this.idempotent(`${sessionId}:cancel`, idempotencyKey, async () => {
            await this.assertUsable()
            await this.requireOpenSession(sessionId)
            const managed = this.runtimes.get(sessionId)
            if (!managed) return false
            const cancelled = await (await managed).runtime.cancel(reason)
            await this.flushMetadata()
            return cancelled
        })
    }

    setArchived(sessionId: string, archived: boolean, idempotencyKey?: string): Promise<CodeverSession> {
        return this.idempotent(`${sessionId}:archive`, idempotencyKey, () => this.serialize(sessionId, async () => {
            const session = await this.requireOpenSession(sessionId)
            const updatedAt = new Date(this.now()).toISOString()
            return this.options.repository.save({
                ...session,
                ...(archived ? { archivedAt: updatedAt } : { archivedAt: undefined }),
                updatedAt,
            })
        }))
    }

    patchConfig(
        sessionId: string,
        patch: PatchGatewaySessionConfigInput | JsonObject,
        idempotencyKey?: string,
    ): Promise<CodeverSession> {
        const normalized = normalizePatch(patch)
        return this.idempotent(`${sessionId}:config`, normalized.idempotencyKey ?? idempotencyKey, () =>
            this.serialize(sessionId, async () => {
                const existing = await this.requireOpenSession(sessionId)
                const mergedConfig = { ...existing.config, ...normalized.config }
                const runtime = await this.runtimeFor(sessionId)
                await runtime.updateSettings({
                    ...('model' in normalized ? { model: normalized.model } : {}),
                    providerSettings: mergedConfig,
                })
                await this.flushMetadata()

                if ('mode' in normalized) {
                    const current = await this.requireSession(sessionId)
                    await this.options.repository.save({
                        ...current,
                        ...(normalized.mode ? { mode: normalized.mode } : { mode: undefined }),
                        updatedAt: new Date(this.now()).toISOString(),
                    })
                }
                return this.requireSession(sessionId)
            }),
        )
    }

    respondDecision(
        sessionId: string,
        decisionId: string,
        optionId: string,
        responderId?: string,
        idempotencyKey?: string,
    ): Promise<DecisionResponseResult> {
        return this.idempotent(`${sessionId}:decision`, idempotencyKey, async () => {
            await this.requireOpenSession(sessionId)
            const managed = this.runtimes.get(sessionId)
            if (!managed) return { status: 'not_found' }
            const result = await (await managed).runtime.respondDecision(decisionId, optionId, responderId)
            await this.flushMetadata()
            return result
        })
    }

    close(sessionId: string, idempotencyKey?: string): Promise<CodeverSession> {
        return this.idempotent(`${sessionId}:close`, idempotencyKey, async () => {
            const active = this.runtimes.get(sessionId)
            if (active) await (await active).runtime.cancel('Session closed.')
            return this.serialize(sessionId, async () => {
            const session = await this.requireSession(sessionId)
            if (session.state === 'closed') return session
            const managedPromise = this.runtimes.get(sessionId)
            if (managedPromise) {
                const managed = await managedPromise
                await managed.runtime.destroy()
                await this.flushMetadata()
                managed.unsubscribe()
                this.runtimes.delete(sessionId)
            } else {
                const envelope = await this.options.eventStore.append({
                    gatewayId: session.gatewayId,
                    projectId: session.projectId,
                    sessionId: session.id,
                    eventId: randomUUID(),
                    timestamp: new Date(this.now()).toISOString(),
                    event: {
                        kind: 'state',
                        previousState: session.state === 'offline' ? 'idle' : session.state,
                        state: 'closed',
                        reason: 'closed',
                    },
                })
                this.onRuntimeEvent(envelope)
                await this.flushMetadata()
            }
            return this.requireSession(sessionId)
            })
        })
    }

    closeSession(sessionId: string, idempotencyKey?: string): Promise<CodeverSession> {
        return this.close(sessionId, idempotencyKey)
    }

    async destroy(): Promise<void> {
        if (this.destroyed) return
        this.destroyed = true
        await this.ready
        const runtimes = await Promise.all([...this.runtimes.values()])
        await Promise.allSettled(runtimes.map((managed) =>
            managed.runtime.cancel('Gateway session service stopped.'),
        ))
        await Promise.all([...this.mutationQueues.values()])
        const settled = await Promise.allSettled(runtimes.map(async (managed) => {
            try {
                await managed.provider.destroy?.()
            } finally {
                managed.unsubscribe()
            }
        }))
        await this.flushMetadata()
        this.runtimes.clear()
        this.subscribers.clear()
        await this.options.repository.close()
        const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (rejected) throw rejected.reason
    }

    private async runtimeFor(sessionId: string): Promise<GatewaySessionRuntime> {
        await this.assertUsable()
        const existing = this.runtimes.get(sessionId)
        if (existing) return (await existing).runtime

        const creating = this.createRuntime(sessionId)
        this.runtimes.set(sessionId, creating)
        try {
            return (await creating).runtime
        } catch (error) {
            if (this.runtimes.get(sessionId) === creating) this.runtimes.delete(sessionId)
            throw error
        }
    }

    private async createRuntime(sessionId: string): Promise<ManagedRuntime> {
        const session = await this.requireOpenSession(sessionId)
        const project = await this.options.projects.get(session.projectId)
        if (project.archivedAt) throw new GatewaySessionServiceError('invalid_argument', `Project is archived: ${project.id}`)
        const context: SessionProviderContext = { session, project }
        const provider = await this.options.providerFactory(session.provider, context)
        if (provider.name !== session.provider) {
            await provider.destroy?.()
            throw new GatewaySessionServiceError(
                'provider_mismatch',
                `Provider factory returned "${provider.name}" for "${session.provider}"`,
            )
        }
        try {
            await this.options.initializeProvider?.(provider, context)
        } catch (error) {
            await provider.destroy?.().catch(() => undefined)
            throw error
        }

        const runtime = new GatewaySessionRuntime({
            gatewayId: session.gatewayId,
            projectId: session.projectId,
            sessionId: session.id,
            cwd: project.canonicalRoot,
            provider,
            eventStore: this.options.eventStore,
            ...(session.providerSessionId ? { providerSessionId: session.providerSessionId } : {}),
            ...(session.model ? { model: session.model } : {}),
            providerSettings: session.config,
            onSubscriberError: this.options.onSubscriberError,
        })
        const unsubscribe = runtime.subscribe((event) => this.onRuntimeEvent(event))
        return { runtime, provider, unsubscribe }
    }

    private onRuntimeEvent(event: SessionEventEnvelope<GatewayConversationEvent>): void {
        const update = this.metadataQueue.then(() => this.applyEvent(event))
        this.metadataQueue = update.catch((error) => {
            this.metadataError ??= error
            this.options.onSubscriberError?.(error)
        })
        for (const subscriber of this.subscribers) {
            try {
                subscriber(event)
            } catch (error) {
                this.options.onSubscriberError?.(error)
            }
        }
    }

    private async applyEvent(envelope: SessionEventEnvelope<GatewayConversationEvent>): Promise<void> {
        const current = await this.options.repository.get(envelope.sessionId)
        if (!current || envelope.seq <= current.lastEventSeq) return
        const event = envelope.event
        let next: CodeverSession = {
            ...current,
            updatedAt: envelope.timestamp,
            lastEventSeq: envelope.seq,
        }
        if (event.kind === 'state') next = { ...next, state: event.state }
        if (event.kind === 'provider_session') next = { ...next, providerSessionId: event.providerSessionId }
        if (event.kind === 'settings') {
            next = {
                ...next,
                ...(event.model ? { model: event.model } : { model: undefined }),
                config: structuredClone(event.providerSettings) as JsonObject,
            }
        }
        if (event.kind === 'mode_change') next = { ...next, mode: event.mode }
        await this.options.repository.save(next)
    }

    private async restoreMetadataFromEvents(): Promise<void> {
        const sessions = await this.options.repository.list()
        for (const session of sessions) {
            let after = session.lastEventSeq
            while (true) {
                const page = await this.options.eventStore.list(session.id, { after, limit: 500 })
                for (const event of page.events) await this.applyEvent(event)
                if (!page.hasMore || page.events.length === 0) break
                after = page.cursor
            }
        }
    }

    private async requireSession(sessionId: string): Promise<CodeverSession> {
        const session = await this.options.repository.get(requireText(sessionId, 'sessionId'))
        if (!session || session.gatewayId !== this.options.gatewayId) {
            throw new GatewaySessionServiceError('session_not_found', `Session not found: ${sessionId}`)
        }
        return session
    }

    private async requireOpenSession(sessionId: string): Promise<CodeverSession> {
        const session = await this.requireSession(sessionId)
        if (session.state === 'closed') {
            throw new GatewaySessionServiceError('session_closed', `Session is closed: ${sessionId}`)
        }
        return session
    }

    private async assertUsable(): Promise<void> {
        if (this.destroyed) throw new Error('Gateway session service is closed')
        await this.ready
    }

    private async flushMetadata(): Promise<void> {
        await this.metadataQueue
        if (this.metadataError) throw this.metadataError
    }

    private serialize<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
        const queue = this.mutationQueues.get(sessionId) ?? Promise.resolve()
        const result = queue.then(operation)
        const tail = result.then(() => undefined, () => undefined)
        this.mutationQueues.set(sessionId, tail)
        void tail.finally(() => {
            if (this.mutationQueues.get(sessionId) === tail) this.mutationQueues.delete(sessionId)
        })
        return result
    }

    private idempotent<T>(scope: string, key: string | undefined, operation: () => Promise<T>): Promise<T> {
        if (!key) return operation()
        const ledgerKey = `${scope}:${key}`
        const existing = this.idempotentResults.get(ledgerKey)
        if (existing) return existing as Promise<T>
        const result = operation()
        this.idempotentResults.set(ledgerKey, result)
        return result
    }
}

function normalizePatch(patch: PatchGatewaySessionConfigInput | JsonObject): PatchGatewaySessionConfigInput {
    if ('config' in patch && isRecord(patch.config)) return patch as PatchGatewaySessionConfigInput
    return { config: patch as JsonObject }
}

function isSendMessageDto(value: unknown): value is SendSessionMessageInput {
    return isRecord(value) && typeof value.text === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function normalizeEpoch(value: number): number {
    return value > 0 && value < 10_000_000_000 ? value * 1_000 : value
}

function providerCapabilities(resume: boolean, changeModel: boolean, changeMode: boolean) {
    return {
        resume,
        cancel: true,
        changeModel,
        changeMode,
        fork: false,
        retry: false,
        editHistory: false,
        listBranches: false,
        attachFiles: false,
    }
}

function requireText(value: string, field: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new GatewaySessionServiceError('invalid_argument', `${field} must be a non-empty string`)
    }
    return value.trim()
}
