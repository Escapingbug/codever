import { randomUUID } from 'node:crypto'
import type { EventBus } from '@/core/eventBus'
import { DefaultEventBus } from '@/core/eventBus'
import type { SessionState } from '@/core/types'
import type { AgentProvider } from '@/providers/provider'
import type { ProviderCommand } from '@/providers/types'

export interface SessionRecordOptions {
    cwd: string
    providerName: string
    groupChatId: number
    messageThreadId?: number
    model?: string
    verboseLevel?: 0 | 1 | 2
    timeoutSeconds?: number
    providerSettings?: Record<string, unknown>
    conversationId?: string | null
    bus?: EventBus
}

export interface SessionRecord {
    readonly id: string
    readonly state: SessionState
    readonly bus: EventBus
    readonly cwd: string
    readonly model: string | null
    readonly providerName: string
    readonly verboseLevel: 0 | 1 | 2
    readonly timeoutSeconds: number
    readonly timeoutExtended: boolean
    readonly providerSettings: Record<string, unknown>
    availableCommands: ProviderCommand[]
    groupChatId: number | null
    messageThreadId: number | null
    conversationId: string | null
    onLog?: (message: string) => void
    setProvider(provider: AgentProvider): void
    setProviderName(name: string): void
    setConversationId(sessionId: string | null): void
    setModel(model: string): void
    setVerboseLevel(level: 0 | 1 | 2): void
    setTimeoutSeconds(seconds: number): void
    setTimeoutExtended(extended: boolean): void
    destroy(): Promise<void>
}

export class TopicSessionRecord implements SessionRecord {
    readonly id = randomUUID()
    readonly bus: EventBus
    readonly cwd: string
    readonly providerSettings: Record<string, unknown>
    groupChatId: number | null
    messageThreadId: number | null
    conversationId: string | null
    availableCommands: ProviderCommand[] = []
    onLog?: (message: string) => void

    private _state: SessionState = 'idle'
    private _model: string | null
    private _providerName: string
    private _verboseLevel: 0 | 1 | 2
    private _timeoutSeconds: number
    private _timeoutExtended = false

    constructor(options: SessionRecordOptions) {
        this.cwd = options.cwd
        this.bus = options.bus ?? new DefaultEventBus()
        this._providerName = options.providerName
        this._model = options.model ?? null
        this._verboseLevel = options.verboseLevel ?? 1
        this._timeoutSeconds = options.timeoutSeconds ?? 180
        this.providerSettings = options.providerSettings ?? {}
        this.groupChatId = options.groupChatId
        this.messageThreadId = options.messageThreadId ?? null
        this.conversationId = options.conversationId ?? null
        this.bus.emit({ type: 'session.created', sessionId: this.id })
    }

    get state(): SessionState { return this._state }
    get model(): string | null { return this._model }
    get providerName(): string { return this._providerName }
    get verboseLevel(): 0 | 1 | 2 { return this._verboseLevel }
    get timeoutSeconds(): number { return this._timeoutSeconds }
    get timeoutExtended(): boolean { return this._timeoutExtended }

    setProvider(provider: AgentProvider): void {
        void provider
    }

    setProviderName(name: string): void {
        this._providerName = name
    }

    setConversationId(sessionId: string | null): void {
        const prev = this.conversationId
        this.conversationId = sessionId
        this.log(`[SessionRecord] setConversationId: ${prev?.slice(0, 8) ?? 'null'} -> ${sessionId?.slice(0, 8) ?? 'null'} (record=${this.id.slice(0, 8)})`)
    }

    setModel(model: string): void {
        this._model = model
    }

    setVerboseLevel(level: 0 | 1 | 2): void {
        this._verboseLevel = level
    }

    setTimeoutSeconds(seconds: number): void {
        this._timeoutSeconds = seconds
    }

    setTimeoutExtended(extended: boolean): void {
        this._timeoutExtended = extended
    }

    async destroy(): Promise<void> {
        if (this._state === 'dead') return
        const from = this._state
        this._state = 'dead'
        this.bus.emit({ type: 'session.state_changed', sessionId: this.id, from, to: 'dead' })
        this.bus.emit({ type: 'session.destroyed', sessionId: this.id })
    }

    private log(message: string): void {
        if (this.onLog) {
            this.onLog(message)
        } else {
            console.error(message)
        }
    }
}

export function createSessionRecord(options: SessionRecordOptions): SessionRecord {
    return new TopicSessionRecord(options)
}
