import { createHash, randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute, win32 } from 'node:path'
import {
    CODEVER_MATRIX_APPLICATION_CONTROL_EVENT_TYPE,
    capabilityRenewalRequestSchema,
    CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE,
    CODEVER_MATRIX_SESSION_DIRECTORY_EVENT_TYPE,
    CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE,
    canonicalJson,
    type CodeverCommand,
    type CapabilityRenewalRequest,
    type JsonValue,
    type MatrixGatewayCapabilities,
    type MatrixRoomSession,
    type MatrixSessionDirectoryDescriptor,
    type MatrixSessionState,
    type SessionExtensionBinding,
    type SessionExtensionSummary,
} from '@codever/protocol'
import type { AgentProvider } from '@/providers/provider'
import { createProviderInstance, getProvider, listProviders } from '@/providers/registry'
import {
    ChannelDeliveryQueuedError,
    type AgentActivityPhase,
    type SessionStatus,
    type TopicSession,
} from '@/bridge/channelPort'
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
import { SessionExtensionRegistry } from '@/runtime/sessionExtensions'

type WorkspaceState = PersistedRoomRuntimeState['workspace']
const CANONICAL_COMMAND_ACK_DELAY_MS = 2_000
// Entity state is the realtime path, while the immutable directory is the
// reconnect/cold-start barrier. Keep a short burst window so rapid lifecycle
// changes share one directory publication without leaving other devices on a
// stale inventory for ten seconds after create/delete.
const ROOM_SNAPSHOT_DEBOUNCE_MS = 1_000

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
    deletedSessionIds: Set<string>
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
    extensions?: SessionExtensionBinding[]
    providerSessionId?: string
    title?: string
}

interface CommandExecutionResult {
    sessionId: string | null
    result?: JsonValue
    nativeRevisionPublished?: boolean
    canonicalCompletionPublished?: boolean
}

interface NativeRevision {
    revision: number
    revision_epoch: string
    revision_epoch_generation: number
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
    /** Locally installed, administrator-controlled session extensions. */
    sessionExtensionRegistry?: SessionExtensionRegistry
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
    private readonly secureContent: GatewaySecureContentLayer
    private readonly sessionExtensionRegistry: SessionExtensionRegistry
    private readonly rooms = new Map<string, RoomRuntime>()
    private state: MatrixGatewayState = 'stopped'
    private unsubscribe: (() => void) | null = null
    private startupEvents: MatrixIncomingEvent[] = []
    private eventChain: Promise<void> = Promise.resolve()
    private readonly executionTasks = new Set<Promise<void>>()
    private readonly activeCommandExecutions = new Map<string, Promise<void>>()
    private readonly sessionMutationChains = new Map<string, Promise<void>>()
    private readonly roomStateChains = new Map<string, Promise<void>>()
    private readonly dirtySessionStates = new Map<string, Set<string>>()
    private readonly sessionStateCommandSources = new Map<string, Map<string, string>>()
    private readonly sessionStatePublishTasks = new Map<string, Promise<void>>()
    private readonly roomSnapshotTimers = new Map<string, ReturnType<typeof setTimeout>>()
    private readonly lastGatewayStatePublishedAt = new Map<string, number>()
    private startupFailure: Error | null = null
    private stopPromise: Promise<void> | null = null
    private gatewayHeartbeatTimer: ReturnType<typeof setInterval> | null = null

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
        this.sessionExtensionRegistry = dependencies.sessionExtensionRegistry
            ?? new SessionExtensionRegistry()
        this.secureContent = new GatewaySecureContentLayer(
            config.gatewayId,
            config.applicationSecurity,
            config.trustedDevices,
            dependencies.listTrustedDevices,
        )
    }

    getState(): MatrixGatewayState {
        return this.state
    }

    async syncState(roomId?: string): Promise<void> {
        const runtimes = roomId
            ? [this.rooms.get(roomId)].filter((runtime): runtime is RoomRuntime => runtime !== undefined)
            : [...this.rooms.values()]
        await Promise.all(runtimes.map(runtime => this.serializeRoomState(runtime, async () => {
            // An unpaired room has no application-layer recipient and must not
            // manufacture undecryptable state. Its durable runtime remains
            // authoritative locally; pairing provisioning will publish it.
            if (await this.secureContent.activeDeviceCountForRoom(runtime.config) === 0) return
            const stateVersion = await this.advanceStateVersion(runtime)
            const snapshot = await this.gatewayStateSnapshot(runtime)
            const revision = {
                revision: snapshot.revision,
                revision_epoch: snapshot.revisionEpoch,
                revision_epoch_generation: snapshot.revisionEpochGeneration,
            }
            const updatedAt = this.now()
            const desiredStates = [
                ...snapshot.sessions.map(session =>
                nativeSessionState(
                    this.config.gatewayId,
                    runtime,
                    session,
                    stateVersion,
                    revision,
                    updatedAt,
                )),
                ...[...runtime.deletedSessionIds].map(sessionId => ({
                    version: 2 as const,
                    kind: 'session_state' as const,
                    gateway_id: this.config.gatewayId,
                    conversation_id: runtime.config.conversationId,
                    ...revision,
                    state_version: stateVersion,
                    session_id: sessionId,
                    state: 'deleted' as const,
                    updated_at: updatedAt,
                })),
            ]
            const published = new Map(
                this.secureContent.latestNativeRoomState(runtime.config.roomId)
                    .filter(state => state.kind === 'session_state')
                    .map(state => [state.session_id, state]),
            )
            const changedStates = desiredStates.filter(state =>
                !sameSessionEntity(state, published.get(state.session_id))
            )
            const directory = await this.publishNativeSessionDirectory(
                runtime,
                snapshot,
                stateVersion,
                revision,
                updatedAt,
            )
            const gatewayState = await this.gatewayRoomState(
                runtime,
                snapshot,
                stateVersion,
                revision,
                updatedAt,
                directory,
            )
            if (changedStates.length > 0) {
                await this.secureContent.setNativeRoomStateBatch(
                    runtime.config,
                    changedStates.map(content => ({
                        eventType: CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE,
                        stateKey: content.session_id,
                        content,
                    })),
                    this.client,
                )
            }
            // Directory pages are published first and individual entity
            // updates second. The Gateway entity is the commit marker that
            // makes the new immutable directory generation discoverable.
            await this.secureContent.setNativeRoomState(
                runtime.config,
                CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE,
                this.config.gatewayId,
                gatewayState,
                this.client,
            )
            this.lastGatewayStatePublishedAt.set(runtime.config.roomId, this.now())
        })))
    }

    /**
     * Pairing commit barrier: establish immutable thread roots and then write
     * the complete current Room State addressed to the newly active device.
     * A pairing response must not be sent until this resolves.
     */
    async provisionCurrentState(): Promise<void> {
        if (this.state !== 'running') {
            throw new Error(`Cannot provision Matrix state while Gateway is ${this.state}`)
        }
        await this.ensureSessionRoots()
        await this.syncState()
    }

    private async advanceStateVersion(runtime: RoomRuntime): Promise<number> {
        const stateVersion = await this.runtimeStateStore.incrementStateVersion(
            runtime.config.roomId,
            runtimeStateWithoutVersion(runtime),
        )
        runtime.stateVersion = Math.max(runtime.stateVersion, stateVersion)
        return stateVersion
    }

    private serializeRoomState<T>(runtime: RoomRuntime, operation: () => Promise<T>): Promise<T> {
        const key = runtime.config.roomId
        const previous = this.roomStateChains.get(key) ?? Promise.resolve()
        const current = previous.catch(() => undefined).then(operation)
        const settled = current.then(() => undefined, () => undefined)
        this.roomStateChains.set(key, settled)
        void settled.then(() => {
            if (this.roomStateChains.get(key) === settled) this.roomStateChains.delete(key)
        })
        return current
    }

    private async publishGatewayState(
        runtime: RoomRuntime,
        snapshot: GatewayStateSnapshot,
        stateVersion: number,
        revision: NativeRevision,
        updatedAt: number,
    ): Promise<void> {
        const directory = await this.publishNativeSessionDirectory(
            runtime,
            snapshot,
            stateVersion,
            revision,
            updatedAt,
        )
        await this.secureContent.setNativeRoomState(
            runtime.config,
            CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE,
            this.config.gatewayId,
            await this.gatewayRoomState(
                runtime,
                snapshot,
                stateVersion,
                revision,
                updatedAt,
                directory,
            ),
            this.client,
        )
        this.lastGatewayStatePublishedAt.set(runtime.config.roomId, this.now())
    }

    private async gatewayRoomState(
        runtime: RoomRuntime,
        snapshot: GatewayStateSnapshot,
        stateVersion: number,
        revision: NativeRevision,
        updatedAt: number,
        sessionDirectory: MatrixSessionDirectoryDescriptor,
    ) {
        const activeDevices = await this.activeTrustedDevicesForRoom(runtime)
        const commandSequences = await Promise.all(activeDevices.map(async device => ({
            device_id: device.deviceId,
            sequence_epoch: device.sequenceEpoch,
            sequence: await this.replayStore.getCommandSequence(
                this.config.gatewayId,
                device.deviceId,
                runtime.config.conversationId,
                runtime.revisionEpoch,
                device.sequenceEpoch,
            ),
        })))
        return {
            version: 2 as const,
            kind: 'gateway_state' as const,
            gateway_id: this.config.gatewayId,
            conversation_id: runtime.config.conversationId,
            ...revision,
            state_version: stateVersion,
            active_device_count: activeDevices.length,
            command_sequences: commandSequences,
            workspace: {
                project: {
                    id: runtime.workspace.projectId,
                    name: runtime.workspace.projectName,
                    cwd: runtime.workspace.cwd,
                },
                provider: runtime.workspace.provider,
                ...(runtime.workspace.model ? { model: runtime.workspace.model } : {}),
                ...(runtime.workspace.reasoningEffort
                    ? { reasoning_effort: runtime.workspace.reasoningEffort }
                    : {}),
                permission_mode: runtime.workspace.permissionMode,
            },
            capabilities: nativeRoomStateCapabilities(snapshot.capabilities),
            session_directory: sessionDirectory,
            updated_at: updatedAt,
        }
    }

    private async publishNativeSessionDirectory(
        runtime: RoomRuntime,
        snapshot: GatewayStateSnapshot,
        stateVersion: number,
        revision: NativeRevision,
        updatedAt: number,
    ): Promise<MatrixSessionDirectoryDescriptor> {
        const sessions = snapshot.sessions
            .map(session => nativeSessionState(
                this.config.gatewayId,
                runtime,
                session,
                stateVersion,
                revision,
                updatedAt,
            ).session!)
            .sort((left, right) => left.session_id.localeCompare(right.session_id))
        const digest = createHash('sha256')
            .update(canonicalJson(sessions))
            .digest('base64url')
        const currentGateway = this.secureContent.latestNativeRoomState(runtime.config.roomId)
            .filter(state => state.kind === 'gateway_state')
            .sort((left, right) => right.state_version - left.state_version)[0]
        const current = currentGateway?.session_directory
        if (
            current?.digest === digest
            && currentGateway?.revision_epoch === revision.revision_epoch
            && currentGateway.revision_epoch_generation === revision.revision_epoch_generation
            // Equal inventory is not sufficient to reuse an older directory
            // watermark. A session can be created and deleted between two
            // snapshots, returning to the same digest while some clients have
            // observed only the transient active entity. Advancing the
            // descriptor lets the final snapshot prune every entity through
            // this state version. Heartbeats pass the existing state version
            // and still reuse the descriptor without extra directory writes.
            && current.state_version >= stateVersion
        ) return current

        const generation = Math.max(stateVersion, (current?.generation ?? -1) + 1)
        const slot = generation % 3
        const stateKeyPrefix = matrixDirectoryStateKeyPrefix(this.config.gatewayId)
        const pageSessions = packNativeSessionDirectoryPages(sessions, {
            gatewayId: this.config.gatewayId,
            conversationId: runtime.config.conversationId,
            revision,
            stateVersion,
            generation,
            slot,
            digest,
            stateKeyPrefix,
            updatedAt,
        })
        const descriptor: MatrixSessionDirectoryDescriptor = {
            generation,
            state_version: stateVersion,
            slot,
            page_count: pageSessions.length,
            state_key_prefix: stateKeyPrefix,
            digest,
        }
        if (pageSessions.length > 0) {
            await this.secureContent.setNativeRoomStateBatch(
                runtime.config,
                pageSessions.map((sessionsOnPage, pageIndex) => ({
                    eventType: CODEVER_MATRIX_SESSION_DIRECTORY_EVENT_TYPE,
                    stateKey: matrixDirectoryStateKey(descriptor, pageIndex),
                    content: nativeSessionDirectoryPage(
                        this.config.gatewayId,
                        runtime,
                        sessionsOnPage,
                        descriptor,
                        pageIndex,
                        stateVersion,
                        revision,
                        updatedAt,
                    ),
                })),
                this.client,
            )
        }
        return descriptor
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
                ...[...runtime.appSessions.values()].map(({ record, session, activity }) => ({
                    ...gatewaySessionSummary(
                        record,
                        gatewaySessionStatus(session.state, activity.phase),
                        false,
                        activity.phase,
                        this.sessionExtensionRegistry.summaries(record.extensions),
                    ),
                    ...(record.matrixThreadRootEventId
                        ? { threadRootEventId: record.matrixThreadRootEventId }
                        : {}),
                    availableCommands: session.sessionRecord.availableCommands,
                })),
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
                providers: listProviders().map(providerName => {
                    const provider = getProvider(providerName)!
                    const providerModels = providerName === runtime.workspace.provider
                        ? models
                        : provider.getAvailableModels()
                    return {
                        id: providerName,
                        name: providerName,
                        models: providerModels,
                        canListSessions: typeof provider.listSessions === 'function',
                        canInspectSessions: typeof provider.getSessionHistory === 'function',
                    }
                }),
                // The runtime currently always asks for permission. Do not
                // advertise modes whose policy is not actually enforced.
                permissionModes: [{ id: 'default', name: 'Default' }],
                canCreateSession: true,
                canSelectSession: false,
                canArchiveSession: true,
                canDeleteSession: false,
                sessionExtensions: this.sessionExtensionRegistry.descriptors(),
            },
        }
    }

    private async activeTrustedDevicesForRoom(
        runtime: RoomRuntime,
    ): Promise<readonly import('./config').MatrixGatewayTrustedDevice[]> {
        const devices = this.dependencies.listTrustedDevices
            ? await this.dependencies.listTrustedDevices()
            : this.config.trustedDevices
        const now = this.now()
        return devices
            .filter(device =>
                device.allowedRoomIds.includes(runtime.config.roomId)
                && device.certificateExpiresAt > now
            )
            .sort((left, right) => left.deviceId.localeCompare(right.deviceId))
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
            await this.secureContent.initialize(this.now())
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
                void this.secureContent.retryPendingForRoom(room, this.client).catch(error => {
                    this.log(
                        `[matrix-gateway] pending delivery recovery failed for ${room.roomId}: `
                        + formatError(error),
                    )
                    this.secureContent.scheduleRecoveryForRoom(room, this.client)
                })
            }
            if (this.startupFailure) throw this.startupFailure
            this.state = 'running'
            await this.ensureSessionRoots()
            await this.syncState().catch(error => {
                this.log(`[matrix-gateway] initial Room State sync failed: ${formatError(error)}`)
            })
            this.startGatewayHeartbeat()
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
        this.stopGatewayHeartbeat()
        this.stopPromise = (async () => {
            await this.eventChain
            // Command execution can enqueue lifecycle and Room State work.
            // Drain until the task set is stable before closing Matrix or
            // allowing test/deployment cleanup to remove durable stores.
            while (this.executionTasks.size > 0) {
                await Promise.allSettled([...this.executionTasks])
            }
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
        const applicationControl =
            event.eventType === CODEVER_MATRIX_APPLICATION_CONTROL_EVENT_TYPE
        if (!applicationControl && event.eventType !== 'm.room.message') return
        if (!applicationControl && isMatrixGatewayControlEvent(event.content)) return
        const runtime = this.rooms.get(event.roomId)
        if (!runtime) return
        if (!applicationControl) {
            const candidate = asRecord(event.content[CODEVER_MATRIX_EXTENSION])
            if (candidate?.kind === 'signed_command') {
                throw new Error('Commands require Codever application encryption')
            }
            return
        }

        const opened = await this.secureContent.openIncoming(
            event.content[CODEVER_MATRIX_EXTENSION],
            runtime.config,
            this.now(),
        )
        const extension = asRecord(
            opened.content[CODEVER_MATRIX_EXTENSION],
        )
        const capabilityRenewal = capabilityRenewalRequestSchema.safeParse(extension)
        if (capabilityRenewal.success) {
            await this.handleCapabilityRenewalRequest(
                runtime,
                opened,
                capabilityRenewal.data,
            )
            return
        }
        if (!extension || extension.version !== 1 || extension.kind !== 'signed_command') return
        this.authorizer.trustDevice(opened.trustedDevice)
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
                matrixDeviceKey: event.senderDeviceId ?? '',
                applicationDeviceId: opened.authenticatedDeviceId,
            }, this.now())
        } catch (error) {
            if (
                error instanceof RevisionConflictError
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
        this.log(
            `[matrix-gateway] command ${authorized.command.commandId} `
            + `${authorized.command.payload.operation} authorized at revision ${authorized.revision}`
            + (authorized.duplicate ? ' (duplicate)' : ''),
        )
        let commandCompletion: Promise<void> | undefined
        let terminalDeliveryAcknowledges = false
        if (authorized.terminal) {
            // Pre-release ledgers may still contain an already accepted
            // terminal result. Preserve duplicate recovery compatibility,
            // but new authenticated retries execute through the normal path.
            this.scheduleGatewayRevision(runtime, authorized.command.commandId)
            const task = this.deliverCommandResult(
                runtime,
                authorized.command,
                authorized.terminal,
            ).catch(error => {
                this.log(
                    `[matrix-gateway] legacy terminal result delivery failed: ${formatError(error)}`,
                )
            }).finally(() => this.executionTasks.delete(task))
            this.executionTasks.add(task)
            commandCompletion = task
            terminalDeliveryAcknowledges = true
        } else if (!authorized.duplicate) {
            let collaborationDelivery: Promise<unknown> | undefined
            if (authorized.command.payload.operation === 'prompt') {
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
                    revisionEpoch: runtime.revisionEpoch,
                    revisionEpochGeneration: runtime.revisionEpochGeneration,
                    sessionId: appSession.record.id,
                    threadRootEventId: appSession.record.matrixThreadRootEventId
                        ?? await this.ensureSessionRoot(
                            runtime,
                            appSession.record,
                            appSession.port,
                        ),
                    originDeviceId: authorized.command.deviceId,
                    originDeviceName: opened.trustedDevice.deviceName
                        ?? opened.trustedDevice.deviceId
                        ?? authorized.command.deviceId,
                    text: authorized.command.payload.text,
                    attachments: authorized.command.payload.attachments,
                }, this.client).catch(error => {
                    this.log(`[matrix-gateway] collaboration broadcast failed: ${formatError(error)}`)
                })
            }
            commandCompletion = this.scheduleExecution(
                event,
                runtime,
                authorized.command,
                authorized.revision,
                collaborationDelivery,
            )
        } else {
            const terminal = await this.replayStore.getCommandResult(authorized.command)
            if (terminal) {
                const task = this.deliverCommandResult(runtime, authorized.command, terminal)
                    .finally(() => this.executionTasks.delete(task))
                this.executionTasks.add(task)
                commandCompletion = task
                terminalDeliveryAcknowledges = true
            } else if (this.activeCommandExecutions.has(authorized.command.commandId)) {
                // An exact retry can race a still-running execution in the
                // same Gateway process. Let the original task own its one
                // terminal result; never manufacture an orphan result while
                // the command is genuinely active.
                commandCompletion = this.activeCommandExecutions.get(
                    authorized.command.commandId,
                )
            } else if (authorized.command.payload.operation === 'device.invite') {
                // Invitation creation is keyed by commandId in the durable
                // pairing registry. It is therefore safe to resume the only
                // side effect whose result may have been interrupted between
                // offer creation and command-result journaling.
                commandCompletion = this.scheduleExecution(
                    event,
                    runtime,
                    authorized.command,
                    authorized.revision,
                )
            } else {
                // The durable acceptance survived a Gateway restart but no
                // terminal result did. Re-executing an arbitrary command
                // would risk repeating its side effect; leaving it accepted
                // forever blocks the device's single command lane. Resolve it
                // once as an explicit non-retryable failure. Canonical Matrix
                // state/history remains authoritative for any side effect
                // that committed before the crash.
                const task = this.terminalizeOrphanedCommand(
                    runtime,
                    authorized.command,
                    authorized.revision,
                ).catch(error => {
                    this.log(
                        `[matrix-gateway] command ${authorized.command.commandId} orphan recovery failed: `
                        + formatError(error),
                    )
                }).finally(() => this.executionTasks.delete(task))
                this.executionTasks.add(task)
                commandCompletion = task
                terminalDeliveryAcknowledges = true
            }
        }
        if (!terminalDeliveryAcknowledges) {
            const sendAcknowledgement = (): void => {
                this.log(
                    `[matrix-gateway] command ${authorized.command.commandId} acknowledgement sending`,
                )
                // Matrix delivery is deliberately off the authorization lane.
                // A stalled homeserver must not delay execution, cancel, or
                // decisions.
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
            if (
                commandCompletion
                && usesCanonicalSessionCompletion(authorized.command.payload.operation)
            ) {
                // Fast desired-state mutations complete through their signed
                // session entity. Only spend a separate Matrix event when the
                // local operation is genuinely long-running.
                const timer = setTimeout(sendAcknowledgement, CANONICAL_COMMAND_ACK_DELAY_MS)
                timer.unref?.()
                void commandCompletion.then(
                    () => clearTimeout(timer),
                    () => clearTimeout(timer),
                )
            } else {
                sendAcknowledgement()
            }
        }
    }

    private async handleCapabilityRenewalRequest(
        runtime: RoomRuntime,
        opened: Awaited<ReturnType<GatewaySecureContentLayer['openIncoming']>>,
        request: CapabilityRenewalRequest,
    ): Promise<void> {
        const now = this.now()
        if (
            request.gateway_id !== this.config.gatewayId
            || request.device_id !== opened.authenticatedDeviceId
            || request.certificate_id !== opened.trustedDevice.sequenceEpoch
            || !opened.trustedDevice.allowedOperations?.includes('device.invite')
        ) {
            throw new Error('Capability renewal request is not bound to the active certificate')
        }
        if (
            request.expires_at <= now
            || request.issued_at > now + 30_000
            || request.expires_at - request.issued_at > 2 * 60_000
        ) {
            throw new Error('Capability renewal request is outside its validity window')
        }
        if (!this.dependencies.createDeviceInvitation) {
            throw new Error('This Gateway host does not support capability renewal')
        }
        const invitation = await this.dependencies.createDeviceInvitation({
            requestedByDeviceId: opened.authenticatedDeviceId,
            commandId: `capability-renewal.${request.request_id}`,
        })
        await this.secureContent.sendCapabilityRenewalOffer(
            runtime.config,
            opened.authenticatedDeviceId,
            {
                requestId: request.request_id,
                certificateId: request.certificate_id,
                pairingLink: invitation.pairingLink,
                expiresAt: invitation.expiresAt,
            },
            this.client,
        )
    }

    private scheduleExecution(
        event: MatrixIncomingEvent,
        runtime: RoomRuntime,
        command: CodeverCommand,
        revision: number,
        beforeExecute?: Promise<unknown>,
    ): Promise<void> {
        // Authorization and acknowledgement remain strictly ordered on
        // eventChain, while the session runtime owns execution ordering. A
        // prompt's background task waits for its collaboration event's first
        // fan-out attempt so remote devices see the user intent before Agent
        // status. The event chain itself stays free for cancel and decisions.
        const task = (async () => {
            this.log(
                `[matrix-gateway] command ${command.commandId} ${command.payload.operation} execution started`,
            )
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

            if (needsStandaloneRevisionEvent(
                command.payload.operation,
                outcome,
                executionResult.nativeRevisionPublished === true,
            )) {
                this.scheduleGatewayRevision(runtime, command.commandId)
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
                await this.replayStore.recordCommandResult(command, terminal)
            } catch (persistenceError) {
                this.log(
                    `[matrix-gateway] ${outcome} result persistence failed: `
                    + formatError(persistenceError),
                )
            }
            if (!(outcome === 'succeeded' && executionResult.canonicalCompletionPublished)) {
                try {
                    await this.deliverCommandResult(runtime, command, terminal)
                } catch (deliveryError) {
                    this.log(
                        `[matrix-gateway] ${outcome} result delivery failed: ${formatError(deliveryError)}`,
                    )
                }
            }
            this.log(
                `[matrix-gateway] command ${command.commandId} ${command.payload.operation} `
                + `execution ${outcome}`,
            )
        })()
            .finally(() => {
                this.executionTasks.delete(task)
                if (this.activeCommandExecutions.get(command.commandId) === task) {
                    this.activeCommandExecutions.delete(command.commandId)
                }
            })
        this.executionTasks.add(task)
        this.activeCommandExecutions.set(command.commandId, task)
        return task
    }

    private async terminalizeOrphanedCommand(
        runtime: RoomRuntime,
        command: CodeverCommand,
        revision: number,
    ): Promise<void> {
        const recoveredSession = command.payload.operation === 'session.create'
            ? [...runtime.appSessions.values(), ...runtime.archivedSessions.values()]
                .map(value => 'record' in value ? value.record : value)
                .find(record => record.sourceCommandId === command.commandId)
            : undefined
        const terminal: DurableCommandResult = recoveredSession
            ? {
                revision,
                outcome: 'succeeded',
                sessionId: recoveredSession.id,
            }
            : {
                revision,
                outcome: 'failed',
                sessionId: commandSessionId(command),
                error: 'The Gateway accepted this command before its previous process stopped, '
                    + 'but no durable completion was recorded. It was not executed again. '
                    + 'Review the synchronized conversation state, then retry the action if needed.',
            }
        await this.replayStore.recordCommandResult(command, terminal)
        this.scheduleGatewayRevision(runtime, command.commandId)
        await this.deliverCommandResult(runtime, command, terminal)
        this.log(
            `[matrix-gateway] command ${command.commandId} recovered as an orphaned acceptance`,
        )
    }

    private async deliverCommandResult(
        runtime: RoomRuntime,
        command: CodeverCommand,
        terminal: DurableCommandResult,
    ): Promise<void> {
        await this.secureContent.sendCommandResult(
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
                await this.sendSessionUpdate(runtime, appSession.record, command.commandId)
                    .catch(error => this.log(
                        `[matrix-gateway] session update delivery failed for ${appSession.record.id}: `
                        + formatError(error),
                    ))
                    this.scheduleNativeSessionState(
                        runtime,
                        appSession.record.id,
                        command.commandId,
                    )
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
                if (!appSession.port.resolveDecision(
                    command.payload.requestId,
                    value,
                    command.payload.totp,
                )) {
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
                await this.sendSessionUpdate(runtime, appSession.record, command.commandId)
                    .catch(error => this.log(
                        `[matrix-gateway] session update delivery failed for ${appSession.record.id}: `
                        + formatError(error),
                    ))
                this.scheduleNativeSessionState(
                    runtime,
                    appSession.record.id,
                    command.commandId,
                )
                return { sessionId: appSession.record.id }
            }
            case 'session.create': {
                const record = await this.createAppSessionRecord(
                    runtime,
                    command.payload,
                    command.commandId,
                )
                const appSession = this.createAppSessionRuntime(runtime, record)
                runtime.appSessions.set(record.id, appSession)
                try {
                    await this.persistRuntime(runtime)
                } catch (error) {
                    runtime.appSessions.delete(record.id)
                    await this.persistRuntime(runtime).catch(rollbackError => {
                        this.log(
                            `[matrix-gateway] rolled-back app session ${record.id} persistence failed: `
                            + formatError(rollbackError),
                        )
                    })
                    appSession.port.close()
                    await appSession.session.destroy('delete').catch(destroyError => {
                        this.log(
                            `[matrix-gateway] rolled-back app session ${record.id} destroy failed: `
                            + formatError(destroyError),
                        )
                    })
                    throw error
                }
                if (command.payload.initialPrompt) {
                    await appSession.session.dispatch({
                        kind: 'user_message',
                        text: command.payload.initialPrompt,
                        source: 'channel',
                        user: { id: command.deviceId, username: command.deviceId },
                    })
                    this.updateAppSessionRecord(appSession)
                    await this.persistRuntime(runtime)
                }
                // An empty session has no Matrix thread yet. Publish its
                // authoritative entity now and create the immutable thread
                // root lazily when the first prompt is sent.
                const canonicalCompletionPublished = await this.publishCanonicalSessionState(
                    runtime,
                    record.id,
                    command.commandId,
                )
                return {
                    sessionId: record.id,
                    canonicalCompletionPublished,
                }
            }
            case 'project.settings': {
                const workspace = await resolveWorkspaceSettings(
                    runtime.workspace,
                    command.payload,
                    runtime.capabilityProvider,
                )
                runtime.workspace = workspace
                await this.persistRuntime(runtime)
                this.scheduleRoomSnapshot(runtime)
                return { sessionId: null }
            }
            case 'provider.sessions.list': {
                const providerName = command.payload.provider
                const provider = createProviderInstance(providerName)
                if (!provider?.listSessions) {
                    throw new Error(`Provider ${providerName} does not support session history`)
                }
                try {
                    const sessions = (await provider.listSessions(runtime.workspace.cwd)).slice(0, 256)
                        .map(entry => {
                            const managed = [...runtime.appSessions.values()].find(candidate =>
                                candidate.record.provider === providerName
                                && candidate.record.providerSessionId === entry.sessionId
                            )
                            return {
                                sessionId: entry.sessionId,
                                title: entry.title.trim() || 'Untitled provider session',
                                updatedAt: Math.max(0, Math.trunc(entry.updated)),
                                ...(entry.cwd ? { cwd: entry.cwd } : {}),
                                ...(managed ? { managedSessionId: managed.record.id } : {}),
                            }
                        })
                    return {
                        sessionId: null,
                        result: { type: 'provider.sessions.listed', provider: providerName, sessions },
                    }
                } finally {
                    await provider.destroy?.().catch(error => {
                        this.log(`[matrix-gateway] provider session-list cleanup failed: ${formatError(error)}`)
                    })
                }
            }
            case 'provider.session.inspect': {
                const providerName = command.payload.provider
                const providerSessionId = command.payload.providerSessionId
                const provider = createProviderInstance(providerName)
                if (!provider?.getSessionHistory) {
                    throw new Error(`Provider ${providerName} cannot inspect session history`)
                }
                try {
                    const history = await provider.getSessionHistory(
                        providerSessionId,
                        runtime.workspace.cwd,
                    )
                    return {
                        sessionId: null,
                        result: {
                            type: 'provider.session.inspected',
                            provider: providerName,
                            providerSessionId,
                            title: history.title.trim() || 'Provider session',
                            messages: limitLegacyProviderHistoryMessages(history.messages),
                        },
                    }
                } finally {
                    await provider.destroy?.()
                }
            }
            case 'session.archive': {
                const { sessionId } = command.payload
                return this.serializeSessionMutation(
                    runtime,
                    sessionId,
                    () => this.archiveAppSession(runtime, sessionId, command.commandId),
                )
            }
            case 'session.restore': {
                throw new Error(
                    'Archived sessions cannot be restored; continue them from Provider History',
                )
            }
            case 'session.delete': {
                const { sessionId } = command.payload
                // Legacy delete is a compatibility alias for Codever archive.
                // The provider-owned session is deliberately never deleted.
                return this.serializeSessionMutation(
                    runtime,
                    sessionId,
                    () => this.archiveAppSession(runtime, sessionId, command.commandId),
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
        sourceCommandId: string,
    ): Promise<CommandExecutionResult> {
        if (runtime.archivedSessions.has(sessionId)) {
            return { sessionId }
        }
        const appSession = this.requireAppSession(runtime, sessionId)
        this.updateAppSessionRecord(appSession)
        try {
            await this.destroyAppSessionRuntime(appSession, 'archive')
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
        const canonicalCompletionPublished = await this.publishCanonicalSessionState(
            runtime,
            appSession.record.id,
            sourceCommandId,
        )
        return { sessionId: appSession.record.id, canonicalCompletionPublished }
    }

    private async restoreAppSession(
        runtime: RoomRuntime,
        sessionId: string,
        sourceCommandId: string,
    ): Promise<CommandExecutionResult> {
        if (runtime.appSessions.has(sessionId)) {
            return { sessionId }
        }
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
            await this.destroyAppSessionRuntime(appSession, 'replace').catch(destroyError => {
                this.log(
                    `[matrix-gateway] rolled-back restored session ${record.id} destroy failed: `
                    + formatError(destroyError),
                )
            })
            throw error
        }
        const canonicalCompletionPublished = await this.publishCanonicalSessionState(
            runtime,
            record.id,
            sourceCommandId,
        )
        return { sessionId: record.id, canonicalCompletionPublished }
    }

    private async deleteAppSession(
        runtime: RoomRuntime,
        sessionId: string,
        sourceCommandId: string,
    ): Promise<CommandExecutionResult> {
        const active = runtime.appSessions.get(sessionId)
        const archived = runtime.archivedSessions.get(sessionId)
        // Deletion is a desired-state operation. A concurrent device may have
        // removed the same immutable session id after this client captured its
        // Gateway revision; replaying that intent must converge as success.
        if (!active && !archived) return { sessionId, nativeRevisionPublished: false }
        const record = active?.record ?? archived!
        if (active) {
            this.updateAppSessionRecord(active)
            try {
                await this.destroyAppSessionRuntime(active, 'delete')
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
        runtime.deletedSessionIds.add(record.id)
        try {
            await this.persistRuntime(runtime)
        } catch (error) {
            runtime.deletedSessionIds.delete(record.id)
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
        const canonicalCompletionPublished = await this.publishCanonicalSessionState(
            runtime,
            record.id,
            sourceCommandId,
        )
        return {
            sessionId: record.id,
            nativeRevisionPublished: canonicalCompletionPublished,
            canonicalCompletionPublished,
        }
    }

    private async publishCanonicalSessionState(
        runtime: RoomRuntime,
        sessionId: string,
        sourceCommandId: string,
    ): Promise<boolean> {
        try {
            this.log(
                `[matrix-gateway] canonical session state ${sessionId} for command `
                + `${sourceCommandId} publishing`,
            )
            await this.serializeRoomState(runtime, () =>
                this.publishNativeSessionStateEntity(runtime, sessionId, sourceCommandId)
            )
            this.log(
                `[matrix-gateway] canonical session state ${sessionId} for command `
                + `${sourceCommandId} published`,
            )
            return true
        } catch (error) {
            // The runtime mutation is already durable. Fall back to the
            // per-device command result while the state outbox retries the
            // authoritative entity in the background.
            this.log(
                `[matrix-gateway] canonical session state ${sessionId} delivery failed: `
                + formatError(error),
            )
            return false
        }
    }

    private async createAppSessionRecord(
        runtime: RoomRuntime,
        settings: WorkspaceSettingsInput,
        sourceCommandId: string,
    ): Promise<AppSessionRecord> {
        const workspace = await resolveWorkspaceSettings(
            runtime.workspace,
            settings,
            runtime.capabilityProvider,
        )
        const createdAt = this.now()
        return {
            id: randomUUID(),
            sourceCommandId,
            title: settings.title?.trim() || 'New session',
            createdAt,
            updatedAt: createdAt,
            matrixThreadRootEventId: null,
            projectId: workspace.projectId,
            projectName: workspace.projectName,
            cwd: workspace.cwd,
            provider: workspace.provider,
            model: workspace.model,
            reasoningEffort: workspace.reasoningEffort,
            permissionMode: workspace.permissionMode,
            providerSessionId: settings.providerSessionId ?? null,
            archivedAt: null,
            extensions: this.sessionExtensionRegistry.normalizeBindings(settings.extensions),
        }
    }

    private updateAppSessionRecord(appSession: AppSessionRuntime): void {
        appSession.record.providerSessionId =
            appSession.session.sessionRecord.conversationId
        appSession.record.updatedAt = this.now()
    }

    private async ensureSessionRoots(): Promise<void> {
        for (const runtime of this.rooms.values()) {
            if (await this.secureContent.activeDeviceCountForRoom(runtime.config) === 0) continue
            for (const appSession of runtime.appSessions.values()) {
                await this.ensureSessionRoot(runtime, appSession.record, appSession.port)
            }
            for (const record of runtime.archivedSessions.values()) {
                await this.ensureSessionRoot(runtime, record)
            }
        }
    }

    private async ensureSessionRoot(
        runtime: RoomRuntime,
        record: AppSessionRecord,
        port?: MatrixPort,
        sourceCommandId?: string,
    ): Promise<string> {
        if (record.matrixThreadRootEventId) {
            // The mapping is durable, but matrix-js-sdk's room/thread index is
            // process-local. Rehydrate it after every Gateway restart instead
            // of assuming the old root was included in the limited /sync.
            await this.client.prepareRoomThread?.(
                runtime.config.roomId,
                record.matrixThreadRootEventId,
            )
            port?.setThreadRootEventId(record.matrixThreadRootEventId)
            return record.matrixThreadRootEventId
        }
        const status = record.archivedAt !== null
            ? 'idle'
            : gatewaySessionStatus(
                runtime.appSessions.get(record.id)?.session.state ?? 'idle',
                runtime.appSessions.get(record.id)?.activity.phase,
            )
        const revision = await this.nativeRevision(runtime)
        const send = this.secureContent.sendNativeContent(runtime.config, {
            version: 2,
            kind: 'session_root',
            ...revision,
            session_id: record.id,
            title: record.title,
            project: { id: record.projectId, name: record.projectName, cwd: record.cwd },
            created_at: record.createdAt,
            updated_at: record.updatedAt,
            archived: record.archivedAt !== null,
            status,
            provider: record.provider,
            ...(record.model ? { model: record.model } : {}),
            ...(record.reasoningEffort
                ? { reasoning_effort: record.reasoningEffort }
                : {}),
            permission_mode: record.permissionMode,
            extensions: this.sessionExtensionRegistry.summaries(record.extensions),
            ...(sourceCommandId ? { source_command_id: sourceCommandId } : {}),
        }, `codever.session.root.${record.id}`, this.client)
        let eventId: string
        try {
            eventId = (await send).eventId
        } catch (error) {
            if (!(error instanceof ChannelDeliveryQueuedError) || !error.confirmation) throw error
            const confirmation = await error.confirmation
            if (confirmation.messageId === undefined) {
                throw new Error(`Matrix did not confirm session root ${record.id}`)
            }
            eventId = String(confirmation.messageId)
        }
        // Application timeline envelopes intentionally bypass Matrix E2EE and
        // the SDK send queue. Wait for the immutable root's remote echo before
        // publishing replies, otherwise matrix-js-sdk sees thread receipts and
        // children before it can construct the thread timeline.
        await this.client.prepareRoomThread?.(runtime.config.roomId, eventId)
        record.matrixThreadRootEventId = eventId
        port?.setThreadRootEventId(eventId)
        await this.persistRuntime(runtime).catch(error => {
            // The root transaction is idempotent and the pre-root record is
            // already durable. Keep serving the live session; startup will
            // recover the same Matrix event ID and retry this metadata write.
            this.log(
                `[matrix-gateway] session root mapping persistence failed for ${record.id}: `
                + formatError(error),
            )
        })
        return eventId
    }

    private async sendSessionUpdate(
        runtime: RoomRuntime,
        record: AppSessionRecord,
        sourceCommandId?: string,
    ): Promise<void> {
        const threadRootEventId = await this.ensureSessionRoot(
            runtime,
            record,
            runtime.appSessions.get(record.id)?.port,
            sourceCommandId,
        )
        const revision = await this.nativeRevision(runtime)
        await this.secureContent.sendNativeContent(runtime.config, {
            version: 2,
            kind: 'session_update',
            ...revision,
            session_id: record.id,
            updated_at: record.updatedAt,
            title: record.title,
            project: { id: record.projectId, name: record.projectName, cwd: record.cwd },
            provider: record.provider,
            model: record.model,
            reasoning_effort: record.reasoningEffort,
            permission_mode: record.permissionMode,
            extensions: this.sessionExtensionRegistry.summaries(record.extensions),
            ...(sourceCommandId ? { source_command_id: sourceCommandId } : {}),
        }, `codever.session.update.${record.id}.${sourceCommandId ?? record.updatedAt}`,
        this.client, threadRootEventId)
    }

    private async nativeRevision(runtime: RoomRuntime): Promise<{
        revision: number
        revision_epoch: string
        revision_epoch_generation: number
    }> {
        return {
            revision: await this.replayStore.getConversationRevision(
                this.config.gatewayId,
                runtime.config.conversationId,
                runtime.revisionEpoch,
            ),
            revision_epoch: runtime.revisionEpoch,
            revision_epoch_generation: runtime.revisionEpochGeneration,
        }
    }

    private scheduleGatewayRevision(runtime: RoomRuntime, sourceCommandId: string): void {
        const task = (async () => {
            const revision = await this.nativeRevision(runtime)
            await this.secureContent.sendNativeContent(runtime.config, {
                version: 2,
                kind: 'gateway_revision',
                ...revision,
                gateway_id: this.config.gatewayId,
                conversation_id: runtime.config.conversationId,
                updated_at: this.now(),
                source_command_id: sourceCommandId,
            }, `codever.gateway.revision.${runtime.revisionEpoch}.${revision.revision}`, this.client)
            // Timeline is the realtime/audit stream. Also advance durable
            // Gateway metadata so reconnect does not require history replay.
            await this.serializeRoomState(runtime, async () => {
                const stateVersion = await this.advanceStateVersion(runtime)
                const snapshot = await this.gatewayStateSnapshot(runtime)
                await this.publishGatewayState(
                    runtime,
                    snapshot,
                    stateVersion,
                    revision,
                    this.now(),
                )
            })
        })()
            .catch(error => this.log(
                `[matrix-gateway] revision ${sourceCommandId} delivery failed: ${formatError(error)}`,
            ))
            .finally(() => this.executionTasks.delete(task))
        this.executionTasks.add(task)
    }

    private scheduleNativeSessionState(
        runtime: RoomRuntime,
        sessionId: string,
        sourceCommandId?: string,
    ): void {
        if (this.state === 'stopping' || this.state === 'stopped') return
        const key = `${runtime.config.roomId}\0${sessionId}`
        let dirty = this.dirtySessionStates.get(runtime.config.roomId)
        if (!dirty) {
            dirty = new Set()
            this.dirtySessionStates.set(runtime.config.roomId, dirty)
        }
        dirty.add(sessionId)
        if (sourceCommandId) {
            let sources = this.sessionStateCommandSources.get(runtime.config.roomId)
            if (!sources) {
                sources = new Map()
                this.sessionStateCommandSources.set(runtime.config.roomId, sources)
            }
            sources.set(sessionId, sourceCommandId)
        }
        if (this.sessionStatePublishTasks.has(key)) return
        const task = (async () => {
            // Coalesce bursts such as starting -> working into the latest
            // entity value while preserving a later change that arrives during
            // an in-flight Matrix PUT.
            await Promise.resolve()
            while (this.dirtySessionStates.get(runtime.config.roomId)?.delete(sessionId)) {
                const commandSource = this.sessionStateCommandSources
                    .get(runtime.config.roomId)?.get(sessionId)
                this.sessionStateCommandSources.get(runtime.config.roomId)?.delete(sessionId)
                await this.serializeRoomState(runtime, () =>
                    this.publishNativeSessionStateEntity(runtime, sessionId, commandSource)
                )
            }
        })()
            .catch(error => this.log(
                `[matrix-gateway] session Room State ${sessionId} delivery failed: ${formatError(error)}`,
            ))
            .finally(() => {
                this.sessionStatePublishTasks.delete(key)
                this.executionTasks.delete(task)
                if (this.dirtySessionStates.get(runtime.config.roomId)?.has(sessionId)) {
                    this.scheduleNativeSessionState(runtime, sessionId)
                }
            })
        this.sessionStatePublishTasks.set(key, task)
        this.executionTasks.add(task)
    }

    private async publishNativeSessionStateEntity(
        runtime: RoomRuntime,
        sessionId: string,
        sourceCommandId?: string,
    ): Promise<void> {
        const stateVersion = await this.advanceStateVersion(runtime)
        const revision = await this.nativeRevision(runtime)
        const updatedAt = this.now()
        const snapshot = await this.gatewayStateSnapshot(runtime)
        const archivedRecord = runtime.archivedSessions.get(sessionId)
        const archivedSession = archivedRecord
            ? {
                ...gatewaySessionSummary(
                    archivedRecord,
                    'idle',
                    true,
                    'idle',
                    this.sessionExtensionRegistry.summaries(archivedRecord.extensions),
                ),
                ...(archivedRecord.matrixThreadRootEventId
                    ? { threadRootEventId: archivedRecord.matrixThreadRootEventId }
                    : {}),
            }
            : undefined
        const session = snapshot.sessions.find(candidate => candidate.id === sessionId)
            ?? archivedSession
        const content = session
            ? nativeSessionState(
                this.config.gatewayId,
                runtime,
                session,
                stateVersion,
                revision,
                updatedAt,
                sourceCommandId,
            )
            : {
                version: 2 as const,
                kind: 'session_state' as const,
                gateway_id: this.config.gatewayId,
                conversation_id: runtime.config.conversationId,
                ...revision,
                state_version: stateVersion,
                session_id: sessionId,
                state: 'deleted' as const,
                updated_at: updatedAt,
                ...(sourceCommandId ? { source_command_id: sourceCommandId } : {}),
            }
        try {
            await this.secureContent.setNativeRoomState(
                runtime.config,
                CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE,
                sessionId,
                content,
                this.client,
            )
        } finally {
            // The entity event is the realtime and command-completion path.
            // Rebuild the immutable cold-start directory once for the whole
            // burst instead of multiplying every mutation into three state
            // writes.
            this.scheduleRoomSnapshot(runtime)
        }
    }

    private scheduleRoomSnapshot(runtime: RoomRuntime): void {
        if (this.state === 'stopping' || this.state === 'stopped') return
        const existing = this.roomSnapshotTimers.get(runtime.config.roomId)
        if (existing) clearTimeout(existing)
        const timer = setTimeout(() => {
            this.roomSnapshotTimers.delete(runtime.config.roomId)
            const task = this.serializeRoomState(runtime, async () => {
                const stateVersion = await this.advanceStateVersion(runtime)
                const snapshot = await this.gatewayStateSnapshot(runtime)
                await this.publishGatewayState(
                    runtime,
                    snapshot,
                    stateVersion,
                    await this.nativeRevision(runtime),
                    this.now(),
                )
            })
                .catch(error => {
                    this.log(
                        `[matrix-gateway] coalesced Room State snapshot failed: ${formatError(error)}`,
                    )
                })
                .finally(() => this.executionTasks.delete(task))
            this.executionTasks.add(task)
        }, ROOM_SNAPSHOT_DEBOUNCE_MS)
        timer.unref?.()
        this.roomSnapshotTimers.set(runtime.config.roomId, timer)
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
                deletedSessionIds: new Set(restored.deletedSessionIds),
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
            transport: this.secureContent.transportForRoom(runtime.config, this.client),
            roomId: runtime.config.roomId,
            gatewayId: this.config.gatewayId,
            sessionId: record.id,
            ...(record.matrixThreadRootEventId
                ? { threadRootEventId: record.matrixThreadRootEventId }
                : {}),
            onLog: this.dependencies.onLog,
            onStatusChange: status => {
                activity.phase = status.activity ?? activityForSessionStatus(status)
                const current = runtime.appSessions.get(record.id)
                if (current) this.scheduleNativeSessionState(runtime, current.record.id)
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
            id: appSession.id,
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
        const extensions = this.sessionExtensionRegistry.createInstances(
            appSession.extensions,
            {
                sessionId: appSession.id,
                cwd: appSession.cwd,
                providerName: appSession.provider,
                onLog: message => this.log(`[session-extension] ${message}`),
            },
        )
        return createTopicSession({ sessionRecord, provider, channelPort: port, extensions })
    }

    private async destroyAppSessionRuntime(
        appSession: AppSessionRuntime,
        reason: 'archive' | 'delete' | 'replace' | 'shutdown',
    ): Promise<void> {
        try {
            await appSession.session.destroy(reason)
        } finally {
            appSession.port.close()
        }
    }

    private async cleanup(): Promise<void> {
        this.stopGatewayHeartbeat()
        this.unsubscribe?.()
        this.unsubscribe = null
        this.startupEvents = []
        this.secureContent.stopRetries()
        const runtimes = [...this.rooms.values()]
        this.rooms.clear()
        for (const runtime of runtimes) {
            for (const appSession of runtime.appSessions.values()) {
                appSession.port.close()
                await appSession.session.destroy('shutdown').catch(error => {
                    this.log(
                        `[matrix-gateway] app session ${appSession.record.id} destroy failed: `
                        + formatError(error),
                    )
                })
            }
        }
        await Promise.allSettled([...this.executionTasks])
        await this.secureContent.compactStateOutbox().catch(error => this.log(
            `[matrix-gateway] Room State outbox compaction failed: ${formatError(error)}`,
        ))
        this.executionTasks.clear()
        this.activeCommandExecutions.clear()
        this.sessionMutationChains.clear()
        this.roomStateChains.clear()
        this.dirtySessionStates.clear()
        this.sessionStateCommandSources.clear()
        this.sessionStatePublishTasks.clear()
        for (const timer of this.roomSnapshotTimers.values()) clearTimeout(timer)
        this.roomSnapshotTimers.clear()
        this.lastGatewayStatePublishedAt.clear()
        await this.client.stop().catch(error => this.log(`[matrix-gateway] client stop failed: ${formatError(error)}`))
    }

    private startGatewayHeartbeat(): void {
        this.stopGatewayHeartbeat()
        const intervalMs = this.config.gatewayHeartbeatIntervalMs ?? 30_000
        this.gatewayHeartbeatTimer = setInterval(() => {
            if (this.state !== 'running') return
            const task = Promise.all([...this.rooms.values()].map(runtime =>
                this.serializeRoomState(runtime, async () => {
                    if (await this.secureContent.activeDeviceCountForRoom(runtime.config) === 0) return
                    const lastPublishedAt = this.lastGatewayStatePublishedAt
                        .get(runtime.config.roomId) ?? 0
                    if (this.now() - lastPublishedAt < intervalMs) return
                    const snapshot = await this.gatewayStateSnapshot(runtime)
                    await this.publishGatewayState(
                        runtime,
                        snapshot,
                        runtime.stateVersion,
                        await this.nativeRevision(runtime),
                        this.now(),
                    )
                }),
            )).then(() => undefined)
                .catch(error => this.log(
                    `[matrix-gateway] Gateway heartbeat failed: ${formatError(error)}`,
                ))
                .finally(() => this.executionTasks.delete(task))
            this.executionTasks.add(task)
        }, intervalMs)
        this.gatewayHeartbeatTimer.unref?.()
    }

    private stopGatewayHeartbeat(): void {
        if (this.gatewayHeartbeatTimer === null) return
        clearInterval(this.gatewayHeartbeatTimer)
        this.gatewayHeartbeatTimer = null
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
        deletedSessionIds: [...runtime.deletedSessionIds].sort(),
        workspace: structuredClone(runtime.workspace),
    }
}

function commandSessionId(command: CodeverCommand): string | null {
    switch (command.payload.operation) {
        case 'session.create':
        case 'device.invite':
        case 'project.settings':
        case 'provider.sessions.list':
        case 'provider.session.inspect':
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
    extensions: SessionExtensionSummary[] = [],
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
        extensions,
        availableCommands: [],
    }
}

function nativeSessionState(
    gatewayId: string,
    runtime: RoomRuntime,
    session: GatewayStateSnapshot['sessions'][number],
    stateVersion: number,
    revision: NativeRevision,
    updatedAt: number,
    sourceCommandId?: string,
) {
    return {
        version: 2 as const,
        kind: 'session_state' as const,
        gateway_id: gatewayId,
        conversation_id: runtime.config.conversationId,
        ...revision,
        state_version: stateVersion,
        session_id: session.id,
        state: session.archived === true ? 'archived' as const : 'active' as const,
        session: {
            session_id: session.id,
            ...(session.threadRootEventId
                ? { thread_root_event_id: session.threadRootEventId }
                : {}),
            title: session.title,
            updated_at: session.updatedAt,
            archived: session.archived === true,
            status: session.status,
            ...(session.activityPhase
                ? { activity_phase: session.activityPhase }
                : {}),
            project: {
                id: session.projectId,
                name: session.projectName,
                cwd: session.cwd,
            },
            provider: session.provider,
            ...(session.model ? { model: session.model } : {}),
            ...(session.reasoningEffort
                ? { reasoning_effort: session.reasoningEffort }
                : {}),
            extensions: session.extensions,
        },
        updated_at: updatedAt,
        ...(sourceCommandId ? { source_command_id: sourceCommandId } : {}),
    }
}

const MATRIX_DIRECTORY_PAGE_MAX_PLAINTEXT_BYTES = 20 * 1024
const MATRIX_DIRECTORY_PAGE_MAX_SESSIONS = 32

type NativeDirectoryPageContext = {
    gatewayId: string
    conversationId: string
    revision: NativeRevision
    stateVersion: number
    generation: number
    slot: number
    digest: string
    stateKeyPrefix: string
    updatedAt: number
}

function packNativeSessionDirectoryPages(
    sessions: readonly MatrixRoomSession[],
    context: NativeDirectoryPageContext,
): MatrixRoomSession[][] {
    const pages: MatrixRoomSession[][] = []
    for (const session of sessions) {
        const current = pages.at(-1) ?? []
        const candidate = [...current, session]
        if (
            candidate.length <= MATRIX_DIRECTORY_PAGE_MAX_SESSIONS
            && nativeDirectoryPageBytes(candidate, context) <=
                MATRIX_DIRECTORY_PAGE_MAX_PLAINTEXT_BYTES
        ) {
            if (current.length === 0) pages.push(candidate)
            else pages[pages.length - 1] = candidate
            continue
        }
        if (
            nativeDirectoryPageBytes([session], context) >
            MATRIX_DIRECTORY_PAGE_MAX_PLAINTEXT_BYTES
        ) {
            throw new Error(
                `Session ${session.session_id} is too large for one bounded Matrix directory page`,
            )
        }
        pages.push([session])
    }
    return pages
}

function nativeDirectoryPageBytes(
    sessions: readonly MatrixRoomSession[],
    context: NativeDirectoryPageContext,
): number {
    return Buffer.byteLength(canonicalJson({
        version: 2,
        kind: 'session_directory',
        gateway_id: context.gatewayId,
        conversation_id: context.conversationId,
        ...context.revision,
        state_version: context.stateVersion,
        directory_generation: context.generation,
        directory_slot: context.slot,
        directory_digest: context.digest,
        state_key_prefix: context.stateKeyPrefix,
        // Use the schema maxima while packing so digit growth cannot push a
        // page over the encrypted event limit later.
        page_index: 99_999,
        page_count: 100_000,
        sessions,
        updated_at: context.updatedAt,
    }), 'utf8')
}

function nativeSessionDirectoryPage(
    gatewayId: string,
    runtime: RoomRuntime,
    sessions: readonly MatrixRoomSession[],
    descriptor: MatrixSessionDirectoryDescriptor,
    pageIndex: number,
    stateVersion: number,
    revision: NativeRevision,
    updatedAt: number,
) {
    return {
        version: 2 as const,
        kind: 'session_directory' as const,
        gateway_id: gatewayId,
        conversation_id: runtime.config.conversationId,
        ...revision,
        state_version: stateVersion,
        directory_generation: descriptor.generation,
        directory_slot: descriptor.slot,
        directory_digest: descriptor.digest,
        state_key_prefix: descriptor.state_key_prefix,
        page_index: pageIndex,
        page_count: descriptor.page_count,
        sessions: [...sessions],
        updated_at: updatedAt,
    }
}

function matrixDirectoryStateKeyPrefix(gatewayId: string): string {
    return `codever.${createHash('sha256').update(gatewayId).digest('hex').slice(0, 24)}`
}

function matrixDirectoryStateKey(
    descriptor: MatrixSessionDirectoryDescriptor,
    pageIndex: number,
): string {
    return `${descriptor.state_key_prefix}.${descriptor.slot}.${pageIndex}`
}

function limitLegacyProviderHistoryMessages(
    input: readonly import('@/providers/provider').ProviderHistoryMessage[],
): JsonValue[] {
    const result: JsonValue[] = []
    let bytes = 0
    for (const [index, message] of input.slice(-256).entries()) {
        const normalized = {
            id: message.id.slice(0, 256) || `message-${index + 1}`,
            role: message.role,
            text: message.text.slice(0, 16 * 1024),
        }
        const nextBytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8')
        if (bytes + nextBytes > 90 * 1024) break
        result.push(normalized)
        bytes += nextBytes
    }
    return result
}

function sameSessionEntity(
    left: MatrixSessionState,
    right: MatrixSessionState | undefined,
): boolean {
    if (!right) return false
    const normalized = (value: typeof left | typeof right) => ({
        gateway_id: value.gateway_id,
        conversation_id: value.conversation_id,
        revision_epoch: value.revision_epoch,
        revision_epoch_generation: value.revision_epoch_generation,
        session_id: value.session_id,
        state: value.state,
        ...(value.session ? { session: value.session } : {}),
    })
    return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right))
}

function nativeRoomStateCapabilities(
    capabilities: GatewayStateSnapshot['capabilities'],
): MatrixGatewayCapabilities {
    return {
        models: capabilities.models.map(model => ({
            id: model.id,
            name: model.name,
            ...(model.defaultReasoningLevel
                ? { default_reasoning_level: model.defaultReasoningLevel }
                : {}),
            ...(model.supportedReasoningLevels
                ? {
                    supported_reasoning_levels: model.supportedReasoningLevels.map(level => ({
                        effort: level.effort,
                        ...(level.description ? { description: level.description } : {}),
                    })),
                }
                : {}),
        })),
        providers: capabilities.providers.map(provider => ({
            id: provider.id,
            name: provider.name,
            models: provider.models.map(model => ({
                id: model.id,
                name: model.name,
                ...(model.defaultReasoningLevel
                    ? { default_reasoning_level: model.defaultReasoningLevel }
                    : {}),
                ...(model.supportedReasoningLevels
                    ? { supported_reasoning_levels: model.supportedReasoningLevels }
                    : {}),
            })),
            can_list_sessions: provider.canListSessions,
            can_inspect_sessions: provider.canInspectSessions,
        })),
        permission_modes: capabilities.permissionModes.map(mode => ({
            id: mode.id,
            name: mode.name,
        })),
        can_create_session: capabilities.canCreateSession,
        can_select_session: capabilities.canSelectSession,
        can_archive_session: capabilities.canArchiveSession ?? false,
        can_delete_session: capabilities.canDeleteSession ?? false,
        session_extensions: capabilities.sessionExtensions.map(extension => ({
            id: extension.id,
            name: extension.name,
            description: extension.description,
            version: extension.version,
            settings: extension.settings.map(setting => setting.type === 'text'
                ? {
                    id: setting.id,
                    type: setting.type,
                    label: setting.label,
                    ...(setting.description ? { description: setting.description } : {}),
                    ...(setting.required ? { required: true } : {}),
                    ...(setting.placeholder ? { placeholder: setting.placeholder } : {}),
                    ...(setting.defaultValue === undefined
                        ? {}
                        : { default_value: setting.defaultValue }),
                }
                : {
                    id: setting.id,
                    type: setting.type,
                    label: setting.label,
                    ...(setting.description ? { description: setting.description } : {}),
                    ...(setting.defaultValue === undefined
                        ? {}
                        : { default_value: setting.defaultValue }),
                }),
        })),
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

function needsStandaloneRevisionEvent(
    operation: CodeverCommand['payload']['operation'],
    outcome: 'succeeded' | 'failed',
    nativeRevisionPublished: boolean,
): boolean {
    if (operation === 'prompt') return false
    if (outcome === 'failed') return true
    if (operation === 'session.delete') return !nativeRevisionPublished
    return operation === 'cancel'
        || operation === 'decision'
        || operation === 'device.invite'
}

function usesCanonicalSessionCompletion(
    operation: CodeverCommand['payload']['operation'],
): boolean {
    return operation === 'session.create'
        || operation === 'session.archive'
        || operation === 'session.restore'
        || operation === 'session.delete'
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
