import { randomUUID } from 'node:crypto'
import type { EventBus } from './eventBus'
import type { QueryLoopState, PermissionDecision } from './types'
import type { AgentProvider, AgentQueryHandle, AgentQueryConfig } from '@/providers/provider'
import type { AgentEvent, ProviderCommand } from '@/providers/types'

export type MessageDuringQueryPolicy = 'queue' | 'interrupt'

export interface QueryLoopInput {
    text: string
    chatId?: number
    messageThreadId?: number
    username?: string
}

export interface PendingPermission {
    requestId: string
    resolve: (decision: PermissionDecision) => void
}

export interface QueryLoopConfig {
    cwd: string
    provider: AgentProvider
    bus: EventBus
    model?: string
    providerName?: string
    verboseLevel?: 0 | 1 | 2
    timeoutSeconds?: number
    providerSettings?: Record<string, unknown>
    messageDuringQueryPolicy?: MessageDuringQueryPolicy
}

export class QueryLoop {
    readonly id = randomUUID()
    private _state: QueryLoopState = 'idle'
    private _provider: AgentProvider
    private _bus: EventBus
    private _model: string | null = null
    private _providerName: string
    private _verboseLevel: 0 | 1 | 2 = 1
    private _timeoutSeconds: number = 180
    private _timeoutExtended = false
    providerSettings: Record<string, unknown> = {}
    private _messageDuringQueryPolicy: MessageDuringQueryPolicy = 'queue'

    /** Callback invoked when timeoutSeconds changes, so pipeline can update its TimeoutMiddleware */
    onTimeoutSecondsChange?: (seconds: number) => void
    /** Callback for log messages that should be routed to group logs */
    onLog?: (message: string) => void

    private currentHandle: AgentQueryHandle | null = null
    private currentQueryId: string | null = null
    private messageQueue: QueryLoopInput[] = []
    private pendingPermissions = new Map<string, PendingPermission>()
    private pendingConfig = new Map<string, unknown>()
    private _abortController: AbortController | null = null
    private _availableCommands: ProviderCommand[] = []

    groupChatId: number | null = null
    messageThreadId: number | null = null
    conversationId: string | null = null

    resetRequested = false
    private _permissionHandler: import('@/providers/provider').AgentPermissionHandler | null = null

    get state(): QueryLoopState { return this._state }
    get provider(): AgentProvider { return this._provider }
    get bus(): EventBus { return this._bus }
    get cwd(): string { return this.config.cwd }
    get model(): string | null { return this._model }
    get providerName(): string { return this._providerName }
    get verboseLevel(): 0 | 1 | 2 { return this._verboseLevel }
    get timeoutSeconds(): number { return this._timeoutSeconds }
    get timeoutExtended(): boolean { return this._timeoutExtended }
    get abortController(): AbortController | null { return this._abortController }
    get availableCommands(): ProviderCommand[] { return this._availableCommands }

    constructor(private config: QueryLoopConfig) {
        this._provider = config.provider
        this._bus = config.bus
        this._model = config.model ?? null
        this._providerName = config.providerName ?? 'unknown'
        this._verboseLevel = config.verboseLevel ?? 1
        this._timeoutSeconds = config.timeoutSeconds ?? 180
        this.providerSettings = config.providerSettings ?? {}
        this._messageDuringQueryPolicy = config.messageDuringQueryPolicy ?? 'queue'

        this._bus.emit({ type: 'session.created', sessionId: this.id })
    }

    private transition(from: QueryLoopState, to: QueryLoopState): void {
        if (this._state !== from) {
            throw new Error(`Invalid transition: ${this._state} → ${to} (expected ${from})`)
        }
        this._state = to
        this._bus.emit({ type: 'session.state_changed', sessionId: this.id, from, to })
    }

    setProvider(provider: AgentProvider): void {
        this._provider = provider
    }

    setPermissionHandler(handler: import('@/providers/provider').AgentPermissionHandler | null): void {
        this._permissionHandler = handler
    }

    setModel(model: string): void {
        if (this._state === 'idle') {
            this._model = model
        } else {
            this.pendingConfig.set('model', model)
        }
    }

    setVerboseLevel(level: 0 | 1 | 2): void {
        if (this._state === 'idle') {
            this._verboseLevel = level
        } else {
            this.pendingConfig.set('verboseLevel', level)
        }
    }

    setTimeoutSeconds(seconds: number): void {
        if (this._state === 'idle') {
            this._timeoutSeconds = seconds
            this.onTimeoutSecondsChange?.(seconds)
        } else {
            this.pendingConfig.set('timeoutSeconds', seconds)
        }
    }

    setTimeoutExtended(extended: boolean): void {
        this._timeoutExtended = extended
    }

    setProviderName(name: string): void {
        this._providerName = name
    }

    setConversationId(sid: string | null): void {
        const prev = this.conversationId
        this.conversationId = sid
        this.log(`[QueryLoop] setConversationId: ${prev?.slice(0, 8) ?? 'null'} → ${sid?.slice(0, 8) ?? 'null'} (queryLoop=${this.id.slice(0, 8)})`)
    }

    private log(message: string): void {
        if (this.onLog) {
            this.onLog(message)
        } else {
            console.error(message)
        }
    }

    async processInput(input: QueryLoopInput): Promise<void> {
        this._bus.emit({ type: 'message.incoming', sessionId: this.id, text: input.text })

        if (this._state === 'dead') return

        if (this._state === 'idle') {
            await this.startQuery(input)
        } else if (this._state === 'querying') {
            if (this._messageDuringQueryPolicy === 'interrupt') {
                this.log(`[QueryLoop] Message during query (policy=interrupt): interrupting current query`)
                this.messageQueue.push(input)
                await this.interrupt('replace')
            } else {
                this.messageQueue.push(input)
                this.log(`[QueryLoop] Message during query (policy=queue): queuing message (queue size=${this.messageQueue.length})`)
                this._bus.emit({ type: 'message.queued', sessionId: this.id, text: input.text, queueSize: this.messageQueue.length })
            }
        } else if (this._state === 'canceling') {
            this.messageQueue.push(input)
        }
    }

    async interrupt(reason: 'stop' | 'new' | 'replace'): Promise<void> {
        if (this._state === 'idle' || this._state === 'dead') return
        if (this._state === 'canceling') return

        this.log(`[QueryLoop] Interrupting: reason=${reason}, state=${this._state}`)
        this.transition('querying', 'canceling')

        // Set resetRequested BEFORE awaiting handle.interrupt() to avoid a race:
        // the for-await loop in startQuery may exit during the await and check
        // resetRequested while it is still false.
        if (reason === 'new' || reason === 'stop') {
            this.resetRequested = true
        }

        this.rejectAllPendingPermissions('cancel')

        if (this.currentHandle) {
            try {
                await this.currentHandle.interrupt()
            } catch (e) {
                this.log(`[QueryLoop] interrupt error: ${e instanceof Error ? e.message : e}`)
            }
        }

        if (this._abortController) {
            this._abortController.abort()
        }

        this.transition('canceling', 'idle')
        this.cleanupQuery()

        const nextMsg = this.messageQueue.shift()
        if (nextMsg && reason !== 'stop') {
            await this.startQuery(nextMsg)
        } else {
            this.messageQueue = []
        }
    }

    async destroy(): Promise<void> {
        if (this._state === 'dead') return

        if (this._state === 'querying' || this._state === 'canceling') {
            this.rejectAllPendingPermissions('cancel')
            if (this.currentHandle) {
                try { await this.currentHandle.interrupt() } catch {}
            }
            if (this._abortController) {
                this._abortController.abort()
            }
        }

        const from = this._state
        this._state = 'dead'
        this._bus.emit({ type: 'session.state_changed', sessionId: this.id, from, to: 'dead' })
        this._bus.emit({ type: 'session.destroyed', sessionId: this.id })

        this.cleanupQuery()
        this.messageQueue = []
    }

    resolvePermission(requestId: string, decision: PermissionDecision): boolean {
        const pending = this.pendingPermissions.get(requestId)
        if (!pending) return false
        this.pendingPermissions.delete(requestId)
        pending.resolve(decision)
        this._bus.emit({ type: 'permission.respond', sessionId: this.id, requestId, decision })
        return true
    }

    waitForPermission(requestId: string, toolName: string, input: unknown): Promise<PermissionDecision> {
        return new Promise<PermissionDecision>((resolve) => {
            this.pendingPermissions.set(requestId, { requestId, resolve })
            this._bus.emit({ type: 'permission.request', sessionId: this.id, requestId, toolName, input })
        })
    }

    hasPendingPermissions(): boolean {
        return this.pendingPermissions.size > 0
    }

    private static readonly MAX_RETRIES = 3
    private static readonly RETRYABLE_PATTERNS = [
        'No conversation found',
        'already in use',
        'failed to fetch',
        'fetch failed',
        'ECONNREFUSED',
        'ECONNRESET',
        'ETIMEDOUT',
        'network',
        'NetworkError',
    ]

    private isRetryableError(summary: string): boolean {
        return QueryLoop.RETRYABLE_PATTERNS.some(p =>
            summary.toLowerCase().includes(p.toLowerCase())
        )
    }

    private clearConversation(): void {
        this.log(`[QueryLoop] clearConversation: was=${this.conversationId?.slice(0, 8) ?? 'null'} (queryLoop=${this.id.slice(0, 8)})`)
        this.conversationId = null
    }

    private async startQuery(input: QueryLoopInput): Promise<void> {
        this.applyPendingConfig()
        this.transition('idle', 'querying')

        const queryId = randomUUID()
        this.currentQueryId = queryId
        this._abortController = new AbortController()

        this.log(`[QueryLoop] startQuery: queryLoop=${this.id.slice(0, 8)} conversationId=${this.conversationId?.slice(0, 8) ?? 'null'} input="${input.text.slice(0, 50)}"`)

        this._bus.emit({ type: 'query.started', sessionId: this.id, queryId })

        let retryCount = 0
        let currentInput = input

        while (retryCount <= QueryLoop.MAX_RETRIES) {
            let shouldRetry = false
            let retryExhausted = false

            try {
                const queryConfig: AgentQueryConfig = {
                    cwd: this.config.cwd,
                    sessionId: this.conversationId ?? undefined,
                    model: this._model ?? undefined,
                    signal: this._abortController.signal,
                    permissionHandler: this._permissionHandler ?? undefined,
                    providerSettings: { ...this.providerSettings },
                }
                const handle = this._provider.startQuery(currentInput.text, queryConfig)
                this.currentHandle = handle

                let lastResultStatus: 'success' | 'error' | 'max_turns' | null = null
                try {
                    for await (const event of handle.events) {
                        if (this._state === 'canceling' || this._state === 'dead') break

                        if (event.kind === 'session_init' && event.sessionId) {
                            this.conversationId = event.sessionId
                        }

                        if (event.kind === 'commands_update') {
                            this._availableCommands = event.commands
                        }

                        if (event.kind === 'result') {
                            lastResultStatus = event.status
                            if (event.status === 'error' && event.summary) {
                                if (this.isRetryableError(event.summary)) {
                                    if (retryCount < QueryLoop.MAX_RETRIES) {
                                        shouldRetry = true
                                        this.clearConversation()
                                        this._bus.emit({ type: 'query.event', sessionId: this.id, queryId, event })
                                        break
                                    }
                                    this._bus.emit({ type: 'query.event', sessionId: this.id, queryId, event })
                                    retryExhausted = true
                                    break
                                }
                            }
                        }

                        this._bus.emit({ type: 'query.event', sessionId: this.id, queryId, event })
                    }
                    this.log(`[QueryLoop] Event loop exited: state=${this._state}, shouldRetry=${shouldRetry}, retryExhausted=${retryExhausted}`)
                } finally {
                    if (!shouldRetry) {
                        if (this._state === 'querying') {
                            this.transition('querying', 'idle')
                        } else if (this._state === 'canceling') {
                            this.transition('canceling', 'idle')
                        }
                    }
                }

                if (shouldRetry) {
                    retryCount++
                    this.log(`[QueryLoop] Retryable error, clearing session and retrying (${retryCount}/${QueryLoop.MAX_RETRIES})...`)
                    continue
                }

                if (retryExhausted) {
                    this._bus.emit({
                        type: 'query.error',
                        sessionId: this.id,
                        queryId,
                        error: new Error('Too many consecutive retries. Try /new to start a fresh session.')
                    })
                    // Clear conversationId so next query starts fresh
                    // instead of trying to resume a broken session
                    this.clearConversation()
                    break
                }

                // Emit query.error if the stream ended with an error result,
                // or if the stream ended without a result event (abnormal termination).
                // Exception: if resetRequested (user cancelled via /new or /stop),
                // treat as cancelled rather than an error.
                if (lastResultStatus === 'error' && !this.resetRequested) {
                    this._bus.emit({
                        type: 'query.error',
                        sessionId: this.id,
                        queryId,
                        error: new Error('Agent returned an error result'),
                    })
                    this.clearConversation()
                } else if (lastResultStatus === null && !this.resetRequested) {
                    this._bus.emit({
                        type: 'query.error',
                        sessionId: this.id,
                        queryId,
                        error: new Error('Agent stream ended without a result (possible connection loss)'),
                    })
                    this.clearConversation()
                } else {
                    this._bus.emit({
                        type: 'query.completed', sessionId: this.id, queryId,
                        result: { status: this.resetRequested ? 'cancelled' : 'success' }
                    })
                }
                break
            } catch (e) {
                const errMsg = e instanceof Error ? e.message : String(e)
                if (this.isRetryableError(errMsg) && retryCount < QueryLoop.MAX_RETRIES) {
                    retryCount++
                    this.clearConversation()
                    this.log(`[QueryLoop] Retryable exception, clearing session and retrying (${retryCount}/${QueryLoop.MAX_RETRIES}): ${errMsg}`)
                    continue
                }

                if (this._state === 'querying') {
                    this.transition('querying', 'idle')
                } else if (this._state === 'canceling') {
                    this.transition('canceling', 'idle')
                }
                // Clear conversationId on unrecoverable error so
                // the next query starts fresh instead of resuming a broken session.
                // This also prevents a restarted codever from loading a stuck session.
                this.clearConversation()
                this._bus.emit({ type: 'query.error', sessionId: this.id, queryId, error: e })
                break
            }
        }

        if (retryCount > QueryLoop.MAX_RETRIES && this._state === 'querying') {
            this.transition('querying', 'idle')
            this._bus.emit({ type: 'query.error', sessionId: this.id, queryId, error: new Error('Too many consecutive retries. Try /new to start a fresh session.') })
        }

        this.cleanupQuery()
        this.resetRequested = false

        const nextMsg = this.messageQueue.shift()
        if (nextMsg && this._state === 'idle') {
            await this.startQuery(nextMsg)
        }
    }

    private cleanupQuery(): void {
        this.currentHandle = null
        this.currentQueryId = null
        this._abortController = null
    }

    private applyPendingConfig(): void {
        if (this.pendingConfig.has('model')) {
            this._model = this.pendingConfig.get('model') as string
            this.pendingConfig.delete('model')
        }
        if (this.pendingConfig.has('verboseLevel')) {
            this._verboseLevel = this.pendingConfig.get('verboseLevel') as 0 | 1 | 2
            this.pendingConfig.delete('verboseLevel')
        }
        if (this.pendingConfig.has('timeoutSeconds')) {
            this._timeoutSeconds = this.pendingConfig.get('timeoutSeconds') as number
            this.pendingConfig.delete('timeoutSeconds')
            this.onTimeoutSecondsChange?.(this._timeoutSeconds)
        }
    }

    private rejectAllPendingPermissions(decision: PermissionDecision): void {
        for (const [id, pending] of this.pendingPermissions) {
            pending.resolve(decision)
            this._bus.emit({ type: 'permission.respond', sessionId: this.id, requestId: id, decision })
        }
        this.pendingPermissions.clear()
    }
}
