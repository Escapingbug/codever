import { createHash } from 'node:crypto'
import type { CodeverCommand } from '@codever/protocol'
import type { AgentProvider } from '@/providers/provider'
import { createProviderInstance } from '@/providers/registry'
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
import { FileCommandReplayStore } from './fileReplayLedger'

interface RoomRuntime {
    config: MatrixGatewayRoomConfig
    port: MatrixPort
    session: TopicSession
}

export interface MatrixGatewayDependencies {
    client?: MatrixGatewayClient
    providerFactory?: (room: MatrixGatewayRoomConfig) => AgentProvider | undefined
    sessionFactory?: (room: MatrixGatewayRoomConfig, port: MatrixPort) => TopicSession
    now?: () => number
    onLog?: (message: string) => void
    onRejected?: (event: MatrixIncomingEvent, error: unknown) => void
}

export type MatrixGatewayState = 'stopped' | 'starting' | 'running' | 'stopping'

export class MatrixGatewayRunner {
    private readonly client: MatrixGatewayClient
    private readonly authorizer: StrictMatrixCommandAuthorizer
    private readonly roomTargets = new MatrixRoomSessionRegistry()
    private readonly rooms = new Map<string, RoomRuntime>()
    private state: MatrixGatewayState = 'stopped'
    private unsubscribe: (() => void) | null = null
    private startupEvents: MatrixIncomingEvent[] = []
    private eventChain: Promise<void> = Promise.resolve()
    private startupFailure: Error | null = null
    private stopPromise: Promise<void> | null = null

    constructor(
        private readonly config: MatrixGatewayConfig,
        private readonly dependencies: MatrixGatewayDependencies = {},
    ) {
        validateMatrixGatewayConfig(config)
        this.client = dependencies.client
            ?? createMatrixJsSdkGatewayClient(config.connection, dependencies.onLog)
        const replayStore = new FileCommandReplayStore(config.replayLedgerPath)
        this.authorizer = new StrictMatrixCommandAuthorizer(
            config.gatewayId,
            config.trustedDevices,
            replayStore,
        )
    }

    getState(): MatrixGatewayState {
        return this.state
    }

    async start(): Promise<void> {
        if (this.state === 'running') return
        if (this.state !== 'stopped') throw new Error(`Cannot start Matrix gateway while ${this.state}`)
        this.state = 'starting'
        this.startupFailure = null
        try {
            await this.authorizer.initialize(this.now())
            await this.createRoomRuntimes()
            this.unsubscribe = this.client.onRoomEvent(event => this.receiveEvent(event))
            await this.client.initializeCrypto(this.config.crypto)
            await this.client.start()
            await this.client.waitUntilReady(this.config.connection.initialSyncTimeoutMs)
            await this.client.pinTrustedDevices?.(this.config.trustedDevices)
            for (const room of this.config.rooms) {
                await this.client.assertRoomEncrypted(room.roomId)
            }
            if (this.startupFailure) throw this.startupFailure
            this.state = 'running'
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
        if (!event.encrypted) throw new Error('Clear-text Matrix events cannot execute gateway commands')
        if (!event.senderDeviceId) throw new Error('Encrypted Matrix event has no cryptographic sender device key')
        const runtime = this.rooms.get(event.roomId)
        if (!runtime) return

        const extension = asRecord(event.content[CODEVER_MATRIX_EXTENSION])
        if (!extension || extension.version !== 1 || extension.kind !== 'signed_command') return
        const command = await this.authorizer.authorize(extension.signed_command, {
            roomId: event.roomId,
            conversationId: runtime.config.conversationId,
            matrixSender: event.sender,
            matrixDeviceKey: event.senderDeviceId,
        }, this.now())
        await this.execute(runtime, command)
    }

    private async execute(runtime: RoomRuntime, command: CodeverCommand): Promise<void> {
        switch (command.payload.operation) {
            case 'prompt':
                await runtime.session.dispatch({
                    kind: 'user_message',
                    text: command.payload.text,
                    source: 'channel',
                    user: { id: command.deviceId, username: command.deviceId },
                })
                return
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
                const settings = command.payload
                if (settings.provider) await dispatchCommand(runtime.session, command, 'provider', settings.provider)
                if (settings.cwd) await dispatchCommand(runtime.session, command, 'cwd', settings.cwd)
                if (settings.model) await dispatchCommand(runtime.session, command, 'model', settings.model)
                if (settings.permissionMode) {
                    await dispatchCommand(runtime.session, command, 'permissionMode', settings.permissionMode)
                }
                return
            }
        }
    }

    private async createRoomRuntimes(): Promise<void> {
        for (const room of this.config.rooms) {
            const port = new MatrixPort({
                transport: this.client,
                roomId: room.roomId,
                gatewayId: this.config.gatewayId,
                onLog: this.dependencies.onLog,
            })
            const session = this.dependencies.sessionFactory
                ? this.dependencies.sessionFactory(room, port)
                : this.createDefaultSession(room, port)
            const runtime = { config: room, port, session }
            this.rooms.set(room.roomId, runtime)
            this.roomTargets.bind(room.roomId, {
                dispatch: input => session.dispatch(input),
                resolveDecision: port.resolveDecision.bind(port),
            })
        }
    }

    private createDefaultSession(room: MatrixGatewayRoomConfig, port: MatrixPort): TopicSession {
        const provider = this.dependencies.providerFactory?.(room)
            ?? createProviderInstance(room.providerName)
        if (!provider) throw new Error(`Matrix room ${room.roomId} provider ${room.providerName} is unavailable`)
        const sessionRecord = createTopicSessionRecord({
            cwd: room.cwd,
            providerName: room.providerName,
            groupChatId: numericRoomCompatibilityId(room.roomId),
            model: room.model,
            verboseLevel: room.verboseLevel,
            timeoutSeconds: room.timeoutSeconds,
            providerSettings: room.providerSettings,
        })
        return createTopicSession({ sessionRecord, provider, channelPort: port })
    }

    private async cleanup(): Promise<void> {
        this.unsubscribe?.()
        this.unsubscribe = null
        this.startupEvents = []
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

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
