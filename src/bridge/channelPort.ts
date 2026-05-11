/**
 * ChannelPort — The interface between bridge logic and any messaging channel.
 * 
 * Implementations: TelegramPort, DiscordPort, CLIPort
 */

import type { SessionState } from '@/core/types'
import type { SessionInput } from '@/runtime/semantic'
import type { SessionRecord } from './sessionRecord'

export interface ChannelMessage {
    text: string
    format: 'markdown' | 'html' | 'plain'
    replyMarkup?: unknown
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

export interface SessionStatus {
    state: SessionState
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

export interface ChannelPort {
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
    receiveInput(input: { text: string; username?: string }): void

    /** Push a semantic input into the session runtime */
    dispatch(input: SessionInput): Promise<void>

    /** Destroy the session and clean up resources */
    destroy(): Promise<void>

    /** Current session state */
    readonly state: SessionState

    /** The underlying session metadata record */
    readonly sessionRecord: SessionRecord

    /** The channel port (for accessing channel-specific features like table history) */
    readonly channelPort: ChannelPort

    /** Get current query progress info, or null if no query is running */
    getProgress(): { elapsedSeconds: number; lastToolName: string | null } | null
}
