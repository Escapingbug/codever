import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChannelPort, ChannelMessage, SessionStatus } from '@/bridge/channelPort'
import type { AgentPermissionHandler, AgentProvider, AgentQueryHandle } from '@/providers/provider'
import type { AgentEvent } from '@/providers/types'
import type { ConversationEvent, RichFilePart, RichUserInput, SessionInput } from './semantic'
import { normalizeUserInput } from './semantic'
import { ConversationJournal } from './semantic'
import { ChannelProjector } from './channelProjector'
import { DeliveryOutbox, type DeliveryOutboxState, type DeliveryOptions, type DeliveryRecord } from './deliveryOutbox'
import { createProviderSemanticAdapter, type ProviderSemanticAdapter } from './providerAdapter'
import { createProviderInstance, getProvider } from '@/providers/registry'
import type { ProviderCommand } from '@/providers/types'
import { escapeHtml } from '@/utils/formatting'

export type SemanticRuntimeState = 'idle' | 'querying' | 'canceling' | 'finalizing' | 'dead'

const FILE_REFERENCE_PATTERN = /file:\/\/[^\s<>"'`()\[\],]+/g
const MAX_FILE_REFERENCES = 20
const MAX_READ_FILE_BYTES = 128 * 1024
const MAX_SEND_FILE_BYTES = 50 * 1024 * 1024
const DEFAULT_DESTROY_TIMEOUT_MS = 10_000
const DESTROY_INTERRUPT_TIMEOUT_MS = 2_500
const DESTROY_OUTBOX_DRAIN_TIMEOUT_MS = 3_000
const FINALIZE_OUTBOX_DRAIN_TIMEOUT_MS = 5_000
const ASSISTANT_TEXT_FLUSH_DEBOUNCE_MS = 1_500
const TERMINAL_TOOL_EDIT_GRACE_MS = ASSISTANT_TEXT_FLUSH_DEBOUNCE_MS + 500

export interface RuntimeProgress {
    state: SemanticRuntimeState
    elapsedSeconds: number
    lastToolName: string | null
    outbox: DeliveryOutboxState
}

interface FileReference {
    id: string
    uri: string
    path: string
}

async function waitForShutdownStep(
    promise: Promise<unknown>,
    timeoutMs: number,
    onTimeoutOrError: (message: string) => void,
): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
        await Promise.race([
            promise,
            new Promise((resolve) => {
                timeout = setTimeout(() => resolve('timeout'), timeoutMs)
            }),
        ]).then((result) => {
            if (result === 'timeout') {
                onTimeoutOrError(`timed out after ${timeoutMs}ms`)
            }
        })
    } catch (e) {
        onTimeoutOrError(e instanceof Error ? e.message : String(e))
    } finally {
        if (timeout) clearTimeout(timeout)
    }
}

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
    onModelChanged?: (model: string | null) => void
    onAvailableCommands?: (commands: ProviderCommand[]) => void
    destroyTimeoutMs?: number
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
    private startingMessageId: string | number | null = null
    private lastToolName: string | null = null
    private turnStartedAt = 0
    private recentTables: string[] = []
    private availableCommands: ProviderCommand[] = []
    private lastConfigOptions: Array<Record<string, unknown>> = []
    private pendingCodeverSendFileCalls = new Map<string, string>()
    private fileReferences = new Map<string, FileReference>()
    private fileReferenceIdsByUri = new Map<string, string>()
    private nextFileReferenceNumber = 1
    private textFlushTimer: ReturnType<typeof setTimeout> | null = null
    private textFlushChain: Promise<void> = Promise.resolve()
    private textFlushGeneration = 0

    constructor(private config: SemanticSessionRuntimeConfig) {
        this.adapter = config.adapter ?? createProviderSemanticAdapter(config.providerName)
        this.projector = config.projector ?? new ChannelProjector()
        this.outbox = config.outbox ?? new DeliveryOutbox({
            channelPort: config.channelPort,
            onLog: (message) => this.log(message),
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

        if (input.kind === 'command' && input.name === 'new' && this.isActiveTurnState()) {
            return this.resetActiveConversation()
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
        this.state = 'dead'
        this.abortController?.abort()
        if (this.currentHandle) {
            await waitForShutdownStep(
                this.currentHandle.interrupt(),
                DESTROY_INTERRUPT_TIMEOUT_MS,
                (message) => this.log(`[destroy] interrupt timeout/error: ${message}`),
            )
        }
        await waitForShutdownStep(
            this.mailbox,
            this.config.destroyTimeoutMs ?? DEFAULT_DESTROY_TIMEOUT_MS,
            (message) => this.log(`[destroy] mailbox timeout/error: ${message}`),
        )
        await waitForShutdownStep(
            this.flushBufferedAssistantText('destroy'),
            DESTROY_OUTBOX_DRAIN_TIMEOUT_MS,
            (message) => this.log(`[destroy] text flush timeout/error: ${message}`),
        )
        await waitForShutdownStep(
            this.outbox.drain(),
            DESTROY_OUTBOX_DRAIN_TIMEOUT_MS,
            (message) => this.log(`[destroy] outbox drain timeout/error: ${message}`),
        )
    }

    getState(): SemanticRuntimeState {
        return this.state
    }

    getProgress(): RuntimeProgress {
        return {
            state: this.state,
            elapsedSeconds: this.turnStartedAt ? Math.floor((Date.now() - this.turnStartedAt) / 1000) : 0,
            lastToolName: this.lastToolName,
            outbox: this.outbox.getState(),
        }
    }

    private async handleInput(input: SessionInput): Promise<void> {
        if (this.state === 'dead') return

        switch (input.kind) {
            case 'user_message':
                await this.runTurn(input.richInput ?? input.text)
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

    private async runTurn(prompt: string | RichUserInput): Promise<void> {
        if (!this.config.provider.isReady()) {
            await this.handleProviderNotReady()
            if (!this.config.provider.isReady()) return
        }

        await this.flushBufferedAssistantText('pre-turn')
        const turnId = randomUUID()
        this.state = 'querying'
        this.turnStartedAt = Date.now()
        this.lastToolName = null
        this.pendingCodeverSendFileCalls.clear()
        this.projector.reset()
        this.toolMessageIds.clear()
        this.notifyStatus('querying')
        this.record({
            kind: 'turn_started',
            meta: this.syntheticMeta(turnId, 'turn_started', 0),
        })

        this.abortController = new AbortController()
        const activeModel = this.getActiveModel()
        const handle = this.config.provider.startQuery(this.prepareProviderInput(prompt), {
            cwd: this.config.cwd,
            sessionId: this.config.providerSessionId ?? undefined,
            signal: this.abortController.signal,
            ...(activeModel ? { model: activeModel } : {}),
            permissionHandler: this.createPermissionHandler(),
            decisionHandler: {
                requestDecision: (request) => this.config.channelPort.requestDecision(request),
            },
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
                if (providerEvent.kind === 'commands_update') {
                    this.availableCommands = providerEvent.commands
                    this.config.onAvailableCommands?.(providerEvent.commands)
                }
                if (providerEvent.kind === 'tool_use') {
                    this.lastToolName = providerEvent.toolName
                }
                if (await this.handleCodeverSendFileIdentityFallback(providerEvent)) {
                    continue
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
        const handle = this.currentHandle
        const abortController = this.abortController
        this.state = 'canceling'
        const interrupting = handle?.interrupt()
        abortController?.abort()
        await interrupting
    }

    private async resetActiveConversation(): Promise<void> {
        const handle = this.currentHandle
        const abortController = this.abortController
        this.config.providerSessionId = null
        this.config.provider.clearSessionId?.()
        this.recordCommand('new', { reset: true })

        this.state = 'canceling'
        const interrupting = handle?.interrupt()
        abortController?.abort()
        await interrupting

        // A /new during an active turn is a recovery action. If the provider
        // ignored cancel, restart its subprocess so the next turn is not
        // blocked behind the stuck ACP request.
        try {
            await this.config.provider.destroy?.()
        } catch (error) {
            this.log(`[session] Provider destroy during /new failed: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    private isActiveTurnState(): boolean {
        return this.state === 'querying' || this.state === 'canceling' || this.state === 'finalizing'
    }

    private prepareProviderInput(input: string | RichUserInput): string | RichUserInput {
        if (typeof input === 'string') return input

        const normalized = normalizeUserInput(input)
        const fileParts = normalized.parts.filter((part): part is RichFilePart => part.type === 'file')
        if (fileParts.length === 0) return normalized

        return {
            parts: [
                { type: 'text', text: formatUploadedFileReferenceText(fileParts) },
                ...normalized.parts.filter(part => part.type !== 'file'),
            ],
        }
    }

    private isStopping(): boolean {
        return this.state === 'canceling' || this.state === 'dead'
    }

    private async finalize(): Promise<void> {
        if (this.state === 'dead') return
        this.state = 'finalizing'
        await this.flushBufferedAssistantText('finalize')
        await this.outbox.drain({ timeoutMs: FINALIZE_OUTBOX_DRAIN_TIMEOUT_MS })
        this.state = 'idle'
        this.notifyStatus('idle')
    }

    private record(event: ConversationEvent): void {
        this.journal.append(event)
    }

    private async projectAndDeliver(event: ConversationEvent): Promise<void> {
        if (event.kind !== 'assistant_text_delta') {
            this.cancelScheduledTextFlush()
        }

        // Record available_commands_update and config_option_update to session state
        if (event.kind === 'command_result') {
            const commandLower = event.command.toLowerCase()
            if (commandLower.includes('available_commands') || commandLower.includes('commands_update')) {
                const commands = Array.isArray(event.output) ? event.output as ProviderCommand[] : []
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
        if (event.kind === 'assistant_text_delta') {
            this.scheduleAssistantTextFlush()
        }
        for (const projected of messages) {
            const message = this.withFileReferenceHints(projected.message, projected.semanticEvent)
            this.captureTables(message)
            await this.deliver(message, projected.toolUseId, projected.isToolEvent, projected.isTerminal)
        }
    }

    private scheduleAssistantTextFlush(): void {
        this.cancelScheduledTextFlush()
        const generation = this.textFlushGeneration
        this.textFlushTimer = setTimeout(() => {
            if (generation !== this.textFlushGeneration) return
            void this.flushBufferedAssistantText('debounce', generation)
        }, ASSISTANT_TEXT_FLUSH_DEBOUNCE_MS)
    }

    private cancelScheduledTextFlush(): void {
        if (this.textFlushTimer) {
            clearTimeout(this.textFlushTimer)
            this.textFlushTimer = null
        }
        this.textFlushGeneration += 1
    }

    private async flushBufferedAssistantText(reason: string, generation = this.textFlushGeneration): Promise<void> {
        if (generation !== this.textFlushGeneration) return this.textFlushChain
        this.cancelScheduledTextFlush()
        this.textFlushChain = this.textFlushChain.then(async () => {
            const projectedMessages = this.projector.flush()
            if (projectedMessages.length > 0 && reason !== 'finalize') {
                this.log(`[session] Flushing buffered assistant text: reason=${reason} messages=${projectedMessages.length}`)
            }
            for (const projected of projectedMessages) {
                const message = this.withFileReferenceHints(projected.message, projected.semanticEvent)
                this.captureTables(message)
                await this.deliver(message, projected.toolUseId, projected.isToolEvent, projected.isTerminal)
            }
        })
        return this.textFlushChain
    }

    private getVerboseLevel(): 0 | 1 | 2 {
        const value = this.config.providerSettings?.verboseLevel
        return value === 0 || value === 1 || value === 2 ? value : 1
    }

    private getActiveModel(): string | undefined {
        const model = this.config.model ?? undefined
        if (!model) return undefined
        if (typeof this.config.provider.getAvailableModels !== 'function') return model
        const availableModels = this.config.provider.getAvailableModels()
        if (availableModels.length === 0) return undefined
        return availableModels.some(entry => entry.id === model || entry.name === model) ? model : undefined
    }

    private async deliver(message: ChannelMessage, toolUseId?: string, isToolEvent = false, isTerminal = false): Promise<void> {
        if (isToolEvent && toolUseId && this.toolMessageIds.has(toolUseId)) {
            const delivery = this.outbox.edit(this.toolMessageIds.get(toolUseId), message, isTerminal, {
                lane: 'progressive-edit',
                coalesceKey: toolUseId,
                terminal: isTerminal,
            })
            const record = isTerminal ? await waitForDeliveryRecord(delivery, TERMINAL_TOOL_EDIT_GRACE_MS) : undefined
            if (record?.messageId !== undefined) {
                this.toolMessageIds.set(toolUseId, record.messageId)
                return
            }

            void delivery.then((record) => {
                if (record.messageId !== undefined) {
                    this.toolMessageIds.set(toolUseId, record.messageId)
                }
            })
            return
        }

        const record = await this.outbox.send(message)
        if (isToolEvent && toolUseId && record.messageId !== undefined) {
            this.toolMessageIds.set(toolUseId, record.messageId)
        }
    }

    private async send(message: ChannelMessage, options: DeliveryOptions = {}): Promise<void> {
        this.captureTables(message)
        await this.outbox.send(message, undefined, options)
    }

    private async handleCommand(input: Extract<SessionInput, { kind: 'command' }>): Promise<void> {
        const name = input.name
        const args = input.args?.trim()

        switch (name) {
            case 'model':
                this.config.model = args || null
                this.config.onModelChanged?.(this.config.model)
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
                this.config.model = null
                this.adapter = createProviderSemanticAdapter(providerName)
                this.config.onProviderChanged?.(providerName, provider)
                this.config.onModelChanged?.(null)
                this.recordCommand('provider', { providerName: this.config.providerName, model: this.config.model })
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
            case 'send_file':
                await this.handleSendFileCommand(args)
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
            case 'file':
                await this.handleFileCommand(args)
                return
            default:
                this.recordCommand(name, { args })
        }
    }

    private withFileReferenceHints(message: ChannelMessage, event?: ConversationEvent): ChannelMessage {
        const refs = this.registerFileReferencesFromEvent(event, message.text)
        if (refs.length === 0) return message

        const hint = this.formatFileReferenceHint(refs, message.format)
        const replyMarkup = this.withFileReferenceButtons(message.replyMarkup, refs)
        return {
            ...message,
            text: `${message.text}${hint}`,
            ...(replyMarkup ? { replyMarkup } : {}),
        }
    }

    private registerFileReferencesFromEvent(event: ConversationEvent | undefined, projectedText: string): FileReference[] {
        if (event?.kind !== 'tool') return []
        const contentText = (event.content ?? [])
            .flatMap((item) => item.type === 'content' && item.text ? [item.text] : [])
            .join('\n')
        const text = `${contentText}\n${projectedText}`

        return this.registerFileReferences(text)
    }

    private registerFileReferences(text: string): FileReference[] {
        const refs: FileReference[] = []
        const seenInMessage = new Set<string>()
        for (const match of text.matchAll(FILE_REFERENCE_PATTERN)) {
            const uri = this.trimFileUri(match[0])
            if (!uri || seenInMessage.has(uri)) continue
            seenInMessage.add(uri)
            const ref = this.registerFileReference(uri)
            if (ref) refs.push(ref)
        }
        return refs
    }

    private trimFileUri(uri: string): string {
        return uri.replace(/[.,;:!?`]+$/g, '')
    }

    private registerFileReference(uri: string): FileReference | null {
        const existingId = this.fileReferenceIdsByUri.get(uri)
        if (existingId) return this.fileReferences.get(existingId) ?? null

        let path: string
        try {
            path = fileURLToPath(uri)
        } catch {
            return null
        }

        const id = `f${this.nextFileReferenceNumber++}`
        const ref = { id, uri, path }
        this.fileReferences.set(id, ref)
        this.fileReferenceIdsByUri.set(uri, id)

        if (this.fileReferences.size > MAX_FILE_REFERENCES) {
            const oldestId = this.fileReferences.keys().next().value
            if (oldestId) {
                const oldest = this.fileReferences.get(oldestId)
                this.fileReferences.delete(oldestId)
                if (oldest) this.fileReferenceIdsByUri.delete(oldest.uri)
            }
        }

        return ref
    }

    private formatFileReferenceHint(refs: FileReference[], format: ChannelMessage['format']): string {
        const lines = refs.map(ref => {
            if (format === 'html') {
                return `File reference <code>${escapeHtml(ref.id)}</code>: use <code>/file_${escapeHtml(ref.id)}</code> or <code>/file ${escapeHtml(ref.id)}</code> to read it.`
            }
            return `File reference ${ref.id}: use /file_${ref.id} or /file ${ref.id} to read it.`
        })
        return `\n\n${lines.join('\n')}`
    }

    private withFileReferenceButtons(replyMarkup: unknown, refs: FileReference[]): unknown {
        if (refs.length === 0) return replyMarkup
        const buttons = refs.slice(0, 3).map(ref => ({
            text: `Read ${ref.id}`,
            callback_data: `file:${ref.id}`,
        }))

        const existing = replyMarkup && typeof replyMarkup === 'object'
            ? replyMarkup as { inline_keyboard?: unknown }
            : undefined
        if (Array.isArray(existing?.inline_keyboard)) {
            return {
                ...existing,
                inline_keyboard: [...existing.inline_keyboard, buttons],
            }
        }
        return { inline_keyboard: [buttons] }
    }

    private async handleFileCommand(idArg: string | undefined): Promise<void> {
        const id = idArg?.trim()
        if (!id) {
            await this.send({ text: 'Usage: <code>/file f1</code> or <code>/file_f1</code>', format: 'html' })
            return
        }

        const ref = this.fileReferences.get(id)
        if (!ref) {
            await this.send({ text: `Unknown file reference: <code>${escapeHtml(id)}</code>`, format: 'html' })
            return
        }

        try {
            const { path, content } = await this.readRegisteredFile(ref)
            await this.send(this.formatFileReadMessage(id, path, content))
            this.recordCommand('file', { id, path })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            await this.send({ text: `Cannot read <code>${escapeHtml(id)}</code>: ${escapeHtml(message)}`, format: 'html' })
            this.recordCommand('file', { id, error: message })
        }
    }

    private async handleSendFileCommand(args: string | undefined): Promise<void> {
        const request = parseSendFileArgs(args)
        if (!request?.path) {
            const error = 'missing required file path'
            this.recordCommand('send_file', { error })
            await this.send({ text: `Cannot send file: ${escapeHtml(error)}`, format: 'html' })
            return
        }

        try {
            const renderType = normalizeSendFileType(request.type)
            if (renderType === 'markdown') {
                const { path, filename, content } = await this.readSendableTextFile(request.path, request.filename)
                await this.send({
                    text: withOptionalCaption(content, request.caption ?? filename),
                    format: 'markdown',
                })
                this.recordCommand('send_file', { path, filename, caption: request.caption, type: renderType })
                return
            }

            if (renderType === 'code') {
                const { path, filename, content } = await this.readSendableTextFile(request.path, request.filename)
                const language = request.language ?? inferCodeLanguage(filename)
                await this.send({
                    text: withOptionalCaption(formatCodeBlock(content, language), request.caption ?? filename),
                    format: 'markdown',
                })
                this.recordCommand('send_file', { path, filename, caption: request.caption, type: renderType, language })
                return
            }

            const { path, filename } = await this.resolveSendableFile(request.path, request.filename)
            const attachmentType = renderType === 'image' ? 'photo' : 'document'
            await this.send({
                text: request.caption ?? filename,
                format: 'plain',
                attachments: [{ type: attachmentType, path, filename }],
            })
            this.recordCommand('send_file', { path, filename, caption: request.caption, type: renderType })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.recordCommand('send_file', { path: request.path, error: message })
            await this.send({ text: `Cannot send file: ${escapeHtml(message)}`, format: 'html' })
        }
    }

    private async handleCodeverSendFileIdentityFallback(event: AgentEvent): Promise<boolean> {
        if (event.kind === 'tool_use') {
            const request = extractCodeverSendFileRequest(event.input)
            if (!request || !event.toolUseId) return false
            this.pendingCodeverSendFileCalls.set(event.toolUseId, JSON.stringify(request))
            return true
        }

        if (event.kind !== 'tool_result' || !event.toolUseId) return false

        const args = this.pendingCodeverSendFileCalls.get(event.toolUseId)
        if (!args) return false
        this.pendingCodeverSendFileCalls.delete(event.toolUseId)

        if (event.isError && isSessionIdentityUnavailableOutput(event.output)) {
            this.log(`[session] MCP send_file lacked session identity; routing through runtime session id=${this.config.sessionId.slice(0, 8)}`)
            await this.handleSendFileCommand(args)
            return true
        }

        return false
    }

    private formatFileReadMessage(id: string, path: string, content: string): ChannelMessage {
        if (isMarkdownPath(path)) {
            return {
                text: `File ${id}: ${path}\n\n${content}`,
                format: 'markdown',
            }
        }

        return {
            text: `<b>File <code>${escapeHtml(id)}</code></b>: <code>${escapeHtml(path)}</code>\n<pre>${escapeHtml(content)}</pre>`,
            format: 'html',
        }
    }

    private async readRegisteredFile(ref: FileReference): Promise<{ path: string; content: string }> {
        const resolvedPath = await realpath(ref.path)
        if (!await this.isAllowedFilePath(resolvedPath)) {
            throw new Error('file is outside allowed directories')
        }

        const info = await stat(resolvedPath)
        if (!info.isFile()) {
            throw new Error('path is not a regular file')
        }
        if (info.size > MAX_READ_FILE_BYTES) {
            throw new Error(`file is too large (${info.size} bytes, limit ${MAX_READ_FILE_BYTES})`)
        }

        return {
            path: resolvedPath,
            content: await readFile(resolvedPath, 'utf8'),
        }
    }

    private async resolveSendableFile(path: string, filename?: string, maxBytes = MAX_SEND_FILE_BYTES): Promise<{ path: string; filename: string }> {
        const resolvedPath = await realpath(path)
        if (!await this.isAllowedFilePath(resolvedPath)) {
            throw new Error('file is outside allowed directories')
        }

        const info = await stat(resolvedPath)
        if (!info.isFile()) {
            throw new Error('path is not a regular file')
        }
        if (info.size > maxBytes) {
            throw new Error(`file is too large (${info.size} bytes, limit ${maxBytes})`)
        }

        return {
            path: resolvedPath,
            filename: filename?.trim() || basename(resolvedPath),
        }
    }

    private async readSendableTextFile(path: string, filename?: string): Promise<{ path: string; filename: string; content: string }> {
        const file = await this.resolveSendableFile(path, filename, MAX_READ_FILE_BYTES)
        return {
            ...file,
            content: await readFile(file.path, 'utf8'),
        }
    }

    private async isAllowedFilePath(path: string): Promise<boolean> {
        const candidates = [
            this.config.cwd,
            resolve(homedir(), '.cursor'),
        ]

        for (const candidate of candidates) {
            try {
                await access(candidate, fsConstants.R_OK)
                const base = await realpath(candidate)
                if (isPathInside(path, base)) return true
            } catch {}
        }

        return false
    }

    private async handleProgressCommand(): Promise<void> {
        const progress = this.getProgress()
        this.recordCommand('progress', progress)
        await this.send({
            text: this.state === 'querying'
                ? `🔄 Task in progress: ${progress.elapsedSeconds}s elapsed${this.lastToolName ? `\nCurrent tool: ${this.lastToolName}` : ''}`
                : '✅ No active task',
            format: 'html',
        }, { lane: 'control' })
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
            const startRecord = await this.outbox.send({ text: '⏳ Agent is starting up, please wait...', format: 'html' })
            this.startingMessageId = startRecord.messageId ?? null
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
        const editMessageId = this.startingMessageId
        this.startingMessageId = null
        const activeModel = this.getActiveModel()
        this.config.channelPort.notifyStatus({
            state,
            ...(activeModel ? { model: activeModel } : {}),
            cwd: this.config.cwd,
            provider: this.config.providerName,
            ...(editMessageId != null ? { editMessageId } : {}),
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

function isPathInside(path: string, base: string): boolean {
    const normalizedPath = normalizePathForCompare(path)
    const normalizedBase = normalizePathForCompare(base)
    return normalizedPath === normalizedBase || normalizedPath.startsWith(`${normalizedBase}${sep}`)
}

function normalizePathForCompare(path: string): string {
    return process.platform === 'win32' ? path.toLowerCase() : path
}

function formatUploadedFileReferenceText(files: RichFilePart[]): string {
    const lines = [
        'The user uploaded the following file(s), cached locally by Codever:',
        ...files.map(file => `- ${file.filename}: ${file.path} (${file.mimeType}, ${file.sizeBytes} bytes)`),
        '',
        'Use these local paths if you need to inspect the uploaded file(s).',
    ]
    return lines.join('\n')
}

function isMarkdownPath(path: string): boolean {
    const lower = path.toLowerCase()
    return lower.endsWith('.md') || lower.endsWith('.markdown')
}

type SendFileType = 'document' | 'file' | 'markdown' | 'code' | 'image'

function parseSendFileArgs(args: string | undefined): { path: string; caption?: string; filename?: string; type?: string; language?: string } | null {
    const trimmed = args?.trim()
    if (!trimmed) return null
    try {
        const parsed = JSON.parse(trimmed)
        if (!parsed || typeof parsed !== 'object') return null
        const record = parsed as Record<string, unknown>
        const path = typeof record.path === 'string' ? record.path.trim() : ''
        if (!path) return null
        const caption = typeof record.caption === 'string' && record.caption.trim()
            ? record.caption
            : undefined
        const filename = typeof record.filename === 'string' && record.filename.trim()
            ? record.filename
            : undefined
        const type = typeof record.type === 'string' && record.type.trim()
            ? record.type
            : undefined
        const language = typeof record.language === 'string' && record.language.trim()
            ? record.language
            : undefined
        return { path, caption, filename, type, language }
    } catch {
        return { path: trimmed }
    }
}

function normalizeSendFileType(type: string | undefined): SendFileType {
    const normalized = type?.trim().toLowerCase()
    if (normalized === 'file') return 'document'
    if (normalized === 'markdown' || normalized === 'code' || normalized === 'image' || normalized === 'document') {
        return normalized
    }
    return 'document'
}

function extractCodeverSendFileRequest(input: unknown): { path: string; caption?: string; filename?: string; type?: string; language?: string } | null {
    const record = asRecord(input)
    if (!record) return null

    const server = typeof record.server === 'string' ? record.server.trim().toLowerCase() : ''
    const tool = typeof record.tool === 'string' ? record.tool.trim().toLowerCase() : ''
    if (server !== 'codever' || tool !== 'send_file') return null

    const args = asRecord(record.arguments)
    if (!args) return null

    const path = typeof args.path === 'string' ? args.path.trim() : ''
    if (!path) return null

    return {
        path,
        ...(typeof args.caption === 'string' && args.caption.trim() ? { caption: args.caption } : {}),
        ...(typeof args.filename === 'string' && args.filename.trim() ? { filename: args.filename } : {}),
        ...(typeof args.type === 'string' && args.type.trim() ? { type: args.type } : {}),
        ...(typeof args.language === 'string' && args.language.trim() ? { language: args.language } : {}),
    }
}

function isSessionIdentityUnavailableOutput(output: string): boolean {
    return output.toLowerCase().includes('session identity not available yet')
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function withOptionalCaption(content: string, caption: string | undefined): string {
    return caption?.trim() ? `${caption.trim()}\n\n${content}` : content
}

function waitForDeliveryRecord(delivery: Promise<DeliveryRecord>, timeoutMs: number): Promise<DeliveryRecord | undefined> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
        delivery,
        new Promise<undefined>((resolve) => {
            timeout = setTimeout(() => resolve(undefined), timeoutMs)
        }),
    ]).finally(() => {
        if (timeout) clearTimeout(timeout)
    })
}

function formatCodeBlock(content: string, language: string | undefined): string {
    const fence = content.includes('```') ? '````' : '```'
    const suffix = content.endsWith('\n') ? '' : '\n'
    return `${fence}${language ?? ''}\n${content}${suffix}${fence}`
}

function inferCodeLanguage(filename: string): string | undefined {
    const extension = filename.toLowerCase().split('.').pop()
    if (!extension || extension === filename.toLowerCase()) return undefined
    const aliases: Record<string, string> = {
        js: 'javascript',
        jsx: 'jsx',
        ts: 'ts',
        tsx: 'tsx',
        py: 'python',
        rb: 'ruby',
        rs: 'rust',
        go: 'go',
        java: 'java',
        kt: 'kotlin',
        c: 'c',
        h: 'c',
        cpp: 'cpp',
        cc: 'cpp',
        cxx: 'cpp',
        cs: 'csharp',
        php: 'php',
        swift: 'swift',
        sh: 'bash',
        bash: 'bash',
        ps1: 'powershell',
        json: 'json',
        yaml: 'yaml',
        yml: 'yaml',
        toml: 'toml',
        xml: 'xml',
        html: 'html',
        css: 'css',
        sql: 'sql',
        md: 'markdown',
        markdown: 'markdown',
    }
    return aliases[extension] ?? extension
}

function formatUnknown(value: unknown): string {
    if (typeof value === 'string') return value
    try {
        return JSON.stringify(value, null, 2)
    } catch {
        return String(value)
    }
}
