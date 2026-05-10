import { randomUUID } from 'node:crypto'
import type { ChannelPort, ChannelMessage, SessionStatus } from '@/bridge/channelPort'
import type { AgentPermissionHandler, AgentProvider, AgentQueryHandle } from '@/providers/provider'
import type { ConversationEvent, SessionInput } from './semantic'
import { ConversationJournal } from './semantic'
import { ChannelProjector } from './channelProjector'
import { DeliveryOutbox } from './deliveryOutbox'
import { createProviderSemanticAdapter, type ProviderSemanticAdapter } from './providerAdapter'
import { createProviderInstance, getProvider } from '@/providers/registry'

export type SemanticRuntimeState = 'idle' | 'querying' | 'canceling' | 'finalizing' | 'dead'

export interface SemanticSessionRuntimeConfig {
    sessionId: string
    cwd: string
    provider: AgentProvider
    providerName: string
    channelPort: ChannelPort
    model?: string | null
    providerSessionId?: string | null
    providerSettings?: Record<string, unknown>
    adapter?: ProviderSemanticAdapter
    projector?: ChannelProjector
    outbox?: DeliveryOutbox
    onLog?: (message: string) => void
    onProviderSessionId?: (sessionId: string) => void
    onProviderChanged?: (providerName: string, provider: AgentProvider) => void
}

export class SemanticSessionRuntime {
    readonly journal = new ConversationJournal()
    private state: SemanticRuntimeState = 'idle'
    private mailbox: Promise<void> = Promise.resolve()
    private adapter: ProviderSemanticAdapter
    private projector: ChannelProjector
    private outbox: DeliveryOutbox
    private abortController: AbortController | null = null
    private currentHandle: AgentQueryHandle | null = null
    private toolMessageIds = new Map<string, string | number>()
    private lastToolName: string | null = null
    private turnStartedAt = 0
    private recentTables: string[] = []
    private availableCommands: Array<Record<string, unknown>> = []
    private lastConfigOptions: Array<Record<string, unknown>> = []

    constructor(private config: SemanticSessionRuntimeConfig) {
        this.adapter = config.adapter ?? createProviderSemanticAdapter(config.providerName)
        this.projector = config.projector ?? new ChannelProjector()
        this.outbox = config.outbox ?? new DeliveryOutbox({
            channelPort: config.channelPort,
            onFailure: (record) => {
                this.log(`[delivery] ${record.kind} failed: ${record.error instanceof Error ? record.error.message : record.error}`)
                this.recordCommand(record.kind === 'edit' ? 'delivery_edit_failed' : 'delivery_failed', {
                    message: record.error instanceof Error ? record.error.message : String(record.error),
                    deliveryId: record.id,
                    text: record.message.text,
                })
            },
        })
    }

    dispatch(input: SessionInput): Promise<void> {
        if (input.kind === 'cancel') {
            return this.cancel()
        }

        if (input.kind === 'command' && input.name === 'progress') {
            return this.handleProgressCommand()
        }

        if ((input.kind === 'user_message' || input.kind === 'scheduled_message') && (this.state === 'querying' || this.state === 'finalizing')) {
            void this.send({ text: '📨 Agent is working. Your message has been queued and will be processed when the current task completes.', format: 'html' })
        }

        this.mailbox = this.mailbox.then(() => this.handleInput(input))
        return this.mailbox
    }

    async destroy(): Promise<void> {
        await this.mailbox
        if (this.currentHandle) {
            try { await this.currentHandle.interrupt() } catch {}
        }
        this.abortController?.abort()
        this.state = 'dead'
        await this.outbox.drain()
    }

    getState(): SemanticRuntimeState {
        return this.state
    }

    private async handleInput(input: SessionInput): Promise<void> {
        if (this.state === 'dead') return

        switch (input.kind) {
            case 'user_message':
                await this.runTurn(input.text)
                break
            case 'scheduled_message':
                await this.runTurn(input.text)
                break
            case 'cancel':
                await this.cancel()
                break
            case 'command':
                await this.handleCommand(input)
                break
            case 'decision_response':
                this.recordCommand('decision_response', { decisionId: input.decisionId, value: input.value, source: input.source })
                break
        }
    }

    private async runTurn(prompt: string): Promise<void> {
        if (!this.config.provider.isReady()) {
            await this.handleProviderNotReady()
            if (!this.config.provider.isReady()) return
        }

        const turnId = randomUUID()
        this.state = 'querying'
        this.turnStartedAt = Date.now()
        this.lastToolName = null
        this.projector.reset()
        this.toolMessageIds.clear()
        this.notifyStatus('querying')
        this.record({
            kind: 'turn_started',
            meta: this.syntheticMeta(turnId, 'turn_started', 0),
        })

        this.abortController = new AbortController()
        const handle = this.config.provider.startQuery(prompt, {
            cwd: this.config.cwd,
            sessionId: this.config.providerSessionId ?? undefined,
            signal: this.abortController.signal,
            model: this.config.model ?? undefined,
            permissionHandler: this.createPermissionHandler(),
            providerSettings: this.config.providerSettings ?? {},
            debugLog: (line) => this.log(line),
        })
        this.currentHandle = handle

        let seenResult = false
        try {
            for await (const providerEvent of handle.events) {
                if (this.isStopping()) break
                if (providerEvent.kind === 'session_init' && providerEvent.sessionId) {
                    this.config.providerSessionId = providerEvent.sessionId
                    this.config.onProviderSessionId?.(providerEvent.sessionId)
                }
                if (providerEvent.kind === 'tool_use') {
                    this.lastToolName = providerEvent.toolName
                }
                const semanticEvents = this.adapter.toConversationEvents(providerEvent, {
                    sessionId: this.config.sessionId,
                    turnId,
                    provider: this.config.providerName,
                    sourcePhase: seenResult ? 'tailDrain' : 'live',
                })
                for (const event of semanticEvents) {
                    this.record(event)
                    await this.projectAndDeliver(event)
                    if (event.kind === 'turn_finished') {
                        seenResult = true
                    }
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.record({
                kind: 'turn_finished',
                meta: this.syntheticMeta(turnId, 'error', Number.MAX_SAFE_INTEGER),
                status: 'error',
                summary: message,
            })
            await this.send({ text: `❌ Error: ${message}`, format: 'html' })
        } finally {
            await this.finalize()
            this.currentHandle = null
            this.abortController = null
        }
    }

    private async cancel(): Promise<void> {
        if (this.state !== 'querying') return
        this.state = 'canceling'
        await this.currentHandle?.interrupt()
        this.abortController?.abort()
    }

    private isStopping(): boolean {
        return this.state === 'canceling' || this.state === 'dead'
    }

    private async finalize(): Promise<void> {
        if (this.state === 'dead') return
        this.state = 'finalizing'
        for (const projected of this.projector.flush()) {
            await this.deliver(projected.message, projected.toolUseId, projected.isToolEvent)
        }
        await this.outbox.drain()
        this.state = 'idle'
        this.notifyStatus('idle')
    }

    private record(event: ConversationEvent): void {
        this.journal.append(event)
    }

    private async projectAndDeliver(event: ConversationEvent): Promise<void> {
        // Record available_commands_update and config_option_update to session state
        if (event.kind === 'command_result') {
            const commandLower = event.command.toLowerCase()
            if (commandLower.includes('available_commands') || commandLower.includes('commands_update')) {
                const commands = Array.isArray(event.output) ? event.output as Array<Record<string, unknown>> : []
                this.availableCommands = commands
                this.log(`[session] Updated available commands: ${commands.length} commands`)
            }
            if (commandLower.includes('config_option')) {
                // Extract config options from output
                let configArray: Array<Record<string, unknown>> = []
                if (Array.isArray(event.output)) {
                    configArray = event.output as Array<Record<string, unknown>>
                } else if (event.output && typeof event.output === 'object') {
                    const record = event.output as Record<string, unknown>
                    const options = record.configOptions ?? record.options ?? record.config
                    if (Array.isArray(options)) {
                        configArray = options as Array<Record<string, unknown>>
                    }
                }
                this.lastConfigOptions = configArray
                this.log(`[session] Updated config options: ${configArray.length} options`)
            }
        }

        const messages = this.projector.project(event, { verboseLevel: this.getVerboseLevel() })
        for (const projected of messages) {
            this.captureTables(projected.message)
            await this.deliver(projected.message, projected.toolUseId, projected.isToolEvent)
        }
    }

    private getVerboseLevel(): 0 | 1 | 2 {
        const value = this.config.providerSettings?.verboseLevel
        return value === 0 || value === 1 || value === 2 ? value : 1
    }

    private async deliver(message: ChannelMessage, toolUseId?: string, isToolEvent = false): Promise<void> {
        if (isToolEvent && toolUseId && this.toolMessageIds.has(toolUseId)) {
            const record = await this.outbox.edit(this.toolMessageIds.get(toolUseId), message, true)
            if (record.messageId !== undefined) {
                this.toolMessageIds.set(toolUseId, record.messageId)
            }
            if (record.status === 'sent' && record.messageId !== undefined) {
                this.toolMessageIds.set(toolUseId, record.messageId)
            }
            return
        }

        const record = await this.outbox.send(message)
        if (isToolEvent && toolUseId && record.messageId !== undefined) {
            this.toolMessageIds.set(toolUseId, record.messageId)
        }
    }

    private async send(message: ChannelMessage): Promise<void> {
        this.captureTables(message)
        await this.outbox.send(message)
    }

    private async handleCommand(input: Extract<SessionInput, { kind: 'command' }>): Promise<void> {
        const name = input.name
        const args = input.args?.trim()

        switch (name) {
            case 'model':
                this.config.model = args || null
                this.recordCommand('model', { model: this.config.model })
                return
            case 'timeout': {
                const timeoutSeconds = Number.parseInt(args ?? '', 10)
                this.config.providerSettings = { ...(this.config.providerSettings ?? {}), timeoutSeconds }
                this.recordCommand('timeout', { timeoutSeconds })
                return
            }
            case 'permissionMode':
            case 'mode':
                this.config.providerSettings = { ...(this.config.providerSettings ?? {}), permissionMode: args }
                this.recordCommand(name, { permissionMode: args })
                return
            case 'verbose': {
                const verboseLevel = Number.parseInt(args ?? '', 10)
                this.config.providerSettings = { ...(this.config.providerSettings ?? {}), verboseLevel }
                this.recordCommand('verbose', { verboseLevel })
                return
            }
            case 'provider': {
                const providerName = args || this.config.providerName
                const provider = createProviderInstance(providerName) ?? getProvider(providerName)
                if (!provider) {
                    this.recordCommand('provider', { providerName, error: 'Provider not found' })
                    await this.send({ text: `❌ Provider not found: ${providerName}`, format: 'html' })
                    return
                }
                if (provider !== this.config.provider) {
                    await this.config.provider.destroy?.()
                }
                this.config.provider = provider
                this.config.providerName = providerName
                this.config.providerSessionId = null
                this.adapter = createProviderSemanticAdapter(providerName)
                this.config.onProviderChanged?.(providerName, provider)
                this.recordCommand('provider', { providerName: this.config.providerName })
                return
            }
            case 'resume':
                this.config.providerSessionId = args || null
                this.recordCommand('resume', { sessionId: this.config.providerSessionId })
                return
            case 'cwd':
                if (args) this.config.cwd = args
                this.recordCommand('cwd', { cwd: this.config.cwd })
                return
            case 'archive':
                this.recordCommand('archive', { archived: true })
                this.state = 'dead'
                await this.currentHandle?.interrupt()
                this.abortController?.abort()
                return
            case 'new':
                this.config.providerSessionId = null
                this.config.provider.clearSessionId?.()
                this.recordCommand('new', { reset: true })
                return
            case 'timeout_continue':
                this.recordCommand('timeout_continue', { continued: true })
                return
            case 'send_message':
                this.recordCommand('send_message', { message: args ?? '' })
                await this.send({ text: args ?? '', format: 'html' })
                return
            case 'progress':
                await this.handleProgressCommand()
                return
            case 'tables': {
                const channelTables = this.getChannelTables()
                const tables = channelTables.length > 0 ? channelTables : this.recentTables
                this.recordCommand('tables', { tables })
                return
            }
            default:
                this.recordCommand(name, { args })
        }
    }

    private async handleProgressCommand(): Promise<void> {
        const elapsedSeconds = this.turnStartedAt ? Math.floor((Date.now() - this.turnStartedAt) / 1000) : 0
        this.recordCommand('progress', { state: this.state, elapsedSeconds, lastToolName: this.lastToolName })
        await this.send({
            text: this.state === 'querying'
                ? `🔄 Task in progress: ${elapsedSeconds}s elapsed${this.lastToolName ? `\nCurrent tool: ${this.lastToolName}` : ''}`
                : '✅ No active task',
            format: 'html',
        })
    }

    private createPermissionHandler(): AgentPermissionHandler {
        return {
            handleToolCall: async (toolName, input, options) => {
                const response = await this.config.channelPort.requestDecision({
                    type: 'permission',
                    title: `Allow ${toolName}?`,
                    details: formatUnknown(input),
                    options: [
                        { label: 'Allow', value: 'allow' },
                        { label: 'Deny', value: 'deny' },
                    ],
                })
                if (options.signal.aborted) return { behavior: 'deny', message: 'aborted' }
                return { behavior: response.value === 'deny' ? 'deny' : 'allow' }
            },
            reset: () => {},
        }
    }

    private recordCommand(command: string, output: unknown): void {
        this.record({
            kind: 'command_result',
            meta: this.syntheticMeta(randomUUID(), `command:${command}:${randomUUID()}`, 0),
            command,
            output,
        })
    }

    private captureTables(message: ChannelMessage): void {
        if (message.format !== 'markdown') return
        if (!/\|.+\|/.test(message.text)) return
        this.recentTables.push(message.text)
    }

    private getChannelTables(): string[] {
        const port = this.config.channelPort as unknown as { getRecentTables?: () => Array<{ markdown: string }> }
        return port.getRecentTables?.().map(table => table.markdown) ?? []
    }

    private async handleProviderNotReady(): Promise<void> {
        if (this.config.provider.wasReady?.() && this.config.provider.reinit) {
            await this.send({ text: '⚠️ Agent process crashed, reconnecting...', format: 'html' })
            try {
                await this.config.provider.reinit()
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                await this.send({ text: `❌ Agent could not restart: ${message}. Use /new to start a fresh session.`, format: 'html' })
                return
            }
            if (!this.config.provider.isReady()) {
                const err = this.config.provider.getInitError() ?? 'Reconnection failed'
                await this.send({ text: `❌ Agent could not restart: ${err}. Use /new to start a fresh session.`, format: 'html' })
                return
            }
            await this.send({ text: '✅ Agent reconnected', format: 'html' })
            return
        }

        if ('init' in this.config.provider && typeof (this.config.provider as any).init === 'function') {
            await this.send({ text: '⏳ Agent is starting up, please wait...', format: 'html' })
            try {
                await (this.config.provider as any).init()
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                await this.send({ text: `❌ Provider "${this.config.provider.name}" is not available: ${message}`, format: 'html' })
                return
            }
            if (!this.config.provider.isReady()) {
                const err = this.config.provider.getInitError() ?? 'Initialization failed'
                await this.send({ text: `❌ Provider "${this.config.provider.name}" is not available: ${err}`, format: 'html' })
            }
            return
        }

        const err = this.config.provider.getInitError() ?? 'Provider not available'
        await this.send({ text: `❌ Provider "${this.config.provider.name}" is not available: ${err}`, format: 'html' })
    }

    private notifyStatus(state: SessionStatus['state']): void {
        this.config.channelPort.notifyStatus({
            state,
            model: this.config.model ?? undefined,
            cwd: this.config.cwd,
            provider: this.config.providerName,
        })
    }

    private syntheticMeta(turnId: string, id: string, seq: number) {
        return {
            id: `${turnId}:${id}`,
            sessionId: this.config.sessionId,
            turnId,
            provider: this.config.providerName,
            seq,
            timestamp: Date.now(),
            sourcePhase: 'synthetic' as const,
        }
    }

    private log(message: string): void {
        this.config.onLog?.(message)
    }
}

function formatUnknown(value: unknown): string {
    if (typeof value === 'string') return value
    try {
        return JSON.stringify(value, null, 2)
    } catch {
        return String(value)
    }
}
