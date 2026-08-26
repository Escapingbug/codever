import type { DecisionOption, DecisionResponse } from '@/bridge/channelPort'

interface PendingDecision {
    resolve: (response: DecisionResponse) => void
    timeout: ReturnType<typeof setTimeout>
    options: DecisionOption[]
    multiple: boolean
    selectedIndexes: Set<number>
}

export type PendingDecisionCallbackResult =
    | { status: 'missing' | 'invalid' }
    | { status: 'updated'; replyMarkup: PendingDecisionReplyMarkup; notice: string }
    | { status: 'completed'; value: string | string[]; notice: string }

export interface PendingDecisionReplyMarkup {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
}

const pendingDecisions = new Map<string, PendingDecision>()

export function registerPendingDecision(options: {
    fallbackValue?: string | string[]
    timeoutMs?: number
    decisionOptions?: DecisionOption[]
    multiple?: boolean
} = {}): { decisionId: string; promise: Promise<DecisionResponse> } {
    const decisionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const fallbackValue = options.fallbackValue ?? ''
    const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000

    const promise = new Promise<DecisionResponse>((resolve) => {
        const timeout = setTimeout(() => {
            pendingDecisions.delete(decisionId)
            resolve({ value: fallbackValue })
        }, timeoutMs)

        pendingDecisions.set(decisionId, {
            resolve,
            timeout,
            options: options.decisionOptions ?? [],
            multiple: options.multiple === true,
            selectedIndexes: new Set(),
        })
    })

    return { decisionId, promise }
}

export function completePendingDecision(decisionId: string, value: string): boolean {
    const pending = pendingDecisions.get(decisionId)
    // Legacy semantic decisions embed their value in callback_data. Decisions
    // registered with explicit options must use the indexed callback path.
    if (!pending || pending.options.length > 0) return false

    clearTimeout(pending.timeout)
    pendingDecisions.delete(decisionId)
    pending.resolve({ value })
    return true
}

export function cancelPendingDecision(decisionId: string, fallbackValue: string | string[]): boolean {
    const pending = pendingDecisions.get(decisionId)
    if (!pending) return false
    resolvePendingDecision(decisionId, pending, fallbackValue)
    return true
}

export function handlePendingDecisionCallback(
    decisionId: string,
    action: string,
    optionIndex?: number,
): PendingDecisionCallbackResult {
    const pending = pendingDecisions.get(decisionId)
    if (!pending) return { status: 'missing' }

    if (action === 'select') {
        if (pending.multiple || !isValidOptionIndex(pending, optionIndex)) return { status: 'invalid' }
        const value = pending.options[optionIndex!].value
        resolvePendingDecision(decisionId, pending, value)
        return { status: 'completed', value, notice: value === 'deny' ? '❌ Denied' : '✅ Selected' }
    }

    if (action === 'toggle') {
        if (!pending.multiple || !isValidOptionIndex(pending, optionIndex)) return { status: 'invalid' }
        if (pending.selectedIndexes.has(optionIndex!)) {
            pending.selectedIndexes.delete(optionIndex!)
        } else {
            pending.selectedIndexes.add(optionIndex!)
        }
        return {
            status: 'updated',
            replyMarkup: buildPendingDecisionReplyMarkup(decisionId),
            notice: `${pending.selectedIndexes.size} selected`,
        }
    }

    if (action === 'done') {
        if (!pending.multiple) return { status: 'invalid' }
        if (pending.selectedIndexes.size === 0) {
            return {
                status: 'updated',
                replyMarkup: buildPendingDecisionReplyMarkup(decisionId),
                notice: 'Select at least one option',
            }
        }
        const value = Array.from(pending.selectedIndexes)
            .sort((left, right) => left - right)
            .map(index => pending.options[index].value)
        resolvePendingDecision(decisionId, pending, value)
        return { status: 'completed', value, notice: '✅ Selected' }
    }

    return { status: 'invalid' }
}

export function buildPendingDecisionReplyMarkup(decisionId: string): PendingDecisionReplyMarkup {
    const pending = pendingDecisions.get(decisionId)
    if (!pending) return { inline_keyboard: [] }

    if (!pending.multiple) {
        return {
            inline_keyboard: [[...pending.options.map((option, index) => ({
                text: option.label,
                callback_data: `decision:${decisionId}:ui:select:${index}`,
            }))]],
        }
    }

    return {
        inline_keyboard: [
            ...pending.options.map((option, index) => [{
                text: `${pending.selectedIndexes.has(index) ? '✅' : '⬜'} ${option.label}`,
                callback_data: `decision:${decisionId}:ui:toggle:${index}`,
            }]),
            [{
                text: `Confirm (${pending.selectedIndexes.size})`,
                callback_data: `decision:${decisionId}:ui:done`,
            }],
        ],
    }
}

function isValidOptionIndex(pending: PendingDecision, optionIndex: number | undefined): boolean {
    return Number.isInteger(optionIndex)
        && optionIndex! >= 0
        && optionIndex! < pending.options.length
}

function resolvePendingDecision(
    decisionId: string,
    pending: PendingDecision,
    value: string | string[],
): void {
    clearTimeout(pending.timeout)
    pendingDecisions.delete(decisionId)
    pending.resolve({ value })
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
