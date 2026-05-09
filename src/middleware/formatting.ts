import type { Middleware, MiddlewareOutput, MiddlewareContext, MiddlewareResult } from './types'
import type { AgentEvent, AgentToolUseEvent, AgentToolResultEvent } from '@/providers/types'
import { formatAgentEventForTelegram, type FormatOptions } from '@/channel/telegram/agentFormatter'
import { formatToolBubble } from '@/channel/telegram/toolBubble'
import { ConversationModel } from '@/middleware/conversationModel'

export class FormattingMiddleware implements Middleware {
    readonly name = 'formatting'
    private conversationModel = new ConversationModel()

    reset(): void {
        this.conversationModel.reset()
    }

    get toolNameMap(): Map<string, string> {
        return this.conversationModel.toolNameMap
    }

    getToolKind(toolUseId: string): string | undefined {
        return this.conversationModel.getToolKind(toolUseId)
    }

    getToolState(toolUseId: string) {
        return this.conversationModel.getToolState(toolUseId)
    }

    getToolResultState(toolUseId: string) {
        return this.conversationModel.getToolResultState(toolUseId)
    }

    isResultRendered(toolUseId: string): boolean {
        return this.conversationModel.isResultRendered(toolUseId)
    }

    markResultRendered(toolUseId: string): void {
        this.conversationModel.markResultRendered(toolUseId)
    }

    process(event: MiddlewareOutput, context: MiddlewareContext): MiddlewareResult {
        this.conversationModel.applyEvent(event)

        // For tool events, use formatToolBubble for progressive display
        let formatted: string | null = null
        if (event.kind === 'tool_use' || event.kind === 'tool_result') {
            formatted = this.formatToolEvent(event as AgentEvent)
        }

        // Fall back to standard formatter for non-tool events or if tool bubble returns null
        if (formatted === null) {
            const formatOpts: FormatOptions = {
                verboseLevel: context.verboseLevel,
                conversationModel: this.conversationModel,
            }
            formatted = formatAgentEventForTelegram(event, formatOpts)
        }

        return { formatted, event }
    }

    private formatToolEvent(event: AgentEvent): string | null {
        if (event.kind === 'tool_use') {
            const state = this.conversationModel.getToolState(event.toolUseId ?? '')
            if (!state) return null
            return formatToolBubble({
                toolName: state.toolName,
                input: state.input,
                status: state.status === 'failed' ? 'interrupted' : state.status,
            })
        }
        if (event.kind === 'tool_result') {
            const toolUseId = event.toolUseId ?? ''

            // Idempotent guard: skip if this toolUseId's result was already rendered
            if (toolUseId && this.conversationModel.isResultRendered(toolUseId)) {
                return null
            }

            const state = this.conversationModel.getToolState(toolUseId)
            const resultState = this.conversationModel.getToolResultState(toolUseId)
            if (!state) return null

            // Mark result as rendered to prevent duplicate rendering
            if (toolUseId) this.conversationModel.markResultRendered(toolUseId)

            // For suppressed tools, just show the completed header without result
            const toolName = state.toolName
            const normalizedName = toolName.toLowerCase()
            const suppressResult =
                normalizedName === 'todowrite' ||
                normalizedName === 'write' ||
                normalizedName === 'edit' ||
                normalizedName === 'read' ||
                normalizedName === 'websearch' ||
                normalizedName === 'webfetch' ||
                normalizedName === 'exitplanmode' ||
                normalizedName === 'task' ||
                normalizedName === 'skill'

            if (suppressResult) {
                return formatToolBubble({
                    toolName: state.toolName,
                    input: state.input,
                    status: event.isError ? 'interrupted' : 'completed',
                })
            }

            return formatToolBubble({
                toolName: state.toolName,
                input: state.input,
                status: event.isError ? 'interrupted' : 'completed',
                output: resultState?.output ?? event.output,
                isError: event.isError,
            })
        }
        return null
    }
}

export function createFormattingMiddleware(): FormattingMiddleware {
    return new FormattingMiddleware()
}
