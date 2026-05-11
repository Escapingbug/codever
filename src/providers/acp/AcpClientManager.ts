import { spawn, type ChildProcess } from 'node:child_process'
import { Writable, Readable } from 'node:stream'
import { ClientSideConnection, ndJsonStream, type Client, type Agent } from '@agentclientprotocol/sdk'
import type {
    InitializeResponse,
    NewSessionRequest,
    NewSessionResponse,
    LoadSessionRequest,
    LoadSessionResponse,
    ResumeSessionRequest,
    ResumeSessionResponse,
    PromptRequest,
    PromptResponse,
    CancelNotification,
    SessionNotification,
    RequestPermissionRequest,
    RequestPermissionResponse,
    ReadTextFileRequest,
    ReadTextFileResponse,
    WriteTextFileRequest,
    WriteTextFileResponse,
    SetSessionModelRequest,
    SetSessionModelResponse,
    SetSessionConfigOptionRequest,
    SetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk'
import type { AgentPermissionHandler, AgentPermissionResult } from '@/providers/provider'

export interface AcpClientManagerConfig {
    command: string
    args: string[]
    env?: Record<string, string>
    cwd?: string
}

export interface AcpClientManagerOptions {
    permissionHandler?: AgentPermissionHandler
}

export interface AcpExtensionHandler {
    extMethod?(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>
    extNotification?(method: string, params: Record<string, unknown>): Promise<void>
}

const CANCEL_WAIT_MS = 2_500
const STDIN_CLOSE_GRACE_MS = 500
const SIGTERM_GRACE_MS = 1_500
const SIGKILL_GRACE_MS = 1_000

interface ActivePrompt {
    sessionId: string
    promise: Promise<PromptResponse>
    resolve: (response: PromptResponse) => void
    reject: (error: unknown) => void
}

export class AcpClientManager {
    private config: AcpClientManagerConfig
    private childProcess: ChildProcess | null = null
    private connection: ClientSideConnection | null = null
    private initResponse: InitializeResponse | null = null
    private _connected = false
    private _closing = false

    private sessionUpdates = new Map<string, SessionNotification[]>()
    private sessionWaiters = new Map<string, Array<{ resolve: (update: SessionNotification) => void; reject: (error: unknown) => void }>>()

    /** Sequence numbers for session updates, used to distinguish historical vs new updates */
    private sessionUpdateSeqs = new Map<string, number>()
    /** Boundary seq for historical updates — updates with seq <= boundary are discarded */
    private historicalSeqBoundaries = new Map<string, number>()

    private permissionHandler: AgentPermissionHandler | null = null
    private extensionHandler: AcpExtensionHandler | null = null
    private permissionResolvers = new Map<string, {
        resolve: (response: RequestPermissionResponse) => void
    }>()

    private stderrBuffer: string[] = []
    private readonly MAX_STDERR_LINES = 20

    private activePrompt: ActivePrompt | null = null
    private cancellingSessionIds = new Set<string>()

    private lastAgentExit: { reason: string; exitCode: number | null; signal: NodeJS.Signals | string | null } | null = null

    constructor(config: AcpClientManagerConfig) {
        this.config = config
    }

    get connected(): boolean {
        return this._connected && this.connection !== null && !this.connection.signal.aborted
    }

    get agentCapabilities(): InitializeResponse | null {
        return this.initResponse
    }

    /** Whether the agent supports session/resume (unstable) */
    get supportsResumeSession(): boolean {
        return this.initResponse?.agentCapabilities?.sessionCapabilities?.resume != null
    }

    setPermissionHandler(handler: AgentPermissionHandler | null): void {
        this.permissionHandler = handler
    }

    setExtensionHandler(handler: AcpExtensionHandler | null): void {
        this.extensionHandler = handler
    }

    getStderrError(): string | null {
        const fatalPatterns = [
            /ProviderModelNotFoundError/i,
            /ModelNotFoundError/i,
            /ProviderNotFoundError/i,
            /APIKeyError/i,
            /AuthenticationError/i,
            /RateLimitError/i,
        ]
        for (const line of this.stderrBuffer) {
            for (const pattern of fatalPatterns) {
                if (pattern.test(line)) {
                    return line.substring(0, 500)
                }
            }
        }
        return null
    }

    clearStderrBuffer(): void {
        this.stderrBuffer = []
    }

    async init(timeoutMs: number = 30_000): Promise<void> {
        if (this._connected) return

        try {
            const isWindows = process.platform === 'win32'
            this.childProcess = spawn(this.config.command, this.config.args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                cwd: this.config.cwd,
                env: { ...process.env, ...this.config.env },
                windowsHide: true,
                // On Windows, agent commands are typically .cmd wrappers (e.g. agent.cmd).
                // Node's spawn() cannot execute .cmd files directly without shell: true,
                // causing the process to exit immediately → "Connection closed" on ACP init.
                shell: isWindows,
            })

            this.childProcess.stderr?.on('data', (data: Buffer) => {
                const text = data.toString('utf-8').trim()
                if (text) {
                    console.error(`[acp-agent] ${text.substring(0, 200)}`)
                    this.stderrBuffer.push(text)
                    if (this.stderrBuffer.length > this.MAX_STDERR_LINES) {
                        this.stderrBuffer.shift()
                    }
                }
            })

            this.attachAgentLifecycleObservers(this.childProcess)

            const output = Writable.toWeb(this.childProcess.stdin!) as WritableStream<Uint8Array>
            const input = Readable.toWeb(this.childProcess.stdout!) as ReadableStream<Uint8Array>
            const stream = ndJsonStream(output, input)

            const clientHandler = this.createClientHandler()
            this.connection = new ClientSideConnection(
                (_agent: Agent) => clientHandler,
                stream,
            )

            const initPromise = this.connection.initialize({
                protocolVersion: 1,
                clientCapabilities: {},
                clientInfo: {
                    name: 'codever',
                    version: '0.1.0',
                },
            })

            this.initResponse = await Promise.race([
                initPromise,
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error(`ACP initialize timed out after ${timeoutMs}ms`)), timeoutMs)
                ),
            ])

            this._connected = true
            console.error(`[acp-agent] Initialized. Agent: ${this.initResponse.agentInfo?.name ?? 'unknown'} v${this.initResponse.agentInfo?.version ?? '?'}`)
        } catch (e) {
            this.dispose()
            throw e
        }
    }

    async newSession(params: Omit<NewSessionRequest, '_meta'>): Promise<NewSessionResponse> {
        const conn = this.requireConnection()
        const response = await conn.newSession({
            cwd: params.cwd,
            mcpServers: params.mcpServers,
        })
        this.sessionUpdates.set(response.sessionId, [])
        this.sessionWaiters.set(response.sessionId, [])
        return response
    }

    async loadSession(params: Omit<LoadSessionRequest, '_meta'>): Promise<LoadSessionResponse> {
        const conn = this.requireConnection()
        const response = await conn.loadSession({
            sessionId: params.sessionId,
            cwd: params.cwd,
            mcpServers: params.mcpServers,
        })
        if (!this.sessionUpdates.has(params.sessionId)) {
            this.sessionUpdates.set(params.sessionId, [])
            this.sessionWaiters.set(params.sessionId, [])
        }
        return response
    }

    async resumeSession(params: Omit<ResumeSessionRequest, '_meta'>): Promise<ResumeSessionResponse> {
        const conn = this.requireConnection()
        const response = await conn.unstable_resumeSession({
            sessionId: params.sessionId,
            cwd: params.cwd,
            mcpServers: params.mcpServers,
            additionalDirectories: params.additionalDirectories,
        })
        if (!this.sessionUpdates.has(params.sessionId)) {
            this.sessionUpdates.set(params.sessionId, [])
            this.sessionWaiters.set(params.sessionId, [])
        }
        return response
    }

    async prompt(params: Omit<PromptRequest, '_meta'>): Promise<PromptResponse> {
        const conn = this.requireConnection()

        let promptResolve!: (response: PromptResponse) => void
        let promptReject!: (error: unknown) => void
        const promptPromise = new Promise<PromptResponse>((resolve, reject) => {
            promptResolve = resolve
            promptReject = reject
        })

        const active = {
            sessionId: params.sessionId,
            promise: promptPromise,
            resolve: promptResolve,
            reject: promptReject,
        }
        this.activePrompt = active

        try {
            const response = await conn.prompt({
                sessionId: params.sessionId,
                prompt: params.prompt,
            })
            active.resolve(response)
            return response
        } catch (e) {
            active.reject(e)
            throw e
        } finally {
            if (this.activePrompt?.promise === promptPromise) {
                this.activePrompt = null
            }
            this.cancellingSessionIds.delete(params.sessionId)
        }
    }

    async setSessionModel(params: Omit<SetSessionModelRequest, '_meta'>): Promise<SetSessionModelResponse> {
        const conn = this.requireConnection()
        return conn.unstable_setSessionModel({
            sessionId: params.sessionId,
            modelId: params.modelId,
        })
    }

    async setSessionConfigOption(params: { sessionId: string; configId: string; value: string }): Promise<SetSessionConfigOptionResponse> {
        const conn = this.requireConnection()
        return conn.setSessionConfigOption({
            sessionId: params.sessionId,
            configId: params.configId,
            value: params.value,
        })
    }

    async cancel(params: Omit<CancelNotification, '_meta'>): Promise<void> {
        if (!this.connection) return
        this.cancellingSessionIds.add(params.sessionId)
        try {
            await this.connection.cancel({
                sessionId: params.sessionId,
            })
        } catch (e) {
            console.error(`[acp-agent] session/cancel failed: ${e instanceof Error ? e.message : String(e)}`)
        }
    }

    async cancelActivePrompt(waitMs: number = CANCEL_WAIT_MS): Promise<PromptResponse | undefined> {
        const active = this.activePrompt
        if (!active) return undefined

        try {
            await this.cancel({ sessionId: active.sessionId })
        } catch (e) {
            console.error(`[acp-agent] cancelActivePrompt: cancel failed: ${e instanceof Error ? e.message : String(e)}`)
        }

        if (waitMs <= 0) return undefined

        let timer: ReturnType<typeof setTimeout> | undefined
        const timeoutPromise = new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), waitMs)
        })

        try {
            return await Promise.race([
                active.promise.then(
                    (response) => response,
                    () => undefined,
                ),
                timeoutPromise,
            ])
        } finally {
            if (timer) clearTimeout(timer)
            // Always clear the active prompt reference after the grace period,
            // even if the agent didn't respond. This prevents the next query
            // from racing with a stale activePrompt.
            if (this.activePrompt?.promise === active.promise) {
                this.activePrompt = null
            }
        }
    }

    dequeueSessionUpdate(sessionId: string): SessionNotification | undefined {
        const queue = this.sessionUpdates.get(sessionId)
        if (queue && queue.length > 0) {
            return queue.shift()
        }
        return undefined
    }

    drainSessionUpdates(sessionId: string): number {
        const queue = this.sessionUpdates.get(sessionId)
        if (!queue) return 0
        const count = queue.length
        if (count > 0) {
            // Record the current seq as boundary — any updates with seq <= boundary
            // that arrive after this point are historical and should be discarded
            const currentSeq = this.sessionUpdateSeqs.get(sessionId) ?? 0
            this.historicalSeqBoundaries.set(sessionId, currentSeq)
        }
        queue.length = 0
        return count
    }

    async waitForSessionUpdate(sessionId: string): Promise<SessionNotification> {
        const queue = this.sessionUpdates.get(sessionId)
        if (queue && queue.length > 0) {
            return queue.shift()!
        }

        return new Promise<SessionNotification>((resolve, reject) => {
            let waiters = this.sessionWaiters.get(sessionId)
            if (!waiters) {
                waiters = []
                this.sessionWaiters.set(sessionId, waiters)
            }
            waiters.push({ resolve, reject })
        })
    }

    resolvePermission(sessionId: string, response: RequestPermissionResponse): void {
        const resolver = this.permissionResolvers.get(sessionId)
        if (resolver) {
            this.permissionResolvers.delete(sessionId)
            resolver.resolve(response)
        }
    }

    async close(): Promise<void> {
        this._closing = true

        if (this.childProcess) {
            await this.terminateAgentProcess(this.childProcess)
        }

        this.rejectAllPendingWaiters(
            this.lastAgentExit
                ? new Error(`Agent disconnected (${this.lastAgentExit.reason}, exit=${this.lastAgentExit.exitCode ?? 'null'})`)
                : new Error('Connection closed')
        )

        this.sessionUpdateChain = Promise.resolve()
        this.activePrompt = null
        this.cancellingSessionIds.clear()
        this.permissionResolvers.clear()
        this.extensionHandler = null
        this.sessionUpdateSeqs.clear()
        this.historicalSeqBoundaries.clear()
        this.childProcess = null
        this.connection = null
        this._connected = false
        this.initResponse = null
        // Reset lifecycle flags so init() can be called again after close()
        this._closing = false
        this.lastAgentExit = null
    }

    dispose(): void {
        if (this.childProcess && !this.childProcess.killed) {
            try {
                if (process.platform === 'win32' && this.childProcess.pid) {
                    spawn('taskkill', ['/PID', this.childProcess.pid.toString(), '/T', '/F'], {
                        windowsHide: true,
                        stdio: 'ignore',
                    })
                } else {
                    this.childProcess.kill('SIGKILL')
                }
            } catch {}
        }

        this.rejectAllPendingWaiters(new Error('Client manager disposed'))

        this.childProcess = null
        this.connection = null
        this._connected = false
        this.initResponse = null
        this.activePrompt = null
        this.cancellingSessionIds.clear()
        this.sessionUpdates.clear()
        this.sessionWaiters.clear()
        this.sessionUpdateSeqs.clear()
        this.historicalSeqBoundaries.clear()
        this.permissionResolvers.clear()
        this.extensionHandler = null
    }

    private sessionUpdateChain = Promise.resolve()

    private async terminateAgentProcess(child: ChildProcess): Promise<void> {
        if (process.platform === 'win32') {
            try {
                if (child.pid) {
                    spawn('taskkill', ['/PID', child.pid.toString(), '/T', '/F'], {
                        windowsHide: true,
                        stdio: 'ignore',
                    })
                }
            } catch {}
            await this.waitForChildExit(child, STDIN_CLOSE_GRACE_MS + SIGTERM_GRACE_MS + SIGKILL_GRACE_MS)
            this.destroyChildHandles(child)
            return
        }

        // Stage 1: Close stdin (most graceful for stdio-based ACP agents)
        const stdin = child.stdin
        if (stdin && !stdin.destroyed) {
            try { stdin.end() } catch {}
        }
        let exited = await this.waitForChildExit(child, STDIN_CLOSE_GRACE_MS)

        // Stage 2: SIGTERM
        if (!exited && this.isChildRunning(child)) {
            try { child.kill('SIGTERM') } catch {}
            exited = await this.waitForChildExit(child, SIGTERM_GRACE_MS)
        }

        // Stage 3: SIGKILL
        if (!exited && this.isChildRunning(child)) {
            console.error(`[acp-agent] Agent did not exit after SIGTERM+${SIGTERM_GRACE_MS}ms, sending SIGKILL`)
            try { child.kill('SIGKILL') } catch {}
            exited = await this.waitForChildExit(child, SIGKILL_GRACE_MS)
        }

        this.destroyChildHandles(child, !exited)
    }

    private waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
        return new Promise((resolve) => {
            if (!this.isChildRunning(child)) {
                resolve(true)
                return
            }
            const timer = setTimeout(() => {
                child.removeListener('exit', onExit)
                resolve(false)
            }, timeoutMs)
            const onExit = () => {
                clearTimeout(timer)
                resolve(true)
            }
            child.once('exit', onExit)
        })
    }

    private isChildRunning(child: ChildProcess): boolean {
        try {
            if (child.pid) {
                process.kill(child.pid, 0)
                return true
            }
        } catch {}
        return false
    }

    private destroyChildHandles(child: ChildProcess, unref = false): void {
        try { child.stdin?.destroy() } catch {}
        try { child.stdout?.destroy() } catch {}
        try { child.stderr?.destroy() } catch {}
        if (unref) {
            try { child.unref() } catch {}
        }
    }

    private attachAgentLifecycleObservers(child: ChildProcess): void {
        child.once('exit', (exitCode, signal) => {
            this.recordAgentExit('process_exit', exitCode, signal)
        })
        child.once('close', (exitCode, signal) => {
            this.recordAgentExit('process_close', exitCode, signal)
        })
        child.stdout?.once('close', () => {
            this.recordAgentExit('pipe_close', child.exitCode ?? null, child.signalCode ?? null)
        })
    }

    private recordAgentExit(reason: string, exitCode: number | null, signal: NodeJS.Signals | string | null): void {
        if (this.lastAgentExit) return
        this.lastAgentExit = { reason, exitCode, signal }
        this._connected = false

        const unexpectedDuringPrompt = !this._closing && Boolean(this.activePrompt)
        if (unexpectedDuringPrompt) {
            console.error(`[acp-agent] Agent disconnected during prompt (${reason}, exit=${exitCode ?? 'null'}, signal=${signal ?? 'null'})`)
            this.rejectAllPendingWaiters(
                new Error(`Agent disconnected during prompt (${reason}, exit=${exitCode ?? 'null'}, signal=${signal ?? 'null'})`)
            )
        }
    }

    private rejectAllPendingWaiters(error: Error): void {
        for (const [, waiters] of this.sessionWaiters) {
            for (const waiter of waiters) {
                try { waiter.reject(error) } catch {}
            }
        }
        this.sessionWaiters.clear()
        for (const [, queue] of this.sessionUpdates) {
            queue.length = 0
        }
    }

    private createClientHandler(): Client {
        return {
            sessionUpdate: async (params: SessionNotification): Promise<void> => {
                const sessionId = params.sessionId

                // Assign sequence number to track update ordering
                const seq = (this.sessionUpdateSeqs.get(sessionId) ?? 0) + 1
                this.sessionUpdateSeqs.set(sessionId, seq)

                // Discard historical updates (arrived before drain boundary was set)
                const boundary = this.historicalSeqBoundaries.get(sessionId) ?? -1
                if (seq <= boundary) {
                    const updateType = (params.update as any)?.sessionUpdate ?? '?'
                    console.error(`[acp] Discarded historical update: seq=${seq} <= boundary=${boundary} updateType=${updateType}`)
                    return
                }

                const updateType = (params.update as any)?.sessionUpdate ?? '?'
                const updateId = (params as any)?.id ?? (params.update as any)?.toolCallId ?? ''
                const waiters = this.sessionWaiters.get(sessionId)
                if (waiters && waiters.length > 0) {
                    const waiter = waiters.shift()!
                    console.error(`[acp] Session update → waiter: sessionId=${sessionId?.slice(0,8)} updateType=${updateType} seq=${seq} waitersRemaining=${waiters.length}`)
                    waiter.resolve(params)
                } else {
                    let queue = this.sessionUpdates.get(sessionId)
                    if (!queue) {
                        queue = []
                        this.sessionUpdates.set(sessionId, queue)
                    }
                    queue.push(params)
                    console.error(`[acp] Session update → queue: sessionId=${sessionId?.slice(0,8)} updateType=${updateType} seq=${seq} queueLen=${queue.length}`)
                }
            },

            requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
                const sessionId = params.sessionId
                const toolName = params.toolCall.title ?? 'unknown'

                // Auto-deny during cancel
                if (this.cancellingSessionIds.has(sessionId)) {
                    console.error(`[acp] Auto-denying permission for ${toolName} (session being cancelled)`)
                    return { outcome: { outcome: 'cancelled' } }
                }

                console.error(`[acp] Permission request: tool=${toolName}, options=${params.options.map(o => o.kind).join(', ')}`)

                if (this.permissionHandler) {
                    try {
                        const input = params.toolCall.rawInput
                        const result: AgentPermissionResult = await this.permissionHandler.handleToolCall(
                            toolName,
                            input,
                            { signal: new AbortController().signal },
                        )

                        if (result.behavior === 'allow') {
                            const preferAlways = result.permanent === true
                            let allowOption = params.options.find(o =>
                                preferAlways ? o.kind === 'allow_always' : o.kind === 'allow_once'
                            )
                            if (!allowOption) {
                                allowOption = params.options.find(o =>
                                    o.kind === 'allow_once' || o.kind === 'allow_always'
                                )
                            }
                            if (allowOption) {
                                console.error(`[acp] Allowing ${toolName} with ${allowOption.kind}`)
                                return {
                                    outcome: {
                                        outcome: 'selected',
                                        optionId: allowOption.optionId,
                                    },
                                }
                            }
                        }

                        const rejectOption = params.options.find(o =>
                            o.kind === 'reject_once' || o.kind === 'reject_always'
                        )
                        if (rejectOption) {
                            return {
                                outcome: {
                                    outcome: 'selected',
                                    optionId: rejectOption.optionId,
                                },
                            }
                        }

                        return { outcome: { outcome: 'cancelled' } }
                    } catch {
                        return { outcome: { outcome: 'cancelled' } }
                    }
                }

                const allowOption = params.options.find(o =>
                    o.kind === 'allow_once' || o.kind === 'allow_always'
                )
                if (allowOption) {
                    return {
                        outcome: {
                            outcome: 'selected',
                            optionId: allowOption.optionId,
                        },
                    }
                }

                return { outcome: { outcome: 'cancelled' } }
            },

            readTextFile: async (_params: ReadTextFileRequest): Promise<ReadTextFileResponse> => {
                throw new Error('readTextFile not supported')
            },

            writeTextFile: async (_params: WriteTextFileRequest): Promise<WriteTextFileResponse> => {
                throw new Error('writeTextFile not supported')
            },

            extMethod: async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
                if (!this.extensionHandler?.extMethod) {
                    console.error(`[acp] Unhandled extension method: ${method}`)
                    return {}
                }
                return this.extensionHandler.extMethod(method, params)
            },

            extNotification: async (method: string, params: Record<string, unknown>): Promise<void> => {
                if (!this.extensionHandler?.extNotification) {
                    console.error(`[acp] Unhandled extension notification: ${method}`)
                    return
                }
                await this.extensionHandler.extNotification(method, params)
            },
        }
    }

    private requireConnection(): ClientSideConnection {
        if (!this.connection || !this._connected) {
            throw new Error('ACP client not connected. Call init() first.')
        }
        return this.connection
    }
}
