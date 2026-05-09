import type { SessionInput, ConversationEvent } from './semantic'
import { ConversationJournal } from './semantic'

export type ActorState = 'idle' | 'running' | 'finalizing' | 'dead'

export interface SessionActorHandlers {
    onUserMessage(input: Extract<SessionInput, { kind: 'user_message' }>): Promise<void> | void
    onCancel?(input: Extract<SessionInput, { kind: 'cancel' }>): Promise<void> | void
    onDecisionResponse?(input: Extract<SessionInput, { kind: 'decision_response' }>): Promise<void> | void
    onCommand?(input: Extract<SessionInput, { kind: 'command' }>): Promise<void> | void
    onScheduledMessage?(input: Extract<SessionInput, { kind: 'scheduled_message' }>): Promise<void> | void
    onEvent?(event: ConversationEvent): Promise<void> | void
    onFinalize?(): Promise<void> | void
}

export class SessionActor {
    readonly journal = new ConversationJournal()
    private mailbox: Promise<void> = Promise.resolve()
    private _state: ActorState = 'idle'

    constructor(private handlers: SessionActorHandlers) {}

    get state(): ActorState {
        return this._state
    }

    dispatch(input: SessionInput): Promise<void> {
        this.mailbox = this.mailbox.then(() => this.handleInput(input))
        return this.mailbox
    }

    record(event: ConversationEvent): boolean {
        const appended = this.journal.append(event)
        if (appended) {
            void this.handlers.onEvent?.(event)
        }
        return appended
    }

    async finalize(): Promise<void> {
        if (this._state === 'dead') return
        this._state = 'finalizing'
        await this.handlers.onFinalize?.()
        this._state = 'idle'
    }

    async destroy(): Promise<void> {
        await this.mailbox
        this._state = 'dead'
    }

    private async handleInput(input: SessionInput): Promise<void> {
        if (this._state === 'dead') return

        switch (input.kind) {
            case 'user_message':
                this._state = 'running'
                await this.handlers.onUserMessage(input)
                break
            case 'scheduled_message':
                this._state = 'running'
                await this.handlers.onScheduledMessage?.(input)
                break
            case 'cancel':
                await this.handlers.onCancel?.(input)
                break
            case 'decision_response':
                await this.handlers.onDecisionResponse?.(input)
                break
            case 'command':
                await this.handlers.onCommand?.(input)
                break
        }
    }
}
