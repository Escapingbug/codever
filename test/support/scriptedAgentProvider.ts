import type {
    AgentPermissionHandler,
    AgentProvider,
    AgentQueryConfig,
    AgentQueryHandle,
    AgentQueryInput,
    ModelEntry,
    SessionHistoryEntry,
} from '../../src/providers/provider'
import type { AgentEvent } from '../../src/providers/types'

interface Deferred<T> {
    promise: Promise<T>
    resolve(value: T): void
}

export class ScriptedAgentProvider implements AgentProvider {
    readonly starts: Array<{ input: AgentQueryInput; config: AgentQueryConfig; turn: ScriptedAgentTurn }> = []
    readonly name: string
    private readonly turnWaiters: Array<Deferred<ScriptedAgentTurn>> = []

    constructor(options: {
        name?: string
        history?: SessionHistoryEntry[]
        models?: ModelEntry[]
        permissionModes?: string[]
    } = {}) {
        this.name = options.name ?? 'scripted-agent'
        this.history = options.history ?? []
        this.models = options.models ?? [{ id: 'scripted-model', name: 'Scripted model' }]
        this.permissionModes = options.permissionModes ?? ['default', 'bypassPermissions']
    }

    private readonly history: SessionHistoryEntry[]
    private readonly models: ModelEntry[]
    private readonly permissionModes: string[]

    startQuery(input: AgentQueryInput, config: AgentQueryConfig): AgentQueryHandle {
        const turn = new ScriptedAgentTurn(config.permissionHandler)
        this.starts.push({ input, config, turn })
        this.turnWaiters.shift()?.resolve(turn)
        return {
            events: turn,
            interrupt: async () => turn.close(),
        }
    }

    async nextTurn(): Promise<ScriptedAgentTurn> {
        const unclaimed = this.starts.find(entry => !entry.turn.claimed)?.turn
        if (unclaimed) {
            unclaimed.claimed = true
            return unclaimed
        }
        const waiter = deferred<ScriptedAgentTurn>()
        this.turnWaiters.push(waiter)
        const turn = await waiter.promise
        turn.claimed = true
        return turn
    }

    isReady(): boolean { return true }
    getInitError(): string | null { return null }
    getAvailableModels(): ModelEntry[] { return [...this.models] }
    getAvailablePermissionModes(): string[] { return [...this.permissionModes] }
    async getSessionHistory(): Promise<SessionHistoryEntry[]> { return [...this.history] }
}

export class ScriptedAgentTurn implements AsyncIterable<AgentEvent> {
    claimed = false
    private readonly queued: AgentEvent[] = []
    private readonly waiters: Array<Deferred<IteratorResult<AgentEvent>>> = []
    private closed = false

    constructor(readonly permissions?: AgentPermissionHandler) {}

    emit(event: AgentEvent): void {
        if (this.closed) throw new Error('Scripted Agent turn is closed')
        const waiter = this.waiters.shift()
        if (waiter) waiter.resolve({ done: false, value: event })
        else this.queued.push(event)
    }

    finish(status: 'success' | 'error' | 'max_turns' = 'success', summary?: string): void {
        this.emit({ kind: 'result', status, ...(summary ? { summary } : {}) })
        this.close()
    }

    close(): void {
        if (this.closed) return
        this.closed = true
        for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined })
    }

    [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
        return {
            next: () => {
                const value = this.queued.shift()
                if (value) return Promise.resolve({ done: false, value })
                if (this.closed) return Promise.resolve({ done: true, value: undefined })
                const waiter = deferred<IteratorResult<AgentEvent>>()
                this.waiters.push(waiter)
                return waiter.promise
            },
        }
    }
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
}
