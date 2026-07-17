import type { AgentQueryInput } from '@/providers/provider'
import type { ConversationEvent } from '@/runtime/semantic'

export type GatewaySessionState = 'idle' | 'querying' | 'canceling' | 'error' | 'closed'
export type GatewayTurnStatus = 'success' | 'error' | 'cancelled' | 'max_turns'

export interface GatewayUserMessageEvent {
    kind: 'user_message'
    turnId: string
    input: AgentQueryInput
    source?: 'live' | 'replay'
}

export interface GatewayTurnEvent {
    kind: 'turn'
    turnId: string
    phase: 'started' | 'finished'
    status?: GatewayTurnStatus
    summary?: string
}

export interface GatewayStateEvent {
    kind: 'state'
    previousState: GatewaySessionState
    state: GatewaySessionState
    reason?: string
}

export interface GatewayErrorEvent {
    kind: 'error'
    code: string
    message: string
    turnId?: string
}

export interface GatewayProviderSessionEvent {
    kind: 'provider_session'
    provider: string
    providerSessionId: string
    isNewSession?: boolean
}

export interface GatewaySettingsEvent {
    kind: 'settings'
    model?: string
    providerSettings: Record<string, unknown>
}

export interface GatewayDecisionOption {
    id: string
    label: string
    value: unknown
}

export interface GatewayDecisionRequest {
    type: 'permission' | 'question'
    title: string
    details?: string
    options: GatewayDecisionOption[]
    turnId?: string
    expiresInMs?: number
    allowedResponderIds?: string[]
}

export type GatewayDecisionResolutionStatus = 'resolved' | 'expired' | 'cancelled'

export interface GatewayDecisionEvent {
    kind: 'decision'
    phase: 'requested' | GatewayDecisionResolutionStatus
    decisionId: string
    request: GatewayDecisionRequest
    expiresAt: string
    optionId?: string
    value?: unknown
    responderId?: string
    reason?: string
}

/** Events persisted in the authoritative Gateway conversation journal. */
export type GatewayConversationEvent =
    | GatewayUserMessageEvent
    | GatewayTurnEvent
    | GatewayStateEvent
    | GatewayErrorEvent
    | GatewayProviderSessionEvent
    | GatewaySettingsEvent
    | GatewayDecisionEvent
    | ConversationEvent
