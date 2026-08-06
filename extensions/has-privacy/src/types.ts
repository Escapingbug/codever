export type HasMapping = Readonly<Record<string, readonly string[]>>

export interface HasEngineIdentity {
    adapter: string
    model: string
    modelRevision: string
    promptRevision: string
}

export interface HasHideResult {
    anonymizedText: string
    mappingDelta: HasMapping
    identity: HasEngineIdentity
}

export interface HasAdapter {
    readonly identity: HasEngineIdentity
    hide(input: {
        text: string
        entityTypes: readonly string[]
        mapping: HasMapping
    }): Promise<HasHideResult>
}

export type ExtensionInput = string | {
    parts: Array<{ type: string; text?: string; [key: string]: unknown }>
}

export interface ExtensionSession {
    sessionId: string
    cwd: string
    providerName: string
}

export interface ExtensionTurn {
    sessionId: string
    turnId: string
    providerName: string
}

export interface ExtensionBinding {
    id: string
    config?: Record<string, unknown>
}

export interface ConversationEvent {
    kind: string
    meta: Record<string, unknown>
    [key: string]: unknown
}
