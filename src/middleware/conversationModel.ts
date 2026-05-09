import type { AgentEvent, AgentToolUseEvent, AgentToolResultEvent } from '@/providers/types'

export type ToolUseStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface ToolUseState {
    toolName: string
    status: ToolUseStatus
    input: unknown
    toolKind?: string
    locations?: Array<{ path: string; line?: number }>
}

export interface ToolResultState {
    toolName: string
    output: string
    isError: boolean
    structuredOutput?: unknown
}

export interface TrimLimits {
    toolIO?: number
    agentText?: number
    thinking?: number
}

const DEFAULT_TRIM_LIMITS: Required<TrimLimits> = {
    toolIO: 4000,
    agentText: 8000,
    thinking: 4000,
}

function truncateWithEllipsis(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str
    return str.slice(0, maxLen) + '…'
}

export class ConversationModel {
    private toolUseMap = new Map<string, ToolUseState>()
    private toolResultMap = new Map<string, ToolResultState>()
    private renderedResultIds = new Set<string>()

    applyEvent(event: AgentEvent): void {
        if (event.kind === 'tool_use') {
            this.applyToolUse(event)
        } else if (event.kind === 'tool_result') {
            this.applyToolResult(event)
        }
    }

    getToolName(toolUseId: string): string | undefined {
        const result = this.toolResultMap.get(toolUseId)
        if (result?.toolName) return result.toolName

        const use = this.toolUseMap.get(toolUseId)
        if (use?.toolName) return use.toolName

        return undefined
    }

    getToolState(toolUseId: string): ToolUseState | undefined {
        return this.toolUseMap.get(toolUseId)
    }

    getToolResultState(toolUseId: string): ToolResultState | undefined {
        return this.toolResultMap.get(toolUseId)
    }

    getToolKind(toolUseId: string): string | undefined {
        return this.toolUseMap.get(toolUseId)?.toolKind
    }

    markResultRendered(toolUseId: string): void {
        if (toolUseId) this.renderedResultIds.add(toolUseId)
    }

    isResultRendered(toolUseId: string): boolean {
        return toolUseId ? this.renderedResultIds.has(toolUseId) : false
    }

    get toolNameMap(): Map<string, string> {
        const map = new Map<string, string>()
        for (const [id, state] of this.toolUseMap) {
            map.set(id, state.toolName)
        }
        return map
    }

    reset(): void {
        this.toolUseMap.clear()
        this.toolResultMap.clear()
        this.renderedResultIds.clear()
    }

    trimForRuntime(limits?: TrimLimits): void {
        const l = { ...DEFAULT_TRIM_LIMITS, ...limits }
        const maxIO = l.toolIO

        for (const [, state] of this.toolUseMap) {
            if (state.input != null) {
                const str = typeof state.input === 'string' ? state.input : JSON.stringify(state.input)
                if (str.length > maxIO) {
                    state.input = truncateWithEllipsis(str, maxIO)
                }
            }
        }

        for (const [, state] of this.toolResultMap) {
            if (state.output.length > maxIO) {
                state.output = truncateWithEllipsis(state.output, maxIO)
            }
        }
    }

    private applyToolUse(event: AgentToolUseEvent): void {
        if (!event.toolUseId) return

        const existing = this.toolUseMap.get(event.toolUseId)
        if (existing) {
            if (event.status) {
                const nextStatus = this.resolveStatus(existing.status, event.status)
                existing.status = nextStatus
            }
            if (event.toolKind) existing.toolKind = event.toolKind
            if (event.locations) existing.locations = event.locations
            if (event.input !== undefined && event.input !== null) {
                existing.input = event.input
            }
        } else {
            const status: ToolUseStatus = event.status ?? 'pending'
            this.toolUseMap.set(event.toolUseId, {
                toolName: event.toolName,
                status,
                input: event.input,
                toolKind: event.toolKind,
                locations: event.locations,
            })
        }
    }

    private applyToolResult(event: AgentToolResultEvent): void {
        if (!event.toolUseId) return

        const toolName = event.toolName ?? this.getToolName(event.toolUseId)

        this.toolResultMap.set(event.toolUseId, {
            toolName: toolName ?? '',
            output: event.output,
            isError: event.isError,
            structuredOutput: event.structuredOutput,
        })

        const useState = this.toolUseMap.get(event.toolUseId)
        if (useState) {
            useState.status = event.isError ? 'failed' : 'completed'
        }
    }

    private resolveStatus(current: ToolUseStatus, incoming: 'pending' | 'running'): ToolUseStatus {
        if (current === 'completed' || current === 'failed') return current
        return incoming
    }
}
