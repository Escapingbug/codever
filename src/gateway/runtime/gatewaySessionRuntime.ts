import { randomUUID } from 'node:crypto'
import type { ConversationEventStore, SessionEventEnvelope } from '@/platform/storage'
import type {
    AgentPermissionHandler,
    AgentProvider,
    AgentQueryHandle,
    AgentQueryInput,
} from '@/providers/provider'
import type { AgentEvent } from '@/providers/types'
import {
    createProviderSemanticAdapter,
    type ProviderSemanticAdapter,
} from '@/runtime/providerAdapter'
import { DecisionBroker, type DecisionResponseResult } from './decisionBroker'
import type {
    GatewayConversationEvent,
    GatewayDecisionRequest,
    GatewayErrorEvent,
    GatewaySessionState,
    GatewayTurnStatus,
} from './events'

export interface GatewaySessionRuntimeConfig {
    gatewayId: string
    projectId: string
    sessionId: string
    cwd: string
    provider: AgentProvider
    eventStore: ConversationEventStore<GatewayConversationEvent>
    providerSessionId?: string
    model?: string
    providerSettings?: Record<string, unknown>
    adapter?: ProviderSemanticAdapter
    decisionExpiryMs?: number
    now?: () => number
    createId?: () => string
    onSubscriberError?: (error: unknown) => void
}

export interface GatewayRuntimeSettings {
    model?: string
    providerSettings: Record<string, unknown>
}

export interface GatewayTurnResult {
    turnId: string
    status: GatewayTurnStatus
    summary?: string
}

export interface GatewayTurnExecution {
    completion: Promise<GatewayTurnResult>
}

export type GatewayEventSubscriber = (event: SessionEventEnvelope<GatewayConversationEvent>) => void

/** Transport-neutral execution core for a durable Codever Gateway session. */
export class GatewaySessionRuntime {
    private state: GatewaySessionState = 'idle'
    private mailbox: Promise<void> = Promise.resolve()
    private readonly adapter: ProviderSemanticAdapter
    private readonly subscribers = new Set<GatewayEventSubscriber>()
    private readonly now: () => number
    private readonly createId: () => string
    private activeHandle: AgentQueryHandle | null = null
    private activeAbortController: AbortController | null = null
    private activeTurnId: string | null = null
    private destroyed = false
    private destroyPromise: Promise<void> | null = null
    private providerSessionId?: string
    private providerInitialization: Promise<void> | null = null
    private model?: string
    private providerSettings: Record<string, unknown>
    readonly decisions: DecisionBroker

    constructor(private readonly config: GatewaySessionRuntimeConfig) {
        this.now = config.now ?? Date.now
        this.createId = config.createId ?? randomUUID
        this.providerSessionId = config.providerSessionId
        this.model = config.model
        this.providerSettings = { ...config.providerSettings }
        this.adapter = config.adapter ?? createProviderSemanticAdapter(config.provider.name, {
            boundedToolUpdates: true,
        })
        this.decisions = new DecisionBroker({
            publish: (event) => this.record(event),
            defaultExpiryMs: config.decisionExpiryMs,
            now: this.now,
            createId: this.createId,
        })
    }

    getState(): GatewaySessionState {
        return this.state
    }

    getProviderSessionId(): string | undefined {
        return this.providerSessionId
    }

    getSettings(): GatewayRuntimeSettings {
        return {
            ...(this.model ? { model: this.model } : {}),
            providerSettings: { ...this.providerSettings },
        }
    }

    subscribe(subscriber: GatewayEventSubscriber): () => void {
        this.subscribers.add(subscriber)
        return () => this.subscribers.delete(subscriber)
    }

    startQuery(input: AgentQueryInput, clientMessageId?: string): Promise<GatewayTurnResult> {
        return this.enqueue(() => this.runTurn(input, clientMessageId))
    }

    beginQuery(input: AgentQueryInput, clientMessageId?: string): Promise<GatewayTurnExecution> {
        let accept!: () => void
        let reject!: (error: unknown) => void
        const accepted = new Promise<void>((resolve, rejectPromise) => {
            accept = resolve
            reject = rejectPromise
        })
        const completion = this.enqueue(() => this.runTurn(input, clientMessageId, accept))
        void completion.catch(reject)
        return accepted.then(() => ({ completion }))
    }

    async updateSettings(settings: {
        model?: string | null
        providerSettings?: Record<string, unknown>
    }): Promise<GatewayRuntimeSettings> {
        if (this.destroyed) throw new Error('Gateway session runtime is closed.')
        if ('model' in settings) this.model = settings.model ?? undefined
        if (settings.providerSettings) this.providerSettings = { ...settings.providerSettings }
        await this.record({
            kind: 'settings',
            ...(this.model ? { model: this.model } : {}),
            providerSettings: { ...this.providerSettings },
        })
        return this.getSettings()
    }

    respondDecision(decisionId: string, optionId: string, responderId?: string): Promise<DecisionResponseResult> {
        return this.decisions.respond(decisionId, optionId, responderId)
    }

    async cancel(reason = 'Session turn cancelled.'): Promise<boolean> {
        const abortController = this.activeAbortController
        if (!abortController || !this.activeTurnId) return false

        let transitionError: unknown
        try {
            await this.transition('canceling', reason)
        } catch (error) {
            transitionError = error
        }
        abortController.abort()
        await this.decisions.cancelAll(reason)
        await this.activeHandle?.interrupt()
        if (transitionError) throw transitionError
        return true
    }

    destroy(): Promise<void> {
        if (this.destroyPromise) return this.destroyPromise
        this.destroyed = true
        this.destroyPromise = this.destroyNow()
        return this.destroyPromise
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.mailbox.then(operation)
        this.mailbox = result.then(() => undefined, () => undefined)
        return result
    }

    private async runTurn(
        input: AgentQueryInput,
        clientMessageId?: string,
        onAccepted?: () => void,
    ): Promise<GatewayTurnResult> {
        if (this.destroyed) throw new Error('Gateway session runtime is closed.')

        const turnId = this.createId()
        await this.record({ kind: 'user_message', turnId, input, ...(clientMessageId ? { clientMessageId } : {}) })
        await this.transition('querying')
        await this.record({ kind: 'turn', turnId, phase: 'started' })
        this.activeTurnId = turnId
        this.activeAbortController = new AbortController()
        onAccepted?.()

        let status: GatewayTurnStatus = 'success'
        let summary: string | undefined
        try {
            await this.ensureProviderReady(this.activeAbortController.signal)
            if (this.activeAbortController.signal.aborted) {
                status = 'cancelled'
            } else if (!this.config.provider.isReady()) {
                summary = this.config.provider.getInitError() ?? `Provider "${this.config.provider.name}" is not ready.`
                status = 'error'
                await this.recordError('provider_not_ready', summary, turnId)
            } else {
                const model = this.resolveModel(this.model)
                const handle = this.config.provider.startQuery(input, {
                    cwd: this.config.cwd,
                    ...(this.providerSessionId ? { sessionId: this.providerSessionId } : {}),
                    signal: this.activeAbortController.signal,
                    ...(model ? { model } : {}),
                    providerSettings: { ...this.providerSettings },
                    permissionHandler: this.createPermissionHandler(turnId),
                    decisionHandler: {
                        requestDecision: async (request) => {
                            const opened = await this.decisions.open({
                                type: request.type,
                                title: request.title,
                                ...(request.details ? { details: request.details } : {}),
                                options: request.options.map((option, index) => ({
                                    id: `option-${index}`,
                                    label: option.label,
                                    value: option.value,
                                })),
                                turnId,
                            })
                            const resolution = await opened.result
                            return { value: resolution.status === 'resolved' ? String(resolution.value) : 'deny' }
                        },
                    },
                })
                this.activeHandle = handle
                let pendingText: Extract<AgentEvent, { kind: 'text' }> | undefined
                const flushText = async () => {
                    if (!pendingText) return
                    const event = pendingText
                    pendingText = undefined
                    const result = await this.recordProviderEvent(event, turnId)
                    if (result) {
                        status = result.status
                        summary = result.summary
                    }
                }

                for await (const providerEvent of handle.events) {
                    if (this.activeAbortController.signal.aborted) {
                        await flushText()
                        status = 'cancelled'
                        break
                    }
                    if (providerEvent.kind === 'text') {
                        pendingText = pendingText
                            ? { ...pendingText, text: pendingText.text + providerEvent.text }
                            : providerEvent
                        if (pendingText.text.length < 256) continue
                        await flushText()
                        continue
                    }
                    await flushText()
                    const result = await this.recordProviderEvent(providerEvent, turnId)
                    if (result) {
                        status = result.status
                        summary = result.summary
                    }
                }
                await flushText()
            }
            if (this.activeAbortController.signal.aborted) status = 'cancelled'
        } catch (error) {
            if (this.activeAbortController.signal.aborted) {
                status = 'cancelled'
            } else {
                status = 'error'
                summary = errorMessage(error)
                await this.recordError('provider_query_failed', summary, turnId)
            }
        } finally {
            await this.decisions.cancelAll(status === 'cancelled' ? 'Turn cancelled.' : 'Turn ended.')
            this.activeHandle = null
            this.activeAbortController = null
            this.activeTurnId = null
        }

        await this.record({
            kind: 'turn',
            turnId,
            phase: 'finished',
            status,
            ...(summary ? { summary } : {}),
        })
        await this.transition(status === 'error' ? 'error' : 'idle', `turn_${status}`)
        return { turnId, status, ...(summary ? { summary } : {}) }
    }

    private async ensureProviderReady(signal: AbortSignal): Promise<void> {
        if (this.config.provider.isReady()) return
        if (!this.providerInitialization) {
            const initialization = (async () => {
                try {
                    if (this.config.provider.wasReady?.() && this.config.provider.reinit) {
                        await this.config.provider.reinit()
                    } else if (this.config.provider.init) {
                        await this.config.provider.init()
                    }
                } catch {
                    // Providers retain their initialization error. The normal durable
                    // provider_not_ready event below reports it to the client.
                }
            })()
            this.providerInitialization = initialization
            void initialization.finally(() => {
                if (this.providerInitialization === initialization) this.providerInitialization = null
            })
        }
        if (signal.aborted) return
        let abort!: () => void
        const aborted = new Promise<void>(resolve => {
            abort = () => resolve()
            signal.addEventListener('abort', abort, { once: true })
        })
        try {
            await Promise.race([this.providerInitialization, aborted])
        } finally {
            signal.removeEventListener('abort', abort)
        }
    }

    private async recordProviderEvent(
        providerEvent: AgentEvent,
        turnId: string,
    ): Promise<{ status: GatewayTurnStatus; summary?: string } | undefined> {
        if (providerEvent.kind === 'session_init' && providerEvent.sessionId) {
            this.providerSessionId = providerEvent.sessionId
            await this.record({
                kind: 'provider_session',
                provider: this.config.provider.name,
                providerSessionId: providerEvent.sessionId,
                ...(providerEvent.isNewSession !== undefined ? { isNewSession: providerEvent.isNewSession } : {}),
            })
        }

        const semanticEvents = this.adapter.toConversationEvents(providerEvent, {
            sessionId: this.config.sessionId,
            turnId,
            provider: this.config.provider.name,
            sourcePhase: 'live',
        })
        for (const event of semanticEvents) await this.record(event)

        if (providerEvent.kind !== 'result') return undefined
        if (providerEvent.status === 'error') {
            await this.recordError(
                'provider_result_error',
                providerEvent.summary ?? 'Provider reported an unsuccessful turn.',
                turnId,
            )
        }
        return {
            status: providerEvent.status === 'max_turns' ? 'max_turns' : providerEvent.status,
            ...(providerEvent.summary ? { summary: providerEvent.summary } : {}),
        }
    }

    private createPermissionHandler(turnId: string): AgentPermissionHandler {
        return {
            handleToolCall: async (toolName, input, options) => {
                const permissionMode = typeof this.providerSettings.permissionMode === 'string'
                    ? this.providerSettings.permissionMode
                    : 'default'
                if (permissionMode === 'bypassPermissions') return { behavior: 'allow', permanent: true }
                if (permissionMode === 'acceptEdits' && isEditTool(toolName)) {
                    return { behavior: 'allow', permanent: true }
                }
                const request: GatewayDecisionRequest = {
                    type: 'permission',
                    title: `Allow ${toolName}?`,
                    details: formatUnknown(input),
                    options: [
                        { id: 'allow', label: 'Allow', value: 'allow' },
                        { id: 'deny', label: 'Deny', value: 'deny' },
                    ],
                    turnId,
                }
                const opened = await this.decisions.open(request)
                const abort = () => {
                    void this.decisions.cancel(opened.decisionId, 'Tool permission request aborted.')
                }
                options.signal.addEventListener('abort', abort, { once: true })
                if (options.signal.aborted) abort()
                try {
                    const resolution = await opened.result
                    return resolution.status === 'resolved' && resolution.value === 'allow'
                        ? { behavior: 'allow' }
                        : { behavior: 'deny', message: resolution.reason ?? 'Permission denied.' }
                } finally {
                    options.signal.removeEventListener('abort', abort)
                }
            },
            reset: () => undefined,
        }
    }

    private resolveModel(model: string | undefined): string | undefined {
        if (!model) return undefined
        return this.config.provider.resolveModel
            ? this.config.provider.resolveModel(model)
            : model
    }

    private async transition(state: GatewaySessionState, reason?: string): Promise<void> {
        if (state === this.state) return
        const previousState = this.state
        const envelope = await this.append({
            kind: 'state',
            previousState,
            state,
            ...(reason ? { reason } : {}),
        })
        this.state = state
        this.notify(envelope)
    }

    private async recordError(code: string, message: string, turnId?: string): Promise<void> {
        const event: GatewayErrorEvent = {
            kind: 'error',
            code,
            message,
            ...(turnId ? { turnId } : {}),
        }
        await this.record(event)
    }

    private async record(event: GatewayConversationEvent): Promise<void> {
        const envelope = await this.append(event)
        this.notify(envelope)
    }

    private append(event: GatewayConversationEvent): Promise<SessionEventEnvelope<GatewayConversationEvent>> {
        const timestamp = new Date(this.now()).toISOString()
        return this.config.eventStore.append({
            gatewayId: this.config.gatewayId,
            projectId: this.config.projectId,
            sessionId: this.config.sessionId,
            eventId: this.createId(),
            timestamp,
            event,
        })
    }

    private notify(envelope: SessionEventEnvelope<GatewayConversationEvent>): void {
        for (const subscriber of this.subscribers) {
            try {
                subscriber(envelope)
            } catch (error) {
                this.config.onSubscriberError?.(error)
            }
        }
    }

    private async destroyNow(): Promise<void> {
        let firstError: unknown
        try {
            await this.cancel('Session destroyed.')
        } catch (error) {
            firstError = error
        }
        // Queued operations reject independently once destruction begins. Their
        // expected closed-session failures must not make resource cleanup fail.
        await this.mailbox.catch(() => undefined)
        await this.decisions.cancelAll('Session destroyed.').catch((error) => {
            firstError ??= error
        })
        await this.config.provider.destroy?.().catch((error) => {
            firstError ??= error
        })
        await this.transition('closed', 'destroyed').catch((error) => {
            firstError ??= error
            this.state = 'closed'
        })
        this.subscribers.clear()
        if (firstError) throw firstError
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function formatUnknown(value: unknown): string {
    if (typeof value === 'string') return value
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

function isEditTool(toolName: string): boolean {
    return /(?:edit|write|apply.?patch|create|delete|move|rename)/i.test(toolName)
}
