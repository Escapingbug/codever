import type { DecisionResponse } from '@/bridge/channelPort'

interface PendingDecision {
    resolve: (response: DecisionResponse) => void
    timeout: ReturnType<typeof setTimeout>
}

const pendingDecisions = new Map<string, PendingDecision>()

export function registerPendingDecision(options: {
    fallbackValue?: string
    timeoutMs?: number
} = {}): { decisionId: string; promise: Promise<DecisionResponse> } {
    const decisionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const fallbackValue = options.fallbackValue ?? ''
    const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000

    const promise = new Promise<DecisionResponse>((resolve) => {
        const timeout = setTimeout(() => {
            pendingDecisions.delete(decisionId)
            resolve({ value: fallbackValue })
        }, timeoutMs)

        pendingDecisions.set(decisionId, { resolve, timeout })
    })

    return { decisionId, promise }
}

export function completePendingDecision(decisionId: string, value: string): boolean {
    const pending = pendingDecisions.get(decisionId)
    if (!pending) return false

    clearTimeout(pending.timeout)
    pendingDecisions.delete(decisionId)
    pending.resolve({ value })
    return true
}

export function pendingDecisionCount(): number {
    return pendingDecisions.size
}

export function clearPendingDecisionsForTests(): void {
    for (const pending of pendingDecisions.values()) {
        clearTimeout(pending.timeout)
    }
    pendingDecisions.clear()
}
