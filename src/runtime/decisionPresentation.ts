const MAX_DECISION_BUTTON_LABEL_CHARS = 28

export interface DecisionPresentationOption {
    label: string
}

export function formatDecisionOptionList(options: DecisionPresentationOption[]): string {
    return options
        .map((option, index) => `${index + 1}. ${normalizeOptionLabel(option.label)}`)
        .join('\n')
}

export function formatDecisionButtonLabel(label: string, index: number): string {
    const normalized = normalizeOptionLabel(label)
    const characters = Array.from(normalized)
    const compact = characters.length > MAX_DECISION_BUTTON_LABEL_CHARS
        ? `${characters.slice(0, MAX_DECISION_BUTTON_LABEL_CHARS - 1).join('')}…`
        : normalized
    return `${index + 1} · ${compact}`
}

function normalizeOptionLabel(label: string): string {
    return label.replace(/\s+/g, ' ').trim() || 'Option'
}
