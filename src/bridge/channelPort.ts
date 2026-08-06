/**
 * ChannelPort — The interface between bridge logic and any messaging channel.
 * 
 * Implementations: TelegramPort, DiscordPort, CLIPort
 */

import type { SessionState } from '@/core/types'
import type { RichUserInput, SessionInput } from '@/runtime/semantic'
import type { SessionRecord } from './sessionRecord'
import type { DeliveryRecord } from '@/runtime/deliveryOutbox'
import type { RetryDeliveryCommandResult } from '@/runtime/semanticSessionRuntime'
import type { SessionExtensionLifecycleReason } from '@/runtime/sessionExtensions'

export interface ChannelAttachment {
    type: 'document' | 'photo'
    path: string
    filename?: string
}

export type ChannelToolCategory =
    | 'read'
    | 'edit'
    | 'write'
    | 'execute'
    | 'search'
    | 'agent'
    | 'unknown'

export interface ChannelToolPresentationItem {
    id: string
    name: string
    title: string
    detail?: string
    result?: string
    category: ChannelToolCategory
    phase: 'started' | 'updated' | 'completed' | 'failed'
    isError: boolean
    startedAt: number
    updatedAt: number
}

export interface ChannelToolGroupPresentation {
    kind: 'tool_group'
    version: 1
    groupId: string
    tools: ChannelToolPresentationItem[]
}

export type ChannelPresentation = ChannelToolGroupPresentation

export interface ChannelMessage {
    text: string
    format: 'markdown' | 'html' | 'plain'
    /** Channel-neutral structured UI hints. Ports may serialize or ignore them. */
    presentation?: ChannelPresentation
    replyMarkup?: unknown
    attachments?: ChannelAttachment[]
}

export interface DecisionOption {
    label: string
    value: string
}

export interface DecisionRequest {
    type: 'permission' | 'question'
    title: string
    details?: string
    options: DecisionOption[]
}

export interface DecisionResponse {
    value: string
}

export type AgentActivityPhase = 'starting' | 'working' | 'stopping' | 'idle' | 'failed'

export interface SessionStatus {
    state: SessionState
    /** Transient presentation phase. Lifecycle phases never belong in the conversation transcript. */
    activity?: AgentActivityPhase
    model?: string
    cwd: string
    provider: string
    /** If set, edit this existing message instead of sending a new one */
    editMessageId?: string | number
}

export interface ChannelSendResult {
    /** The ID of the sent message, if available from the channel */
    messageId?: string | number
}

/**
 * The channel accepted the message into a durable delivery queue, but no
 * remote recipient has confirmed it yet. Callers must not resend solely
 * because of this result: the channel owns the eventual, idempotent retry.
 */
export class ChannelDeliveryQueuedError extends Error {
    constructor(
        message: string,
        readonly deliveryKey?: string,
        readonly deliveryCause?: unknown,
        readonly confirmation?: Promise<ChannelSendResult>,
    ) {
        super(message)
        this.name = 'ChannelDeliveryQueuedError'
    }
}

export interface ChannelPort {
    /**
     * Whether tool-output file:// references should receive channel command
     * hints such as `/file_f1`. First-party clients use structured artifacts.
     */
    readonly fileReferenceHints?: boolean

    /** Send a message to the channel */
    send(message: ChannelMessage): Promise<ChannelSendResult>

    /** Edit an existing message (for progressive tool call display) */
    edit?(messageId: string | number, message: ChannelMessage): Promise<void>

    /** Request a user decision (permission, question) */
    requestDecision(request: DecisionRequest): Promise<DecisionResponse>

    /** Notify channel of session status change */
    notifyStatus(status: SessionStatus): void

    /** Send typing/uploading indicator */
    sendChatAction?(action: string): void
}

/**
 * TopicSession — The result of wiring session metadata to a ChannelPort via the semantic runtime.
 * Represents a user's continuous interaction within a Telegram topic.
 */
export interface TopicSession {
    /** Push a user message into the session */
    receiveInput(input: { text: string; username?: string; richInput?: RichUserInput }): void

    /** Push a semantic input into the session runtime */
    dispatch(input: SessionInput): Promise<unknown>

    /** Destroy the session and clean up resources */
    destroy(reason?: SessionExtensionLifecycleReason): Promise<void>

    /** Current session state */
    readonly state: SessionState

    /** The underlying session metadata record */
    readonly sessionRecord: SessionRecord

    /** The channel port (for accessing channel-specific features like table history) */
    readonly channelPort: ChannelPort

    /** Get current query progress info, or null if no query is running */
    getProgress(): {
        state: SessionState
        elapsedSeconds: number
        lastToolName: string | null
        outbox?: {
            pendingControl: number
            pendingNormal: number
            pendingProgressiveEdits: number
            queuedUnconfirmed: number
            progressiveEditBlockedUntil?: number
            lastRateLimitError?: string
            lastFailure?: string
        }
    } | null

    /** Inspect queued channel deliveries for async MCP operations */
    getDeliveryStatus(deliveryId?: string): {
        deliveries: DeliveryRecord[]
    }

    /** Retry a retained channel delivery by ID */
    retryDelivery(deliveryId: string): Promise<RetryDeliveryCommandResult>
}
