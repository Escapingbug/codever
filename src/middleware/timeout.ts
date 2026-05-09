import type { Middleware, MiddlewareOutput, MiddlewareContext, MiddlewareResult } from './types'

export interface TimeoutMiddlewareConfig {
    timeoutSeconds?: number
    heartbeatIntervalMs?: number
    toolRunningNotifyMs?: number
    onTimeout: (elapsed: number) => void
    onTyping?: () => void
    onToolRunning?: (toolName: string, elapsedSec: number) => void
    onDebug?: (message: string) => void
}

interface TimeoutState {
    lastEventTime: number
    queryStartTime: number
    lastToolName: string | null
    lastToolUseTime: number | null
    toolRunningNotified: boolean
    timeoutNotified: boolean
    heartbeatTimer: ReturnType<typeof setInterval> | null
}

const DEFAULT_TIMEOUT_SECONDS = 180
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000
const DEFAULT_TOOL_RUNNING_NOTIFY_MS = 30_000

export class TimeoutMiddleware implements Middleware {
    readonly name = 'timeout'
    private state: TimeoutState | null = null

    constructor(private config: TimeoutMiddlewareConfig) {}

    private debug(message: string): void {
        if (this.config.onDebug) {
            this.config.onDebug(message)
        } else {
            console.error(message)
        }
    }

    start(): void {
        this.state = {
            lastEventTime: Date.now(),
            queryStartTime: Date.now(),
            lastToolName: null,
            lastToolUseTime: null,
            toolRunningNotified: false,
            timeoutNotified: false,
            heartbeatTimer: null,
        }
        this.startHeartbeat()
        this.debug(`[TimeoutMiddleware] Heartbeat started (interval=${this.config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS}ms, timeout=${this.config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS}s)`)
    }

    stop(): void {
        if (this.state?.heartbeatTimer) {
            clearInterval(this.state.heartbeatTimer)
            this.state.heartbeatTimer = null
        }
        const lastTool = this.state?.lastToolName
        const elapsed = this.state?.lastEventTime ? Math.round((Date.now() - this.state.lastEventTime) / 1000) : null
        this.debug(`[TimeoutMiddleware] Heartbeat stopped (lastTool=${lastTool ?? 'none'}, sinceLastEvent=${elapsed ?? '?'}s)`)
        this.state = null
    }

    process(event: MiddlewareOutput, context: MiddlewareContext): MiddlewareResult {
        if (!this.state) return { formatted: null, event }

        this.state.lastEventTime = Date.now()

        if (event.kind === 'tool_use') {
            this.state.lastToolName = event.toolName
            this.state.lastToolUseTime = Date.now()
            this.state.toolRunningNotified = false
            if (this.state.timeoutNotified) {
                this.state.timeoutNotified = false
            }
        }

        if (event.kind === 'tool_result') {
            this.state.lastToolName = null
            this.state.lastToolUseTime = null
            this.state.toolRunningNotified = false
        }

        if (event.kind === 'text' && this.state.timeoutNotified) {
            this.state.timeoutNotified = false
        }

        return { formatted: null, event }
    }

    /** Expose lastToolName for timeout handlers to show context */
    get lastToolName(): string | null {
        return this.state?.lastToolName ?? null
    }

    /** Returns progress info for /progress command, or null if not running */
    getProgress(): { elapsedSeconds: number; lastToolName: string | null } | null {
        if (!this.state) return null
        return {
            elapsedSeconds: Math.round((Date.now() - this.state.queryStartTime) / 1000),
            lastToolName: this.state.lastToolName,
        }
    }

    /** Update timeoutSeconds at runtime (e.g. when user changes /timeout) */
    updateTimeoutSeconds(seconds: number): void {
        this.config.timeoutSeconds = seconds
        // Reset timeoutNotified so the new threshold takes effect
        if (this.state) {
            this.state.timeoutNotified = false
        }
        this.debug(`[TimeoutMiddleware] Timeout updated to ${seconds}s`)
    }

    setTimeoutExtended(extended: boolean): void {
        if (!this.state) return
        if (extended) {
            this.state.timeoutNotified = false
        }
    }

    private getQueryElapsedSec(): number {
        if (!this.state) return 0
        return Math.round((Date.now() - this.state.queryStartTime) / 1000)
    }

    private startHeartbeat(): void {
        if (!this.state) return
        this.stopHeartbeat()

        const interval = this.config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
        this.state.heartbeatTimer = setInterval(() => {
            this.tick()
        }, interval)
    }

    private stopHeartbeat(): void {
        if (this.state?.heartbeatTimer) {
            clearInterval(this.state.heartbeatTimer)
            this.state.heartbeatTimer = null
        }
    }

    private tick(): void {
        if (!this.state) return

        this.config.onTyping?.()

        // Total query elapsed time (from query start)
        const queryElapsed = Date.now() - this.state.queryStartTime
        const queryElapsedSec = Math.round(queryElapsed / 1000)

        // Time since last event (for agent liveness detection)
        const sinceLastEvent = Date.now() - this.state.lastEventTime
        const sinceLastEventSec = Math.round(sinceLastEvent / 1000)
        const timeoutMs = (this.config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000

        if (this.state.lastToolName && this.state.lastToolUseTime && !this.state.toolRunningNotified) {
            const toolElapsed = Date.now() - this.state.lastToolUseTime
            const toolNotifyMs = this.config.toolRunningNotifyMs ?? DEFAULT_TOOL_RUNNING_NOTIFY_MS
            if (toolElapsed >= toolNotifyMs) {
                this.state.toolRunningNotified = true
                const toolElapsedSec = Math.round(toolElapsed / 1000)
                this.config.onToolRunning?.(this.state.lastToolName, toolElapsedSec)
            }
        }

        if (sinceLastEvent >= timeoutMs && !this.state.timeoutNotified) {
            this.state.timeoutNotified = true
            this.config.onTimeout(sinceLastEvent)
        }
    }
}

export function createTimeoutMiddleware(config: TimeoutMiddlewareConfig): TimeoutMiddleware {
    return new TimeoutMiddleware(config)
}
