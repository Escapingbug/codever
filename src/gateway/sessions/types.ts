import type {
    CodeverSession,
    CreateSessionDto,
    JsonObject,
    SendMessageDto,
} from '@codever/protocol'
import type { AgentProvider } from '@/providers/provider'
import type { Project } from '@/gateway/projects'

export interface SessionMetadataRepository {
    list(projectId?: string): Promise<CodeverSession[]>
    get(sessionId: string): Promise<CodeverSession | undefined>
    save(session: CodeverSession): Promise<CodeverSession>
    delete(sessionId: string): Promise<boolean>
    close(): Promise<void>
}

export interface SessionProviderContext {
    session: CodeverSession
    project: Project
}

export type SessionProviderFactory = (
    providerName: string,
    context: SessionProviderContext,
) => AgentProvider | Promise<AgentProvider>

export type SessionProviderInitializer = (
    provider: AgentProvider,
    context: SessionProviderContext,
) => void | Promise<void>

export interface GatewaySessionServiceOptions {
    gatewayId: string
    projects: import('@/gateway/projects').ProjectRegistry
    eventStore: import('@/platform/storage').ConversationEventStore<import('@/gateway/runtime').GatewayConversationEvent>
    repository: SessionMetadataRepository
    providerFactory: SessionProviderFactory
    initializeProvider?: SessionProviderInitializer
    now?: () => number
    createId?: () => string
    onSubscriberError?: (error: unknown) => void
}

export interface CreateGatewaySessionInput extends CreateSessionDto {
    /** Relay-assigned stable ID used for idempotent remote creation. */
    sessionId?: string
    idempotencyKey?: string
}

export interface SendSessionMessageInput extends SendMessageDto {
    idempotencyKey?: string
}

export interface PatchGatewaySessionConfigInput {
    config: JsonObject
    model?: string | null
    mode?: string | null
    idempotencyKey?: string
}

export type GatewaySessionServiceErrorCode =
    | 'invalid_argument'
    | 'session_not_found'
    | 'session_closed'
    | 'provider_mismatch'

export class GatewaySessionServiceError extends Error {
    constructor(
        public readonly code: GatewaySessionServiceErrorCode,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options)
        this.name = 'GatewaySessionServiceError'
    }
}
