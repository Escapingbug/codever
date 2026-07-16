import { randomUUID } from 'node:crypto'
import type {
    GatewayDecisionEvent,
    GatewayDecisionRequest,
    GatewayDecisionResolutionStatus,
} from './events'

export interface DecisionResolution {
    status: GatewayDecisionResolutionStatus
    decisionId: string
    optionId?: string
    value?: unknown
    responderId?: string
    reason?: string
}

export interface DecisionHandle {
    decisionId: string
    result: Promise<DecisionResolution>
}

export type DecisionResponseResult =
    | { status: 'accepted'; resolution: DecisionResolution }
    | { status: 'already_resolved' | 'expired' | 'cancelled' | 'not_found' | 'unauthorized' | 'invalid_option' }

export interface DecisionBrokerConfig {
    publish: (event: GatewayDecisionEvent) => Promise<void>
    defaultExpiryMs?: number
    now?: () => number
    createId?: () => string
}

interface PendingDecision {
    request: GatewayDecisionRequest
    expiresAt: number
    timer: ReturnType<typeof setTimeout>
    resolve: (resolution: DecisionResolution) => void
    result: Promise<DecisionResolution>
}

/** Session-scoped, fail-closed arbitration for provider and tool decisions. */
export class DecisionBroker {
    private readonly pending = new Map<string, PendingDecision>()
    private readonly settled = new Map<string, DecisionResolution>()
    private readonly now: () => number
    private readonly createId: () => string
    private readonly defaultExpiryMs: number

    constructor(private readonly config: DecisionBrokerConfig) {
        this.now = config.now ?? Date.now
        this.createId = config.createId ?? randomUUID
        this.defaultExpiryMs = config.defaultExpiryMs ?? 60_000
    }

    async open(request: GatewayDecisionRequest): Promise<DecisionHandle> {
        const decisionId = this.createId()
        const expiresInMs = Math.max(0, request.expiresInMs ?? this.defaultExpiryMs)
        const expiresAt = this.now() + expiresInMs
        let resolve!: (resolution: DecisionResolution) => void
        const result = new Promise<DecisionResolution>((settle) => {
            resolve = settle
        })
        const timer = setTimeout(() => {
            void this.settle(decisionId, {
                status: 'expired',
                decisionId,
                reason: 'Decision expired without a response.',
            }).catch(() => undefined)
        }, expiresInMs)

        this.pending.set(decisionId, { request, expiresAt, timer, resolve, result })
        try {
            await this.config.publish({
                kind: 'decision',
                phase: 'requested',
                decisionId,
                request,
                expiresAt: new Date(expiresAt).toISOString(),
            })
        } catch (error) {
            clearTimeout(timer)
            this.pending.delete(decisionId)
            resolve({
                status: 'cancelled',
                decisionId,
                reason: 'Decision request could not be recorded durably.',
            })
            throw error
        }

        return { decisionId, result }
    }

    async respond(decisionId: string, optionId: string, responderId?: string): Promise<DecisionResponseResult> {
        const pending = this.pending.get(decisionId)
        if (!pending) return this.responseForSettled(decisionId)

        if (this.now() >= pending.expiresAt) {
            await this.settle(decisionId, {
                status: 'expired',
                decisionId,
                reason: 'Decision response arrived after expiry.',
            })
            return { status: 'expired' }
        }

        const allowed = pending.request.allowedResponderIds
        if (allowed && (!responderId || !allowed.includes(responderId))) {
            return { status: 'unauthorized' }
        }

        const option = pending.request.options.find((candidate) => candidate.id === optionId)
        if (!option) return { status: 'invalid_option' }

        const resolution: DecisionResolution = {
            status: 'resolved',
            decisionId,
            optionId,
            value: option.value,
            ...(responderId ? { responderId } : {}),
        }
        await this.settle(decisionId, resolution)
        return { status: 'accepted', resolution }
    }

    async cancel(decisionId: string, reason = 'Decision cancelled.'): Promise<boolean> {
        if (!this.pending.has(decisionId)) return false
        await this.settle(decisionId, { status: 'cancelled', decisionId, reason })
        return true
    }

    async cancelAll(reason = 'Session cancelled.'): Promise<void> {
        await Promise.all([...this.pending.keys()].map((decisionId) => this.cancel(decisionId, reason)))
    }

    get pendingCount(): number {
        return this.pending.size
    }

    private async settle(decisionId: string, resolution: DecisionResolution): Promise<void> {
        const pending = this.pending.get(decisionId)
        if (!pending) return

        clearTimeout(pending.timer)
        this.pending.delete(decisionId)
        this.settled.set(decisionId, resolution)
        try {
            await this.config.publish({
                kind: 'decision',
                phase: resolution.status,
                decisionId,
                request: pending.request,
                expiresAt: new Date(pending.expiresAt).toISOString(),
                ...(resolution.optionId ? { optionId: resolution.optionId } : {}),
                ...(resolution.value !== undefined ? { value: resolution.value } : {}),
                ...(resolution.responderId ? { responderId: resolution.responderId } : {}),
                ...(resolution.reason ? { reason: resolution.reason } : {}),
            })
            pending.resolve(resolution)
        } catch (error) {
            const failClosed: DecisionResolution = {
                status: 'cancelled',
                decisionId,
                reason: 'Decision resolution could not be recorded durably.',
            }
            this.settled.set(decisionId, failClosed)
            pending.resolve(failClosed)
            throw error
        }
    }

    private responseForSettled(decisionId: string): DecisionResponseResult {
        const resolution = this.settled.get(decisionId)
        if (!resolution) return { status: 'not_found' }
        if (resolution.status === 'expired') return { status: 'expired' }
        if (resolution.status === 'cancelled') return { status: 'cancelled' }
        return { status: 'already_resolved' }
    }
}
