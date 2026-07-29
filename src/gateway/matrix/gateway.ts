import { createHash, randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute, win32 } from 'node:path'
import type { CodeverCommand } from '@codever/protocol'
import type { AgentProvider } from '@/providers/provider'
import { createProviderInstance, getProvider } from '@/providers/registry'
import type { TopicSession } from '@/bridge/channelPort'
import { createTopicSession, createTopicSessionRecord } from '@/bridge/topicSession'
import {
    CODEVER_MATRIX_EXTENSION,
    MatrixPort,
    MatrixRoomSessionRegistry,
    type MatrixIncomingEvent,
} from '@/channel/matrix'
import { StrictMatrixCommandAuthorizer } from './authorizer'
import {
    validateMatrixGatewayConfig,
    type MatrixGatewayConfig,
    type MatrixGatewayRoomConfig,
} from './config'
import {
    createMatrixJsSdkGatewayClient,
    type MatrixGatewayClient,
} from './client'
import { FileCommandReplayStore, RevisionConflictError } from './fileReplayLedger'
import {
    FileGatewayRuntimeStateStore,
    type PersistedRoomRuntimeState,
} from './fileRuntimeState'
import { GatewaySecureContentLayer } from './secureContent'
import { gatewayProjectIdentity } from './project'

interface RoomRuntime {
    config: MatrixGatewayRoomConfig
    port: MatrixPort
    session: TopicSession
    capabilityProvider: AgentProvider | null
    workspace: {
        projectId: string
        projectName: string
        cwd: string
        provider: string
        model: string | null
        reasoningEffort: string | null
        permissionMode: string
    }
    appSessions: Map<string, AppSessionRecord>
    currentAppSessionId: string | null
    revisionEpoch: string
    revisionEpochGeneration: number
    replayGeneration: string
    stateVersion: number
}

interface AppSessionRecord {
    id: string
    title: string
    updatedAt: number
    projectId: string
    projectName: string
    cwd: string
    provider: string
    model: string | null
    reasoningEffort: string | null
    permissionMode: string
    providerSessionId: string | null
}

interface WorkspaceSettingsInput {
    cwd?: string
    projectName?: string
    provider?: string
    model?: string | null
    reasoningEffort?: string | null
    permissionMode?: string
}

export interface MatrixGatewayDependencies {
    client?: MatrixGatewayClient
    providerFactory?: (room: MatrixGatewayRoomConfig) => AgentProvider | undefined
    sessionFactory?: (room: MatrixGatewayRoomConfig, port: MatrixPort) => TopicSession
    now?: () => number
    onLog?: (message: string) => void
    onRejected?: (event: MatrixIncomingEvent, error: unknown) => void
    /** Optional live authorization source used for immediate local revocation. */
    isTrustedDeviceActive?: (deviceId: string) => Promise<boolean>
    /** Supplies newly paired and currently active devices without a restart. */
    listTrustedDevices?: () => Promise<readonly import('./config').MatrixGatewayTrustedDevice[]>
}

export type MatrixGatewayState = 'stopped' | 'starting' | 'running' | 'stopping'

export class MatrixGatewayRunner {
    private readonly client: MatrixGatewayClient
    private readonly replayStore: FileCommandReplayStore
    private readonly runtimeStateStore: FileGatewayRuntimeStateStore
    private readonly authorizer: StrictMatrixCommandAuthorizer
    private readonly secureContent: GatewaySecureContentLayer | null
    private readonly roomTargets = new MatrixRoomSessionRegistry()
    private readonly rooms = new Map<string, RoomRuntime>()
    private state: MatrixGatewayState = 'stopped'
    private unsubscribe: (() => void) | null = null
    private startupEvents: MatrixIncomingEvent[] = []
    private eventChain: Promise<void> = Promise.resolve()
    private readonly executionTasks = new Set<Promise<void>>()
    private startupFailure: Error | null = null
    private stopPromise: Promise<void> | null = null

    constructor(
        private readonly config: MatrixGatewayConfig,
        private readonly dependencies: MatrixGatewayDependencies = {},
    ) {
        validateMatrixGatewayConfig(config)
        this.client = dependencies.client
            ?? createMatrixJsSdkGatewayClient(config.connection, dependencies.onLog)
        this.replayStore = new FileCommandReplayStore(config.replayLedgerPath)
        this.runtimeStateStore = new FileGatewayRuntimeStateStore(
            `${config.replayLedgerPath}.runtime-state.json`,
        )
        this.authorizer = new StrictMatrixCommandAuthorizer(
            config.gatewayId,
            config.trustedDevices,
            this.replayStore,
        )
        this.secureContent = config.applicationSecurity
            ? new GatewaySecureContentLayer(
                config.gatewayId,
                config.applicationSecurity,
                config.trustedDevices,
                dependencies.listTrustedDevices,
            )
            : null
    }

    getState(): MatrixGatewayState {
        return this.state
    }

    async syncState(roomId?: string): Promise<void> {
        if (!this.secureContent) return
        const runtimes = roomId
            ? [this.rooms.get(roomId)].filter((runtime): runtime is RoomRuntime => runtime !== undefined)
            : [...this.rooms.values()]
        await Promise.all(runtimes.map(async runtime => {
            const stateVersion = await this.runtimeStateStore.incrementStateVersion(
                runtime.config.roomId,
                runtimeStateWithoutVersion(runtime),
            )
            runtime.stateVersion = stateVersion
            const revision = await this.replayStore.getConversationRevision(
                this.config.gatewayId,
                runtime.config.conversationId,
                runtime.revisionEpoch,
            )
            let models: Array<{
                id: string
                name: string
                defaultReasoningLevel?: string
                supportedReasoningLevels?: Array<{
                    effort: string
                    description?: string
                }>
            }> = []
            try {
                models = (runtime.capabilityProvider?.getAvailableModels() ?? [])
                    .map(model => ({
                        id: model.id,
                        name: model.name,
                        ...(model.defaultReasoningLevel
                            ? { defaultReasoningLevel: model.defaultReasoningLevel }
                            : {}),
                        ...(model.supportedReasoningLevels
                            ? {
                                supportedReasoningLevels:
                                    model.supportedReasoningLevels.map(level => ({
                                        effort: level.effort,
                                        ...(level.description
                                            ? { description: level.description }
                                            : {}),
                                    })),
                            }
                            : {}),
                    }))
            } catch (error) {
                this.log(
                    `[matrix-gateway] model capability discovery failed for ${runtime.workspace.provider}: `
                    + formatError(error),
                )
            }
            await this.secureContent!.sendGatewayState(runtime.config, {
                revision,
                revisionEpoch: runtime.revisionEpoch,
                revisionEpochGeneration: runtime.revisionEpochGeneration,
                stateVersion,
                currentSessionId: runtime.currentAppSessionId,
                sessions: [...runtime.appSessions.values()].map(session => ({
                    id: session.id,
                    title: session.title,
                    updatedAt: session.updatedAt,
                    projectId: session.projectId,
                    projectName: session.projectName,
                    cwd: session.cwd,
                    provider: session.provider,
                    ...(session.model ? { model: session.model } : {}),
                    ...(session.reasoningEffort
                        ? { reasoningEffort: session.reasoningEffort }
                        : {}),
                })),
                workspace: {
                    projectId: runtime.workspace.projectId,
                    projectName: runtime.workspace.projectName,
                    cwd: runtime.workspace.cwd,
                    provider: runtime.workspace.provider,
                    ...(runtime.workspace.model ? { model: runtime.workspace.model } : {}),
                    ...(runtime.workspace.reasoningEffort
                        ? { reasoningEffort: runtime.workspace.reasoningEffort }
                        : {}),
                    permissionMode: runtime.workspace.permissionMode,
                },
                capabilities: {
                    models,
                    // The runtime currently always asks for permission. Do not
                    // advertise modes whose policy is not actually enforced.
                    permissionModes: [{ id: 'default', name: 'Default' }],
                    canCreateSession: true,
                    canSelectSession: true,
                },
            }, this.client)
        }))
    }

    async start(): Promise<void> {
        if (this.state === 'running') return
        if (this.state !== 'stopped') throw new Error(`Cannot start Matrix gateway while ${this.state}`)
        this.state = 'starting'
        this.startupFailure = null
        try {
            await this.replayStore.initialize(this.now())
            const replayGeneration = this.replayStore.getGeneration()
            await this.runtimeStateStore.initialize(this.config.rooms, replayGeneration)
            await this.authorizer.initialize(this.now())
            await this.secureContent?.initialize(this.now())
            await this.createRoomRuntimes()
            this.unsubscribe = this.client.onRoomEvent(event => this.receiveEvent(event))
            await this.client.initializeCrypto(this.config.crypto)
            await this.client.start()
            await this.client.waitUntilReady(this.config.connection.initialSyncTimeoutMs)
            await this.client.pinTrustedDevices?.(this.config.trustedDevices)
            for (const room of this.config.rooms) {
                await this.client.assertRoomEncrypted(room.roomId)
            }
            for (const room of this.config.rooms) {
                void this.secureContent?.retryPendingForRoom(room, this.client).catch(error => {
                    this.log(
                        `[matrix-gateway] pending delivery recovery failed for ${room.roomId}: `
                        + formatError(error),
                    )
                    this.secureContent?.scheduleRecoveryForRoom(room, this.client)
                })
            }
            if (this.startupFailure) throw this.startupFailure
            this.state = 'running'
            await this.syncState().catch(error => {
                this.log(`[matrix-gateway] initial state sync failed: ${formatError(error)}`)
            })
            const queued = this.startupEvents
            this.startupEvents = []
            for (const event of queued) this.enqueue(event)
            await this.eventChain
        } catch (error) {
            await this.cleanup()
            this.state = 'stopped'
            throw error
        }
    }

    async stop(): Promise<void> {
        if (this.state === 'stopped') return
        if (this.state === 'stopping') return this.stopPromise ?? Promise.resolve()
        this.state = 'stopping'
        this.stopPromise = (async () => {
            await this.eventChain
            await this.cleanup()
            this.state = 'stopped'
            this.stopPromise = null
        })()
        return this.stopPromise
    }

    private receiveEvent(event: MatrixIncomingEvent): void {
        // Matrix echoes the Gateway's own outbound timeline events. They are
        // gateway_to_device envelopes and must never enter the command queue.
        if (event.sender === this.config.connection.userId) return
        if (this.state === 'starting') {
            const limit = this.config.startupEventQueueLimit ?? 1_000
            if (this.startupEvents.length >= limit) {
                this.startupFailure = new Error(`Matrix startup event queue exceeded ${limit}`)
                return
            }
            this.startupEvents.push(event)
            return
        }
        if (this.state === 'running') this.enqueue(event)
    }

    private enqueue(event: MatrixIncomingEvent): void {
        this.eventChain = this.eventChain
            .then(() => this.handleEvent(event))
            .catch(error => {
                this.dependencies.onRejected?.(event, error)
                this.log(`[matrix-gateway] rejected ${event.eventId}: ${formatError(error)}`)
            })
    }

    private async handleEvent(event: MatrixIncomingEvent): Promise<void> {
        if (event.eventType !== 'm.room.message') return
        if (isMatrixGatewayControlEvent(event.content)) return
        if (!event.encrypted) throw new Error('Clear-text Matrix events cannot execute gateway commands')
        if (!event.senderDeviceId) throw new Error('Encrypted Matrix event has no cryptographic sender device key')
        const runtime = this.rooms.get(event.roomId)
        if (!runtime) return

        const opened = this.secureContent
            ? await this.secureContent.openIncoming(
                event.content[CODEVER_MATRIX_EXTENSION],
                runtime.config,
                this.now(),
            )
            : null
        const extension = asRecord(
            (opened?.content ?? event.content)[CODEVER_MATRIX_EXTENSION],
        )
        if (!extension || extension.version !== 1 || extension.kind !== 'signed_command') return
        if (opened) this.authorizer.trustDevice(opened.trustedDevice)
        const signedCommand = asRecord(extension.signed_command)
        const candidateCommand = asRecord(signedCommand?.command)
        const candidateDeviceId = candidateCommand?.deviceId
        if (
            typeof candidateDeviceId === 'string'
            && this.dependencies.isTrustedDeviceActive
            && !(await this.dependencies.isTrustedDeviceActive(candidateDeviceId))
        ) {
            throw new Error(`Codever device ${candidateDeviceId} has been revoked`)
        }
        let authorized
        try {
            authorized = await this.authorizer.authorizeDelivery(extension.signed_command, {
                roomId: event.roomId,
                conversationId: runtime.config.conversationId,
                revisionEpoch: runtime.revisionEpoch,
                matrixSender: event.sender,
                matrixDeviceKey: event.senderDeviceId,
                ...(opened ? { applicationDeviceId: opened.authenticatedDeviceId } : {}),
            }, this.now())
        } catch (error) {
            if (
                error instanceof RevisionConflictError
                && this.secureContent
                && typeof candidateDeviceId === 'string'
                && typeof candidateCommand?.commandId === 'string'
            ) {
                await this.secureContent.sendRevisionConflict(
                    runtime.config,
                    candidateDeviceId,
                    candidateCommand.commandId,
                    error.expectedRevision,
                    error.receivedBaseRevision,
                    runtime.revisionEpoch,
                    this.client,
                )
                return
            }
            throw error
        }
        if (!authorized.duplicate) {
            let collaborationDelivery: Promise<unknown> | undefined
            if (
                this.secureContent
                && authorized.command.payload.operation === 'prompt'
            ) {
                // Establish the app-session identity before any collaboration,
                // status, or Agent event is emitted. Matrix rooms are shared by
                // several sessions, and history routing must never depend on
                // whichever session happens to be selected during replay.
                const appSession = this.ensureAppSession(
                    runtime,
                    authorized.command.payload.text,
                )
                await this.persistRuntime(runtime)
                collaborationDelivery = this.secureContent.sendCollaborationPrompt(runtime.config, {
                    commandId: authorized.command.commandId,
                    revision: authorized.revision,
                    sessionId: appSession.id,
                    originDeviceId: authorized.command.deviceId,
                    originDeviceName: opened?.trustedDevice.deviceName
                        ?? opened?.trustedDevice.deviceId
                        ?? authorized.command.deviceId,
                    text: authorized.command.payload.text,
                }, this.client).catch(error => {
                    this.log(`[matrix-gateway] collaboration broadcast failed: ${formatError(error)}`)
                })
            }
            this.scheduleExecution(
                event,
                runtime,
                authorized.command,
                authorized.revision,
                collaborationDelivery,
            )
        } else if (this.secureContent) {
            // A retried signed command is never executed twice, but it is also
            // an explicit recovery opportunity for this command's missing
            // collaboration/result recipient copies.
            void this.secureContent.retryPendingForRoom(
                runtime.config,
                this.client,
                authorized.command.commandId,
            ).catch(error => {
                this.log(
                    `[matrix-gateway] command ${authorized.command.commandId} delivery recovery failed: `
                    + formatError(error),
                )
            })
        }
        if (this.secureContent) {
            // Matrix delivery is deliberately off the authorization lane. A
            // stalled homeserver must not delay execution, cancel, or decisions.
            void this.secureContent.sendCommandAccepted(
                runtime.config,
                authorized.command.deviceId,
                authorized.command.commandId,
                authorized.command.sequence,
                authorized.revision,
                runtime.revisionEpoch,
                this.client,
            ).catch(error => {
                this.log(
                    `[matrix-gateway] command acknowledgement ${authorized.command.commandId} failed: `
                    + formatError(error),
                )
            })
        }
    }

    private scheduleExecution(
        event: MatrixIncomingEvent,
        runtime: RoomRuntime,
        command: CodeverCommand,
        revision: number,
        beforeExecute?: Promise<unknown>,
    ): void {
        // Authorization and acknowledgement remain strictly ordered on
        // eventChain, while the session runtime owns execution ordering. A
        // prompt's background task waits for its collaboration event's first
        // fan-out attempt so remote devices see the user intent before Agent
        // status. The event chain itself stays free for cancel and decisions.
        const task = (async () => {
            let outcome: 'succeeded' | 'failed' = 'succeeded'
            let executionError: unknown
            try {
                await beforeExecute
                await this.execute(runtime, command)
            } catch (error) {
                outcome = 'failed'
                executionError = error
                this.dependencies.onRejected?.(event, error)
                this.log(`[matrix-gateway] command ${command.commandId} failed: ${formatError(error)}`)
            }

            try {
                await this.secureContent?.sendCommandResult(
                    runtime.config,
                    command.deviceId,
                    command.commandId,
                    command.sequence,
                    revision,
                    runtime.revisionEpoch,
                    outcome,
                    this.client,
                    executionError === undefined ? undefined : formatError(executionError),
                    runtime.currentAppSessionId,
                )
            } catch (deliveryError) {
                this.log(
                    `[matrix-gateway] ${outcome} result delivery failed: ${formatError(deliveryError)}`,
                )
            }
            await this.syncState(runtime.config.roomId).catch(error => {
                this.log(
                    `[matrix-gateway] post-command state sync failed for ${command.commandId}: `
                    + formatError(error),
                )
            })
        })()
            .finally(() => {
                this.executionTasks.delete(task)
            })
        this.executionTasks.add(task)
    }

    private async execute(runtime: RoomRuntime, command: CodeverCommand): Promise<void> {
        switch (command.payload.operation) {
            case 'prompt': {
                const appSession = this.ensureAppSession(runtime, command.payload.text)
                await this.persistRuntime(runtime)
                await runtime.session.dispatch({
                    kind: 'user_message',
                    text: command.payload.text,
                    source: 'channel',
                    user: { id: command.deviceId, username: command.deviceId },
                })
                appSession.providerSessionId = runtime.session.sessionRecord.conversationId
                this.updateCurrentAppSession(runtime)
                await this.persistRuntime(runtime)
                return
            }
            case 'cancel':
                await runtime.session.dispatch({
                    kind: 'cancel',
                    reason: 'user',
                    source: 'channel',
                    user: { id: command.deviceId, username: command.deviceId },
                })
                return
            case 'decision': {
                const value = command.payload.decision === 'deny' ? 'deny' : 'allow'
                if (!runtime.port.resolveDecision(command.payload.requestId, value)) {
                    throw new Error(`Unknown or invalid decision request ${command.payload.requestId}`)
                }
                return
            }
            case 'session.settings': {
                await this.applyWorkspaceSettings(runtime, command, command.payload, true)
                await this.persistRuntime(runtime)
                return
            }
            case 'session.create': {
                await this.applyWorkspaceSettings(runtime, command, command.payload, false)
                await dispatchCommand(runtime.session, command, 'new', '')
                runtime.session.sessionRecord.setConversationId(null)
                const session = this.createAppSession(runtime, 'New session')
                runtime.currentAppSessionId = session.id
                await this.persistRuntime(runtime)
                return
            }
            case 'session.select': {
                const selected = runtime.appSessions.get(command.payload.sessionId)
                if (!selected) {
                    throw new Error(`Unknown app session ${command.payload.sessionId}`)
                }
                await this.applyWorkspaceSettings(runtime, command, {
                    cwd: selected.cwd,
                    projectName: selected.projectName,
                    provider: selected.provider,
                    model: selected.model,
                    reasoningEffort: selected.reasoningEffort,
                    permissionMode: selected.permissionMode,
                }, false)
                await dispatchCommand(
                    runtime.session,
                    command,
                    selected.providerSessionId ? 'resume' : 'new',
                    selected.providerSessionId ?? '',
                )
                runtime.session.sessionRecord.setConversationId(selected.providerSessionId)
                selected.updatedAt = this.now()
                runtime.currentAppSessionId = selected.id
                await this.persistRuntime(runtime)
                return
            }
        }
    }

    private async applyWorkspaceSettings(
        runtime: RoomRuntime,
        command: CodeverCommand,
        settings: WorkspaceSettingsInput,
        updateCurrentSession: boolean,
    ): Promise<void> {
        const providerName = settings.provider ?? runtime.workspace.provider
        const providerChanged = providerName !== runtime.workspace.provider
        const targetProvider = providerChanged
            ? getProvider(providerName)
            : runtime.capabilityProvider
        if (!targetProvider) {
            throw new Error(`Provider ${providerName} is not configured`)
        }
        const availableModels = targetProvider.getAvailableModels()
        const requestedModel = settings.model !== undefined
            ? settings.model
            : providerChanged
                ? null
                : runtime.workspace.model
        const selectedModel = requestedModel
            ? availableModels.find(model =>
                model.id === requestedModel || model.name === requestedModel,
            )
            : undefined
        if (requestedModel && !selectedModel) {
            throw new Error(
                `Model ${requestedModel} is not available for provider ${providerName}`,
            )
        }
        const modelId = selectedModel?.id ?? null
        const modelChanged = modelId !== runtime.workspace.model
        const requestedReasoningEffort = settings.reasoningEffort !== undefined
            ? settings.reasoningEffort
            : providerChanged || modelChanged
                ? selectedModel?.defaultReasoningLevel ?? null
                : runtime.workspace.reasoningEffort
        if (requestedReasoningEffort) {
            if (!selectedModel) {
                throw new Error('Select a model before setting reasoning effort')
            }
            const supported = selectedModel.supportedReasoningLevels ?? []
            if (!supported.some(level => level.effort === requestedReasoningEffort)) {
                throw new Error(
                    `Reasoning effort ${requestedReasoningEffort} is not available for model ${selectedModel.id}`,
                )
            }
        }
        const permissionMode = settings.permissionMode ?? runtime.workspace.permissionMode
        if (permissionMode !== 'default') {
            throw new Error(`Permission mode ${permissionMode} is not currently available`)
        }

        let project = {
            id: runtime.workspace.projectId,
            name: runtime.workspace.projectName,
            cwd: runtime.workspace.cwd,
        }
        if (settings.cwd !== undefined) {
            project = gatewayProjectIdentity(settings.cwd, settings.projectName)
            if (!isAbsolute(project.cwd) && !win32.isAbsolute(project.cwd)) {
                throw new Error('Project working directory must be an absolute path')
            }
            const projectStat = await stat(project.cwd).catch(() => null)
            if (!projectStat?.isDirectory()) {
                throw new Error(`Project working directory does not exist: ${project.cwd}`)
            }
        } else if (settings.projectName !== undefined) {
            project = gatewayProjectIdentity(runtime.workspace.cwd, settings.projectName)
        }

        if (providerChanged) {
            await dispatchCommand(runtime.session, command, 'provider', providerName)
        }
        if (project.cwd !== runtime.workspace.cwd) {
            await dispatchCommand(runtime.session, command, 'cwd', project.cwd)
        }
        if (providerChanged || modelChanged || settings.model !== undefined) {
            await dispatchCommand(runtime.session, command, 'model', modelId ?? '')
        }
        if (
            providerChanged
            || modelChanged
            || requestedReasoningEffort !== runtime.workspace.reasoningEffort
            || settings.reasoningEffort !== undefined
        ) {
            await dispatchCommand(
                runtime.session,
                command,
                'reasoningEffort',
                requestedReasoningEffort ?? '',
            )
        }
        if (permissionMode !== runtime.workspace.permissionMode) {
            await dispatchCommand(runtime.session, command, 'permissionMode', permissionMode)
        }

        runtime.capabilityProvider = targetProvider
        runtime.workspace = {
            projectId: project.id,
            projectName: project.name,
            cwd: project.cwd,
            provider: providerName,
            model: modelId,
            reasoningEffort: requestedReasoningEffort,
            permissionMode,
        }
        if (updateCurrentSession) this.updateCurrentAppSession(runtime)
    }

    private ensureAppSession(runtime: RoomRuntime, prompt: string): AppSessionRecord {
        const current = runtime.currentAppSessionId
            ? runtime.appSessions.get(runtime.currentAppSessionId)
            : undefined
        if (current) {
            if (current.title === 'New session') current.title = sessionTitle(prompt)
            return current
        }
        const created = this.createAppSession(runtime, sessionTitle(prompt))
        runtime.currentAppSessionId = created.id
        return created
    }

    private createAppSession(runtime: RoomRuntime, title: string): AppSessionRecord {
        const now = this.now()
        const session: AppSessionRecord = {
            id: randomUUID(),
            title,
            updatedAt: now,
            projectId: runtime.workspace.projectId,
            projectName: runtime.workspace.projectName,
            cwd: runtime.workspace.cwd,
            provider: runtime.workspace.provider,
            model: runtime.workspace.model,
            reasoningEffort: runtime.workspace.reasoningEffort,
            permissionMode: runtime.workspace.permissionMode,
            providerSessionId: null,
        }
        runtime.appSessions.set(session.id, session)
        return session
    }

    private updateCurrentAppSession(runtime: RoomRuntime): void {
        if (!runtime.currentAppSessionId) return
        const current = runtime.appSessions.get(runtime.currentAppSessionId)
        if (!current) return
        current.projectId = runtime.workspace.projectId
        current.projectName = runtime.workspace.projectName
        current.cwd = runtime.workspace.cwd
        current.provider = runtime.workspace.provider
        current.model = runtime.workspace.model
        current.reasoningEffort = runtime.workspace.reasoningEffort
        current.permissionMode = runtime.workspace.permissionMode
        current.updatedAt = this.now()
    }

    private async persistRuntime(runtime: RoomRuntime): Promise<void> {
        await this.runtimeStateStore.saveRoom(
            runtime.config.roomId,
            runtimeState(runtime),
        )
    }

    private async createRoomRuntimes(): Promise<void> {
        for (const room of this.config.rooms) {
            const restored = this.runtimeStateStore.getRoom(room.roomId)
            const { model: _configuredModel, ...roomWithoutModel } = room
            const effectiveRoom: MatrixGatewayRoomConfig = {
                ...roomWithoutModel,
                cwd: restored.workspace.cwd,
                providerName: restored.workspace.provider,
                ...(restored.workspace.model
                    ? { model: restored.workspace.model }
                    : {}),
                providerSettings: {
                    ...(room.providerSettings ?? {}),
                    ...(restored.workspace.reasoningEffort
                        ? { reasoningEffort: restored.workspace.reasoningEffort }
                        : {}),
                    permissionMode: restored.workspace.permissionMode,
                },
            }
            const selectedProviderSessionId = restored.currentSessionId
                ? restored.appSessions.find(session => session.id === restored.currentSessionId)
                    ?.providerSessionId ?? null
                : null
            let runtime: RoomRuntime | undefined
            const port = new MatrixPort({
                transport: this.secureContent
                    ? this.secureContent.transportForRoom(room, this.client)
                    : this.client,
                roomId: room.roomId,
                gatewayId: this.config.gatewayId,
                getSessionId: () =>
                    runtime?.currentAppSessionId ?? restored.currentSessionId,
                onLog: this.dependencies.onLog,
            })
            let capabilityProvider: AgentProvider | null
            let session: TopicSession
            if (this.dependencies.sessionFactory) {
                session = this.dependencies.sessionFactory(effectiveRoom, port)
                if (selectedProviderSessionId !== null) {
                    session.sessionRecord.setConversationId(selectedProviderSessionId)
                }
                capabilityProvider = getProvider(effectiveRoom.providerName) ?? null
            } else {
                const provider = this.dependencies.providerFactory?.(effectiveRoom)
                    ?? createProviderInstance(effectiveRoom.providerName)
                if (!provider) {
                    throw new Error(
                        `Matrix room ${room.roomId} provider ${effectiveRoom.providerName} is unavailable`,
                    )
                }
                capabilityProvider = provider
                session = this.createDefaultSession(
                    effectiveRoom,
                    port,
                    provider,
                    selectedProviderSessionId,
                )
            }
            runtime = {
                config: room,
                port,
                session,
                capabilityProvider,
                workspace: structuredClone(restored.workspace),
                appSessions: new Map(
                    restored.appSessions.map(appSession => [appSession.id, { ...appSession }]),
                ),
                currentAppSessionId: restored.currentSessionId,
                revisionEpoch: restored.revisionEpoch,
                revisionEpochGeneration: restored.revisionEpochGeneration,
                replayGeneration: restored.replayGeneration,
                stateVersion: restored.stateVersion,
            }
            this.rooms.set(room.roomId, runtime)
            this.roomTargets.bind(room.roomId, {
                dispatch: input => session.dispatch(input),
                resolveDecision: port.resolveDecision.bind(port),
            })
        }
    }

    private createDefaultSession(
        room: MatrixGatewayRoomConfig,
        port: MatrixPort,
        provider: AgentProvider,
        providerSessionId: string | null,
    ): TopicSession {
        const sessionRecord = createTopicSessionRecord({
            cwd: room.cwd,
            providerName: room.providerName,
            groupChatId: numericRoomCompatibilityId(room.roomId),
            model: room.model,
            verboseLevel: room.verboseLevel,
            timeoutSeconds: room.timeoutSeconds,
            providerSettings: room.providerSettings,
            conversationId: providerSessionId,
        })
        return createTopicSession({ sessionRecord, provider, channelPort: port })
    }

    private async cleanup(): Promise<void> {
        this.unsubscribe?.()
        this.unsubscribe = null
        this.startupEvents = []
        this.secureContent?.stopRetries()
        await this.client.stop().catch(error => this.log(`[matrix-gateway] client stop failed: ${formatError(error)}`))
        const runtimes = [...this.rooms.values()]
        this.rooms.clear()
        for (const runtime of runtimes) {
            this.roomTargets.unbind(runtime.config.roomId)
            runtime.port.close()
            await runtime.session.destroy().catch(error => {
                this.log(`[matrix-gateway] session destroy failed for ${runtime.config.roomId}: ${formatError(error)}`)
            })
        }
        await Promise.allSettled([...this.executionTasks])
        this.executionTasks.clear()
    }

    private now(): number {
        return this.dependencies.now?.() ?? Date.now()
    }

    private log(message: string): void {
        this.dependencies.onLog?.(message)
    }
}

async function dispatchCommand(
    session: TopicSession,
    command: CodeverCommand,
    name: string,
    args: string,
): Promise<void> {
    await session.dispatch({
        kind: 'command',
        name,
        args,
        source: 'channel',
        user: { id: command.deviceId, username: command.deviceId },
    })
}

function numericRoomCompatibilityId(roomId: string): number {
    const hex = createHash('sha256').update(roomId).digest('hex').slice(0, 12)
    return -Math.max(1, Number.parseInt(hex, 16))
}

function runtimeState(runtime: RoomRuntime): PersistedRoomRuntimeState {
    return {
        ...runtimeStateWithoutVersion(runtime),
        stateVersion: runtime.stateVersion,
    }
}

function runtimeStateWithoutVersion(
    runtime: RoomRuntime,
): Omit<PersistedRoomRuntimeState, 'stateVersion'> {
    return {
        revisionEpoch: runtime.revisionEpoch,
        revisionEpochGeneration: runtime.revisionEpochGeneration,
        replayGeneration: runtime.replayGeneration,
        currentSessionId: runtime.currentAppSessionId,
        appSessions: [...runtime.appSessions.values()].map(session => ({ ...session })),
        workspace: structuredClone(runtime.workspace),
    }
}

function sessionTitle(prompt: string): string {
    const normalized = prompt.replace(/\s+/gu, ' ').trim()
    if (!normalized) return 'New session'
    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

const MATRIX_GATEWAY_CONTROL_KINDS = new Set([
    'pairing_request',
    'pairing_response',
    'gateway_device_rotation',
])

export function isMatrixGatewayControlEvent(content: Record<string, unknown>): boolean {
    const extension = asRecord(content[CODEVER_MATRIX_EXTENSION])
    return extension?.version === 1
        && typeof extension.kind === 'string'
        && MATRIX_GATEWAY_CONTROL_KINDS.has(extension.kind)
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
