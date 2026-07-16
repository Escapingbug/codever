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
