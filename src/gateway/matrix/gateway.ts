import { createHash, randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute, win32 } from 'node:path'
import {
    gatewayStateRequestSchema,
    historyRequestSchema,
    type CodeverCommand,
    type JsonValue,
} from '@codever/protocol'
import type { AgentProvider } from '@/providers/provider'
import { createProviderInstance, getProvider } from '@/providers/registry'
import type { AgentActivityPhase, SessionStatus, TopicSession } from '@/bridge/channelPort'
import { createTopicSession, createTopicSessionRecord } from '@/bridge/topicSession'
import {
    CODEVER_MATRIX_EXTENSION,
    MatrixPort,
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
import {
    FileCommandReplayStore,
    RevisionConflictError,
    type DurableCommandResult,
} from './fileReplayLedger'
import {
    FileGatewayRuntimeStateStore,
    type PersistedAppSession,
    type PersistedRoomRuntimeState,
} from './fileRuntimeState'
import {
    GatewaySecureContentLayer,
    type GatewayStateSnapshot,
} from './secureContent'
import { gatewayProjectIdentity } from './project'
import { materializePromptInput } from './media'

type WorkspaceState = PersistedRoomRuntimeState['workspace']

interface AppSessionRuntime {
    record: AppSessionRecord
    port: MatrixPort
    session: TopicSession
    capabilityProvider: AgentProvider | null
    activity: { phase: AgentActivityPhase }
}

interface RoomRuntime {
    config: MatrixGatewayRoomConfig
    /** Defaults used only when creating a new independent app session. */
    workspace: WorkspaceState
    capabilityProvider: AgentProvider | null
    appSessions: Map<string, AppSessionRuntime>
    archivedSessions: Map<string, AppSessionRecord>
    revisionEpoch: string
    revisionEpochGeneration: number
    replayGeneration: string
    stateVersion: number
}

type AppSessionRecord = PersistedAppSession

interface WorkspaceSettingsInput {
    cwd?: string
    projectName?: string
    provider?: string
    model?: string | null
    reasoningEffort?: string | null
    permissionMode?: string
}

interface CommandExecutionResult {
    sessionId: string | null
    result?: JsonValue
}

export interface MatrixGatewayDependencies {
    client?: MatrixGatewayClient
    providerFactory?: (
        room: MatrixGatewayRoomConfig,
        appSession: Readonly<AppSessionRecord>,
    ) => AgentProvider | undefined
    sessionFactory?: (
        room: MatrixGatewayRoomConfig,
        port: MatrixPort,
        appSession: Readonly<AppSessionRecord>,
    ) => TopicSession
    now?: () => number
    onLog?: (message: string) => void
    onRejected?: (event: MatrixIncomingEvent, error: unknown) => void
    /** Optional live authorization source used for immediate local revocation. */
    isTrustedDeviceActive?: (deviceId: string) => Promise<boolean>
    /** Supplies newly paired and currently active devices without a restart. */
    listTrustedDevices?: () => Promise<readonly import('./config').MatrixGatewayTrustedDevice[]>
    /** Creates a short-lived pairing offer authorized by an active PWA. */
    createDeviceInvitation?: (input: {
        requestedByDeviceId: string
        commandId: string
        lifetimeMs?: number
    }) => Promise<{
        pairingLink: string
        expiresAt: number
    }>
}

export type MatrixGatewayState = 'stopped' | 'starting' | 'running' | 'stopping'

export class MatrixGatewayRunner {
    private readonly client: MatrixGatewayClient
    private readonly replayStore: FileCommandReplayStore
    private readonly runtimeStateStore: FileGatewayRuntimeStateStore
    private readonly authorizer: StrictMatrixCommandAuthorizer
    private readonly secureContent: GatewaySecureContentLayer | null
    private readonly rooms = new Map<string, RoomRuntime>()
    private state: MatrixGatewayState = 'stopped'
    private unsubscribe: (() => void) | null = null
    private startupEvents: MatrixIncomingEvent[] = []
    private eventChain: Promise<void> = Promise.resolve()
    private readonly executionTasks = new Set<Promise<void>>()
    private readonly sessionMutationChains = new Map<string, Promise<void>>()
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
            await this.secureContent!.sendGatewayState(
                runtime.config,
                await this.gatewayStateSnapshot(runtime),
                this.client,
            )
        }))
    }

    private async gatewayStateSnapshot(runtime: RoomRuntime): Promise<GatewayStateSnapshot> {
        const revision = await this.replayStore.getConversationRevision(
            this.config.gatewayId,
            runtime.config.conversationId,
            runtime.revisionEpoch,
        )
        let models: GatewayStateSnapshot['capabilities']['models'] = []
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
        return {
            revision,
            revisionEpoch: runtime.revisionEpoch,
            revisionEpochGeneration: runtime.revisionEpochGeneration,
            stateVersion: runtime.stateVersion,
            // Session selection is a per-device PWA view concern. It is
            // deliberately absent from Gateway-authoritative state.
            currentSessionId: null,
            sessions: [
                ...[...runtime.appSessions.values()].map(({ record, session, activity }) =>
                    gatewaySessionSummary(
                        record,
                        gatewaySessionStatus(session.state, activity.phase),
                        false,
                        activity.phase,
                    )),
                ...[...runtime.archivedSessions.values()].map(record =>
                    gatewaySessionSummary(record, 'idle', true)),
            ].sort((left, right) => right.updatedAt - left.updatedAt),
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
                canSelectSession: false,
                canArchiveSession: true,
                canDeleteSession: true,
            },
        }
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
        if (extension?.version === 1 && extension.kind === 'gateway_state_request') {
            if (!opened || !this.secureContent) {
                throw new Error('Gateway state recovery requires an authenticated application envelope')
            }
            const request = gatewayStateRequestSchema.parse(extension.gateway_state_request)
            const now = this.now()
            if (request.expiresAt <= now || request.issuedAt > now + 30_000) {
                throw new Error('Gateway state request is outside its validity window')
            }
            if (
                request.gatewayId !== this.config.gatewayId
                || request.conversationId !== runtime.config.conversationId
                || request.deviceId !== opened.authenticatedDeviceId
            ) {
                throw new Error('Gateway state request route does not match its secure envelope')
            }
            if (
                this.dependencies.isTrustedDeviceActive
                && !(await this.dependencies.isTrustedDeviceActive(request.deviceId))
            ) {
                throw new Error(`Codever device ${request.deviceId} has been revoked`)
            }
            const task = this.gatewayStateSnapshot(runtime)
                .then(state => this.secureContent!.sendGatewayStateToDevice(
                    runtime.config,
                    opened.authenticatedDeviceId,
                    state,
                    request.requestId,
                    this.client,
                ))
                .then(() => undefined)
                .catch(error => {
                    this.dependencies.onRejected?.(event, error)
                    this.log(
                        `[matrix-gateway] state recovery ${request.requestId} failed: `
                        + formatError(error),
                    )
                })
                .finally(() => this.executionTasks.delete(task))
            this.executionTasks.add(task)
            return
        }
        if (extension?.version === 1 && extension.kind === 'history_request') {
            if (!opened || !this.secureContent) {
                throw new Error('History recovery requires an authenticated application envelope')
            }
            const request = historyRequestSchema.parse(extension.history_request)
            const now = this.now()
            if (request.expiresAt <= now || request.issuedAt > now + 30_000) {
                throw new Error('History recovery request is outside its validity window')
            }
            if (
                request.gatewayId !== this.config.gatewayId
                || request.conversationId !== runtime.config.conversationId
                || request.deviceId !== opened.authenticatedDeviceId
            ) {
                throw new Error('History recovery request route does not match its secure envelope')
            }
            if (
                this.dependencies.isTrustedDeviceActive
                && !(await this.dependencies.isTrustedDeviceActive(request.deviceId))
            ) {
                throw new Error(`Codever device ${request.deviceId} has been revoked`)
            }
            const task = this.secureContent.sendHistoryPage(
                runtime.config,
                opened.authenticatedDeviceId,
                request,
                this.client,
            )
                .then(() => undefined)
                .catch(error => {
                    this.dependencies.onRejected?.(event, error)
                    this.log(
                        `[matrix-gateway] history recovery ${request.requestId} failed: `
                        + formatError(error),
                    )
                })
                .finally(() => this.executionTasks.delete(task))
            this.executionTasks.add(task)
            return
        }
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
                const appSession = this.requireAppSession(
                    runtime,
                    authorized.command.payload.sessionId,
                )
                if (appSession.record.title === 'New session') {
                    appSession.record.title = sessionTitle(
                        authorized.command.payload.text
                        || authorized.command.payload.attachments?.[0]?.name
                        || '',
                    )
                }
                await this.persistRuntime(runtime)
                collaborationDelivery = this.secureContent.sendCollaborationPrompt(runtime.config, {
                    commandId: authorized.command.commandId,
                    revision: authorized.revision,
                    sessionId: appSession.record.id,
                    originDeviceId: authorized.command.deviceId,
                    originDeviceName: opened?.trustedDevice.deviceName
                        ?? opened?.trustedDevice.deviceId
                        ?? authorized.command.deviceId,
                    text: authorized.command.payload.text,
                    attachments: authorized.command.payload.attachments,
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
            const terminal = await this.replayStore.getCommandResult(
                authorized.command,
                authorized.command.sequenceEpoch,
            )
            if (terminal) {
                const task = this.deliverCommandResult(runtime, authorized.command, terminal)
                    .finally(() => this.executionTasks.delete(task))
                this.executionTasks.add(task)
            } else if (authorized.command.payload.operation === 'device.invite') {
                // Invitation creation is keyed by commandId in the durable
                // pairing registry. It is therefore safe to resume the only
                // side effect whose result may have been interrupted between
                // offer creation and command-result journaling.
                this.scheduleExecution(
                    event,
                    runtime,
                    authorized.command,
                    authorized.revision,
                )
            } else {
                // A retried signed command is never executed twice, but it is
                // an explicit recovery opportunity for missing recipient
                // copies already staged in the delivery WAL.
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
            let executionResult: CommandExecutionResult = {
                sessionId: commandSessionId(command),
            }
            try {
                await beforeExecute
                executionResult = await this.execute(runtime, command)
            } catch (error) {
                outcome = 'failed'
                executionError = error
                this.dependencies.onRejected?.(event, error)
                this.log(`[matrix-gateway] command ${command.commandId} failed: ${formatError(error)}`)
            }

            const terminal: DurableCommandResult = {
                revision,
                outcome,
                ...(executionError === undefined
                    ? {}
                    : { error: formatError(executionError) }),
                sessionId: executionResult.sessionId,
                ...(executionResult.result === undefined
                    ? {}
                    : { result: executionResult.result }),
            }
            try {
                // Persist the terminal result before staging any Matrix copy.
                // An exact duplicate command can then recover after a Gateway
                // restart without repeating the side effect.
                await this.replayStore.recordCommandResult(
                    command,
                    terminal,
                    command.sequenceEpoch,
                )
            } catch (persistenceError) {
                this.log(
                    `[matrix-gateway] ${outcome} result persistence failed: `
                    + formatError(persistenceError),
                )
            }
            try {
                await this.deliverCommandResult(runtime, command, terminal)
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

    private async deliverCommandResult(
        runtime: RoomRuntime,
        command: CodeverCommand,
        terminal: DurableCommandResult,
    ): Promise<void> {
        await this.secureContent?.sendCommandResult(
            runtime.config,
            command.deviceId,
            command.commandId,
            command.sequence,
            terminal.revision,
            runtime.revisionEpoch,
            terminal.outcome,
            this.client,
            terminal.error,
            terminal.sessionId,
            terminal.result,
        )
    }

    private async execute(
        runtime: RoomRuntime,
        command: CodeverCommand,
    ): Promise<CommandExecutionResult> {
        switch (command.payload.operation) {
            case 'prompt': {
                const appSession = this.requireAppSession(
                    runtime,
                    command.payload.sessionId,
                )
                if (appSession.record.title === 'New session') {
                    appSession.record.title = sessionTitle(
                        command.payload.text
                        || command.payload.attachments?.[0]?.name
                        || '',
                    )
                }
                const richInput = await materializePromptInput(
                    command.payload,
                    this.client,
                    `${this.config.replayLedgerPath}.attachments`,
                )
                await appSession.session.dispatch({
                    kind: 'user_message',
                    text: command.payload.text,
                    richInput,
                    source: 'channel',
                    user: { id: command.deviceId, username: command.deviceId },
                })
                this.updateAppSessionRecord(appSession)
                await this.persistRuntime(runtime)
                return { sessionId: appSession.record.id }
            }
            case 'cancel': {
                const appSession = this.requireAppSession(
                    runtime,
                    command.payload.sessionId,
                )
                await appSession.session.dispatch({
                    kind: 'cancel',
                    reason: 'user',
                    source: 'channel',
                    user: { id: command.deviceId, username: command.deviceId },
                })
                return { sessionId: appSession.record.id }
            }
            case 'decision': {
                const appSession = this.requireAppSession(
                    runtime,
                    command.payload.sessionId,
                )
                const value = command.payload.decision === 'deny' ? 'deny' : 'allow'
                if (!appSession.port.resolveDecision(command.payload.requestId, value)) {
                    throw new Error(`Unknown or invalid decision request ${command.payload.requestId}`)
                }
                return { sessionId: appSession.record.id }
            }
            case 'session.settings': {
                const appSession = this.requireAppSession(
                    runtime,
                    command.payload.sessionId,
                )
                await this.applySessionSettings(appSession, command, command.payload)
                await this.persistRuntime(runtime)
                return { sessionId: appSession.record.id }
            }
            case 'session.create': {
                const record = await this.createAppSessionRecord(
                    runtime,
                    command.payload,
                )
                const appSession = this.createAppSessionRuntime(runtime, record)
                runtime.appSessions.set(record.id, appSession)
                try {
                    await this.persistRuntime(runtime)
                } catch (error) {
                    runtime.appSessions.delete(record.id)
                    appSession.port.close()
                    await appSession.session.destroy().catch(destroyError => {
                        this.log(
                            `[matrix-gateway] rolled-back app session ${record.id} destroy failed: `
                            + formatError(destroyError),
                        )
                    })
                    throw error
                }
                return { sessionId: record.id }
            }
            case 'session.archive': {
                const { sessionId } = command.payload
                return this.serializeSessionMutation(
                    runtime,
                    sessionId,
                    () => this.archiveAppSession(runtime, sessionId),
                )
            }
            case 'session.restore': {
                const { sessionId } = command.payload
                return this.serializeSessionMutation(
                    runtime,
                    sessionId,
                    () => this.restoreAppSession(runtime, sessionId),
                )
            }
            case 'session.delete': {
                const { sessionId } = command.payload
                return this.serializeSessionMutation(
                    runtime,
                    sessionId,
                    () => this.deleteAppSession(runtime, sessionId),
                )
            }
            case 'device.invite': {
                if (!this.dependencies.createDeviceInvitation) {
                    throw new Error('This Gateway host does not support PWA-created device invitations')
                }
                const invitation = await this.dependencies.createDeviceInvitation({
                    requestedByDeviceId: command.deviceId,
                    commandId: command.commandId,
                    ...(command.payload.lifetimeMs === undefined
                        ? {}
                        : { lifetimeMs: command.payload.lifetimeMs }),
                })
                return {
                    sessionId: null,
                    result: {
                        pairingLink: invitation.pairingLink,
                        expiresAt: invitation.expiresAt,
                    },
                }
            }
        }
    }

    private async applySessionSettings(
        appSession: AppSessionRuntime,
        command: CodeverCommand,
        settings: WorkspaceSettingsInput,
    ): Promise<void> {
        const current = workspaceFromRecord(appSession.record)
        const providerName = settings.provider ?? current.provider
        const providerChanged = providerName !== current.provider
        const targetProvider = providerChanged
            ? getProvider(providerName)
            : appSession.capabilityProvider
        if (!targetProvider) {
            throw new Error(`Provider ${providerName} is not configured`)
        }
        const availableModels = targetProvider.getAvailableModels()
        const requestedModel = settings.model !== undefined
            ? settings.model
            : providerChanged
                ? null
                : current.model
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
        const modelChanged = modelId !== current.model
        const requestedReasoningEffort = settings.reasoningEffort !== undefined
            ? settings.reasoningEffort
            : providerChanged || modelChanged
                ? selectedModel?.defaultReasoningLevel ?? null
                : current.reasoningEffort
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
        const permissionMode = settings.permissionMode ?? current.permissionMode
        if (permissionMode !== 'default') {
            throw new Error(`Permission mode ${permissionMode} is not currently available`)
        }

        let project = {
            id: current.projectId,
            name: current.projectName,
            cwd: current.cwd,
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
            project = gatewayProjectIdentity(current.cwd, settings.projectName)
        }

        if (providerChanged) {
            await dispatchCommand(appSession.session, command, 'provider', providerName)
        }
        if (project.cwd !== current.cwd) {
            await dispatchCommand(appSession.session, command, 'cwd', project.cwd)
        }
        if (providerChanged || modelChanged || settings.model !== undefined) {
            await dispatchCommand(appSession.session, command, 'model', modelId ?? '')
        }
        if (
            providerChanged
            || modelChanged
            || requestedReasoningEffort !== current.reasoningEffort
            || settings.reasoningEffort !== undefined
        ) {
            await dispatchCommand(
                appSession.session,
                command,
                'reasoningEffort',
                requestedReasoningEffort ?? '',
            )
        }
        if (permissionMode !== current.permissionMode) {
            await dispatchCommand(appSession.session, command, 'permissionMode', permissionMode)
        }

        Object.assign(appSession.record, {
            projectId: project.id,
            projectName: project.name,
            cwd: project.cwd,
            provider: providerName,
            model: modelId,
            reasoningEffort: requestedReasoningEffort,
            permissionMode,
            providerSessionId: appSession.session.sessionRecord.conversationId,
            updatedAt: this.now(),
        })
        appSession.capabilityProvider = targetProvider
    }

    private requireAppSession(
        runtime: RoomRuntime,
        sessionId: string,
    ): AppSessionRuntime {
        const appSession = runtime.appSessions.get(sessionId)
        if (!appSession) throw new Error(`Unknown app session ${sessionId}`)
        return appSession
    }

    private requireArchivedSession(
        runtime: RoomRuntime,
        sessionId: string,
    ): AppSessionRecord {
        const record = runtime.archivedSessions.get(sessionId)
        if (!record) throw new Error(`App session ${sessionId} is not archived`)
        return record
    }

    private serializeSessionMutation<T>(
        runtime: RoomRuntime,
        sessionId: string,
        operation: () => Promise<T>,
    ): Promise<T> {
        const key = `${runtime.config.roomId}\0${sessionId}`
        const previous = this.sessionMutationChains.get(key) ?? Promise.resolve()
        const result = previous.then(operation)
        const settled = result.then(() => undefined, () => undefined)
        this.sessionMutationChains.set(key, settled)
        void settled.then(() => {
            if (this.sessionMutationChains.get(key) === settled) {
                this.sessionMutationChains.delete(key)
            }
        })
        return result
    }

    private async archiveAppSession(
        runtime: RoomRuntime,
        sessionId: string,
    ): Promise<CommandExecutionResult> {
        const appSession = this.requireAppSession(runtime, sessionId)
        this.updateAppSessionRecord(appSession)
        try {
            await this.destroyAppSessionRuntime(appSession)
        } catch (error) {
            runtime.appSessions.set(
                appSession.record.id,
                this.createAppSessionRuntime(runtime, appSession.record),
            )
            throw error
        }
        runtime.appSessions.delete(appSession.record.id)
        appSession.record.archivedAt = this.now()
        appSession.record.updatedAt = appSession.record.archivedAt
        runtime.archivedSessions.set(appSession.record.id, appSession.record)
        try {
            await this.persistRuntime(runtime)
        } catch (error) {
            runtime.archivedSessions.delete(appSession.record.id)
            appSession.record.archivedAt = null
            runtime.appSessions.set(
                appSession.record.id,
                this.createAppSessionRuntime(runtime, appSession.record),
            )
            throw error
        }
        return { sessionId: appSession.record.id }
    }

    private async restoreAppSession(
        runtime: RoomRuntime,
        sessionId: string,
    ): Promise<CommandExecutionResult> {
        const record = this.requireArchivedSession(runtime, sessionId)
        const archivedAt = record.archivedAt
        const updatedAt = record.updatedAt
        record.archivedAt = null
        record.updatedAt = this.now()
        const appSession = this.createAppSessionRuntime(runtime, record)
        runtime.archivedSessions.delete(record.id)
        runtime.appSessions.set(record.id, appSession)
        try {
            await this.persistRuntime(runtime)
        } catch (error) {
            runtime.appSessions.delete(record.id)
            record.archivedAt = archivedAt
            record.updatedAt = updatedAt
            runtime.archivedSessions.set(record.id, record)
            await this.destroyAppSessionRuntime(appSession).catch(destroyError => {
                this.log(
                    `[matrix-gateway] rolled-back restored session ${record.id} destroy failed: `
                    + formatError(destroyError),
                )
            })
            throw error
        }
        return { sessionId: record.id }
    }

    private async deleteAppSession(
        runtime: RoomRuntime,
        sessionId: string,
    ): Promise<CommandExecutionResult> {
        const active = runtime.appSessions.get(sessionId)
        const archived = runtime.archivedSessions.get(sessionId)
        if (!active && !archived) throw new Error(`Unknown app session ${sessionId}`)
        const record = active?.record ?? archived!
        if (active) {
            this.updateAppSessionRecord(active)
            try {
                await this.destroyAppSessionRuntime(active)
            } catch (error) {
                runtime.appSessions.set(
                    record.id,
                    this.createAppSessionRuntime(runtime, record),
                )
                throw error
            }
            runtime.appSessions.delete(record.id)
        } else {
            runtime.archivedSessions.delete(record.id)
        }
        try {
            await this.persistRuntime(runtime)
        } catch (error) {
            if (record.archivedAt === null) {
                runtime.appSessions.set(
                    record.id,
                    this.createAppSessionRuntime(runtime, record),
                )
            } else {
                runtime.archivedSessions.set(record.id, record)
            }
            throw error
        }
        return { sessionId: record.id }
    }

    private async createAppSessionRecord(
        runtime: RoomRuntime,
        settings: WorkspaceSettingsInput,
    ): Promise<AppSessionRecord> {
        const workspace = await resolveWorkspaceSettings(
            runtime.workspace,
            settings,
            runtime.capabilityProvider,
        )
        return {
            id: randomUUID(),
            title: 'New session',
            updatedAt: this.now(),
            projectId: workspace.projectId,
            projectName: workspace.projectName,
            cwd: workspace.cwd,
            provider: workspace.provider,
            model: workspace.model,
            reasoningEffort: workspace.reasoningEffort,
            permissionMode: workspace.permissionMode,
            providerSessionId: null,
            archivedAt: null,
        }
    }

    private updateAppSessionRecord(appSession: AppSessionRuntime): void {
        appSession.record.providerSessionId =
            appSession.session.sessionRecord.conversationId
        appSession.record.updatedAt = this.now()
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
            const runtime: RoomRuntime = {
                config: room,
                capabilityProvider: getProvider(restored.workspace.provider) ?? null,
                workspace: structuredClone(restored.workspace),
                appSessions: new Map(),
                archivedSessions: new Map(),
                revisionEpoch: restored.revisionEpoch,
                revisionEpochGeneration: restored.revisionEpochGeneration,
                replayGeneration: restored.replayGeneration,
                stateVersion: restored.stateVersion,
            }
            // Register before restoring children so startup cleanup can destroy
            // any earlier child if a later app-session factory fails.
            this.rooms.set(room.roomId, runtime)
            for (const persisted of restored.appSessions) {
                const record = { ...persisted }
                if (record.archivedAt !== null) {
                    runtime.archivedSessions.set(record.id, record)
                } else {
                    runtime.appSessions.set(
                        record.id,
                        this.createAppSessionRuntime(runtime, record),
                    )
                }
            }
        }
    }

    private createAppSessionRuntime(
        runtime: RoomRuntime,
        record: AppSessionRecord,
    ): AppSessionRuntime {
        const effectiveRoom = roomConfigForSession(runtime.config, record)
        const activity = { phase: 'idle' as AgentActivityPhase }
        const port = new MatrixPort({
            transport: this.secureContent
                ? this.secureContent.transportForRoom(runtime.config, this.client)
                : this.client,
            roomId: runtime.config.roomId,
            gatewayId: this.config.gatewayId,
            sessionId: record.id,
            onLog: this.dependencies.onLog,
            onStatusChange: status => {
                activity.phase = status.activity ?? activityForSessionStatus(status)
                void this.syncState(runtime.config.roomId).catch(error => {
                    this.log(
                        `[matrix-gateway] session status sync failed for ${record.id}: `
                        + formatError(error),
                    )
                })
            },
        })
        let capabilityProvider: AgentProvider | null
        let session: TopicSession
        if (this.dependencies.sessionFactory) {
            session = this.dependencies.sessionFactory(effectiveRoom, port, record)
            session.sessionRecord.setConversationId(record.providerSessionId)
            capabilityProvider = getProvider(record.provider) ?? null
        } else {
            const provider = this.dependencies.providerFactory?.(effectiveRoom, record)
                ?? createProviderInstance(record.provider)
            if (!provider) {
                port.close()
                throw new Error(
                    `Matrix app session ${record.id} provider ${record.provider} is unavailable`,
                )
            }
            capabilityProvider = provider
            session = this.createDefaultSession(effectiveRoom, port, provider, record)
        }
        return { record, port, session, capabilityProvider, activity }
    }

    private createDefaultSession(
        room: MatrixGatewayRoomConfig,
        port: MatrixPort,
        provider: AgentProvider,
        appSession: AppSessionRecord,
    ): TopicSession {
        const sessionRecord = createTopicSessionRecord({
            cwd: room.cwd,
            providerName: room.providerName,
            groupChatId: numericRoomCompatibilityId(
                `${room.roomId}\0${appSession.id}`,
            ),
            model: room.model,
            verboseLevel: room.verboseLevel,
            timeoutSeconds: room.timeoutSeconds,
            providerSettings: room.providerSettings,
            conversationId: appSession.providerSessionId,
        })
        return createTopicSession({ sessionRecord, provider, channelPort: port })
    }

    private async destroyAppSessionRuntime(appSession: AppSessionRuntime): Promise<void> {
        try {
            await appSession.session.destroy()
        } finally {
            appSession.port.close()
        }
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
            for (const appSession of runtime.appSessions.values()) {
                appSession.port.close()
                await appSession.session.destroy().catch(error => {
                    this.log(
                        `[matrix-gateway] app session ${appSession.record.id} destroy failed: `
                        + formatError(error),
                    )
                })
            }
        }
        await Promise.allSettled([...this.executionTasks])
        this.executionTasks.clear()
        this.sessionMutationChains.clear()
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
        currentSessionId: null,
        appSessions: [...runtime.appSessions.values()].map(({ record }) => ({
            ...record,
        })).concat([...runtime.archivedSessions.values()].map(record => ({ ...record }))),
        workspace: structuredClone(runtime.workspace),
    }
}

function commandSessionId(command: CodeverCommand): string | null {
    switch (command.payload.operation) {
        case 'session.create':
        case 'device.invite':
            return null
        case 'prompt':
        case 'cancel':
        case 'decision':
        case 'session.settings':
        case 'session.archive':
        case 'session.restore':
        case 'session.delete':
            return command.payload.sessionId
    }
}

function gatewaySessionSummary(
    record: AppSessionRecord,
    status: 'idle' | 'running' | 'stopping' | 'failed',
    archived = false,
    activityPhase?: AgentActivityPhase,
) {
    return {
        id: record.id,
        title: record.title,
        updatedAt: record.updatedAt,
        status,
        ...(activityPhase ? { activityPhase } : {}),
        ...(archived ? { archived: true } : {}),
        projectId: record.projectId,
        projectName: record.projectName,
        cwd: record.cwd,
        provider: record.provider,
        ...(record.model ? { model: record.model } : {}),
        ...(record.reasoningEffort
            ? { reasoningEffort: record.reasoningEffort }
            : {}),
    }
}

function workspaceFromRecord(record: AppSessionRecord): WorkspaceState {
    return {
        projectId: record.projectId,
        projectName: record.projectName,
        cwd: record.cwd,
        provider: record.provider,
        model: record.model,
        reasoningEffort: record.reasoningEffort,
        permissionMode: record.permissionMode,
    }
}

function gatewaySessionStatus(
    state: TopicSession['state'],
    activityPhase?: AgentActivityPhase,
): 'idle' | 'running' | 'stopping' | 'failed' {
    if (activityPhase === 'starting' || activityPhase === 'working') return 'running'
    if (activityPhase === 'stopping') return 'stopping'
    if (activityPhase === 'failed') return 'failed'
    switch (state) {
        case 'querying':
            return 'running'
        case 'canceling':
            return 'stopping'
        case 'dead':
            return 'failed'
        case 'idle':
            return 'idle'
    }
}

function activityForSessionStatus(status: SessionStatus): AgentActivityPhase {
    switch (status.state) {
        case 'querying':
            return 'working'
        case 'canceling':
            return 'stopping'
        case 'dead':
            return 'failed'
        case 'idle':
            return 'idle'
    }
}

function roomConfigForSession(
    room: MatrixGatewayRoomConfig,
    session: AppSessionRecord,
): MatrixGatewayRoomConfig {
    const { model: _configuredModel, ...roomWithoutModel } = room
    return {
        ...roomWithoutModel,
        cwd: session.cwd,
        providerName: session.provider,
        ...(session.model ? { model: session.model } : {}),
        providerSettings: {
            ...(room.providerSettings ?? {}),
            ...(session.reasoningEffort
                ? { reasoningEffort: session.reasoningEffort }
                : {}),
            permissionMode: session.permissionMode,
        },
    }
}

async function resolveWorkspaceSettings(
    current: WorkspaceState,
    settings: WorkspaceSettingsInput,
    currentCapabilityProvider: AgentProvider | null,
): Promise<WorkspaceState> {
    const providerName = settings.provider ?? current.provider
    const providerChanged = providerName !== current.provider
    const targetProvider = providerChanged
        ? getProvider(providerName)
        : currentCapabilityProvider ?? getProvider(providerName)
    if (!targetProvider) {
        throw new Error(`Provider ${providerName} is not configured`)
    }
    const availableModels = targetProvider.getAvailableModels()
    const requestedModel = settings.model !== undefined
        ? settings.model
        : providerChanged
            ? null
            : current.model
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
    const model = selectedModel?.id ?? null
    const modelChanged = model !== current.model
    const reasoningEffort = settings.reasoningEffort !== undefined
        ? settings.reasoningEffort
        : providerChanged || modelChanged
            ? selectedModel?.defaultReasoningLevel ?? null
            : current.reasoningEffort
    if (reasoningEffort) {
        if (!selectedModel) {
            throw new Error('Select a model before setting reasoning effort')
        }
        if (
            !(selectedModel.supportedReasoningLevels ?? [])
                .some(level => level.effort === reasoningEffort)
        ) {
            throw new Error(
                `Reasoning effort ${reasoningEffort} is not available for model ${selectedModel.id}`,
            )
        }
    }
    const permissionMode = settings.permissionMode ?? current.permissionMode
    if (permissionMode !== 'default') {
        throw new Error(`Permission mode ${permissionMode} is not currently available`)
    }
    let project = {
        id: current.projectId,
        name: current.projectName,
        cwd: current.cwd,
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
        project = gatewayProjectIdentity(current.cwd, settings.projectName)
    }
    return {
        projectId: project.id,
        projectName: project.name,
        cwd: project.cwd,
        provider: providerName,
        model,
        reasoningEffort,
        permissionMode,
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
    'pairing_rejection',
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
