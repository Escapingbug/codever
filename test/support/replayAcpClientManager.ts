import type { AgentPermissionHandler } from '../../src/providers/provider'
import { AcpProvider } from '../../src/providers/acp'

export interface AcpReplayNotification {
    type: 'notification'
    update: Record<string, unknown>
}

export interface AcpReplayGate {
    type: 'gate'
    name: string
}

export interface AcpReplayPermission {
    type: 'permission'
    toolName: string
    input: unknown
}

export type AcpReplayStep = AcpReplayNotification | AcpReplayGate | AcpReplayPermission

export interface AcpReplayTurn {
    input: string
    steps: AcpReplayStep[]
    stopReason: string
}

export interface AcpReplayFixture {
    schemaVersion: 1
    name: string
    sessionId: string
    turns: AcpReplayTurn[]
}

interface SessionNotification {
    sessionId: string
    update: Record<string, unknown>
}

interface Waiter {
    resolve(value: SessionNotification): void
    reject(error: unknown): void
    signal?: AbortSignal
}

interface ActivePrompt {
    sessionId: string
    settled: boolean
    resolve(value: { stopReason: string }): void
}

/**
 * Replays captured ACP session/update traffic at the AcpClientManager boundary.
 * The production AcpProvider and Gateway runtime remain real; only the external
 * ACP subprocess is replaced. Gates are explicit instead of time based so
 * cancellation and reconnect journeys are deterministic on slow CI machines.
 */
export class ReplayAcpClientManager {
    readonly connected = true
    readonly supportsResumeSession = true
    readonly agentCapabilities = {
        agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { resume: {} },
        },
    }
    readonly promptCapabilities = {}
    readonly observedPrompts: string[] = []
    readonly observedModels: string[] = []
    readonly observedResumeSessionIds: string[] = []
    readonly permissionResults: unknown[] = []

    private readonly queue: SessionNotification[] = []
    private readonly waiters: Waiter[] = []
    private readonly gates = new Map<string, Promise<void>>()
    private readonly gateResolvers = new Map<string, () => void>()
    private readonly reachedGates = new Map<string, Promise<void>>()
    private readonly reachedGateResolvers = new Map<string, () => void>()
    private permissionHandler: AgentPermissionHandler | null = null
    private nextTurn = 0
    private activePrompt?: ActivePrompt
    private processing: Promise<void> = Promise.resolve()

    constructor(readonly fixture: AcpReplayFixture) {
        if (fixture.schemaVersion !== 1) throw new Error(`Unsupported ACP replay fixture version: ${fixture.schemaVersion}`)
        for (const turn of fixture.turns) {
            for (const step of turn.steps) {
                if (step.type !== 'gate' || this.gates.has(step.name)) continue
                let release!: () => void
                this.gates.set(step.name, new Promise<void>(resolve => { release = resolve }))
                this.gateResolvers.set(step.name, release)
                let reached!: () => void
                this.reachedGates.set(step.name, new Promise<void>(resolve => { reached = resolve }))
                this.reachedGateResolvers.set(step.name, reached)
            }
        }
    }

    setPermissionHandler(handler: AgentPermissionHandler | null): void { this.permissionHandler = handler }
    setExtensionHandler(): void {}
    clearStderrBuffer(): void {}
    getStderrError(): string | null { return null }
    async init(): Promise<void> {}
    async close(): Promise<void> { this.resolveAllGates() }
    async newSession(): Promise<{ sessionId: string }> { return { sessionId: this.fixture.sessionId } }
    async loadSession(): Promise<Record<string, never>> { return {} }
    async resumeSession(input: { sessionId: string }): Promise<Record<string, never>> {
        this.observedResumeSessionIds.push(input.sessionId)
        return {}
    }
    async setSessionConfigOption(): Promise<Record<string, never>> { return {} }
    async setSessionModel(input: { modelId: string }): Promise<Record<string, never>> {
        this.observedModels.push(input.modelId)
        return {}
    }

    prompt(input: { sessionId: string; prompt: Array<Record<string, unknown>> }): Promise<{ stopReason: string }> {
        const turn = this.fixture.turns[this.nextTurn++]
        if (!turn) return Promise.reject(new Error(`ACP replay exhausted after ${this.nextTurn - 1} turns`))
        const text = promptText(input.prompt)
        this.observedPrompts.push(text)
        if (text !== turn.input) {
            return Promise.reject(new Error(`ACP replay input mismatch: expected ${JSON.stringify(turn.input)}, received ${JSON.stringify(text)}`))
        }

        const response = new Promise<{ stopReason: string }>(resolve => {
            this.activePrompt = { sessionId: input.sessionId, settled: false, resolve }
        })
        const active = this.activePrompt
        this.processing = this.runTurn(active, turn)
        return response
    }

    completeActivePrompt(sessionId: string, response: { stopReason: string }): boolean {
        const active = this.activePrompt
        if (!active || active.sessionId !== sessionId || active.settled) return false
        active.settled = true
        active.resolve(response)
        return true
    }

    async cancelActivePrompt(): Promise<{ stopReason: string } | undefined> {
        const active = this.activePrompt
        if (!active || active.settled) return undefined
        active.settled = true
        active.resolve({ stopReason: 'cancelled' })
        this.resolveAllGates()
        return { stopReason: 'cancelled' }
    }

    async waitForSessionUpdateProcessing(): Promise<void> { await this.processing }

    waitForSessionUpdate(_sessionId: string, options: { signal?: AbortSignal } = {}): Promise<SessionNotification> {
        const queued = this.queue.shift()
        if (queued) return Promise.resolve(queued)
        if (options.signal?.aborted) return Promise.reject(new Error('Session update wait aborted'))
        return new Promise((resolve, reject) => {
            const waiter: Waiter = { resolve, reject, signal: options.signal }
            const abort = () => {
                const index = this.waiters.indexOf(waiter)
                if (index >= 0) this.waiters.splice(index, 1)
                reject(new Error('Session update wait aborted'))
            }
            options.signal?.addEventListener('abort', abort, { once: true })
            this.waiters.push({
                ...waiter,
                resolve: value => {
                    options.signal?.removeEventListener('abort', abort)
                    resolve(value)
                },
            })
        })
    }

    dequeueSessionUpdate(): SessionNotification | undefined { return this.queue.shift() }
    drainSessionUpdates(): number {
        const count = this.queue.length
        this.queue.length = 0
        return count
    }
    async drainSessionUpdatesUntilIdle(): Promise<number> { return this.drainSessionUpdates() }

    async waitUntilGate(name: string): Promise<void> {
        const reached = this.reachedGates.get(name)
        if (!reached) throw new Error(`Unknown ACP replay gate: ${name}`)
        await reached
    }

    release(name: string): void {
        const release = this.gateResolvers.get(name)
        if (!release) throw new Error(`Unknown or already released ACP replay gate: ${name}`)
        this.gateResolvers.delete(name)
        release()
    }

    private async runTurn(active: ActivePrompt, turn: AcpReplayTurn): Promise<void> {
        for (const step of turn.steps) {
            if (active.settled) return
            if (step.type === 'notification') {
                this.emit({ sessionId: active.sessionId, update: structuredClone(step.update) })
                await Promise.resolve()
                continue
            }
            if (step.type === 'permission') {
                if (!this.permissionHandler) throw new Error('ACP replay requested permission without a permission handler')
                const result = await this.permissionHandler.handleToolCall(step.toolName, structuredClone(step.input), {
                    signal: new AbortController().signal,
                })
                this.permissionResults.push(result)
                continue
            }
            this.reachedGateResolvers.get(step.name)?.()
            await this.gates.get(step.name)
        }
        if (!active.settled) {
            active.settled = true
            active.resolve({ stopReason: turn.stopReason })
        }
    }

    private emit(notification: SessionNotification): void {
        const waiter = this.waiters.shift()
        if (waiter) waiter.resolve(notification)
        else this.queue.push(notification)
    }

    private resolveAllGates(): void {
        for (const release of this.gateResolvers.values()) release()
        this.gateResolvers.clear()
    }
}

export function createReplayAcpProvider(fixture: AcpReplayFixture): {
    provider: AcpProvider
    manager: ReplayAcpClientManager
} {
    const provider = new AcpProvider({ name: 'codex', command: 'replay', args: [] })
    const manager = new ReplayAcpClientManager(fixture)
    ;(provider as unknown as { clientManager: ReplayAcpClientManager }).clientManager = manager
    ;(provider as unknown as { initialized: boolean }).initialized = true
    return { provider, manager }
}

function promptText(parts: Array<Record<string, unknown>>): string {
    return parts
        .filter(part => part.type === 'text' && typeof part.text === 'string')
        .map(part => part.text as string)
        .join('')
}
