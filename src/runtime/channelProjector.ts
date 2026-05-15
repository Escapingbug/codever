import type { ChannelMessage } from '@/bridge/channelPort'
import type { ConversationEvent } from './semantic'
import { escapeHtml } from '@/utils/formatting'
import { formatToolBubble } from '@/channel/telegram/toolBubble'

export interface ProjectedMessage {
    message: ChannelMessage
    toolUseId?: string
    isToolEvent: boolean
    isTerminal: boolean
    semanticEvent?: ConversationEvent
}

export interface ChannelProjectorOptions {
    verboseLevel?: 0 | 1 | 2
}

interface ProjectedToolState {
    toolName: string
    phase: 'started' | 'updated' | 'completed' | 'failed'
    input?: unknown
    output?: unknown
    isError?: boolean
    displayTitle?: string
    category?: 'read' | 'edit' | 'write' | 'execute' | 'search' | 'agent' | 'unknown'
    content?: Array<{ type: 'content'; contentType: string; text?: string } | { type: 'diff'; path?: string; oldText?: string; newText?: string } | { type: 'terminal'; terminalId?: string }>
}

export class ChannelProjector {
    private textBuffer = ''
    private toolStates = new Map<string, ProjectedToolState>()
    private normalToolGroupKey: string | null = null
    private normalToolGroupIndex = 0
    private normalToolGroupToolIds: string[] = []

    project(event: ConversationEvent, options: ChannelProjectorOptions = {}): ProjectedMessage[] {
        switch (event.kind) {
            case 'assistant_text_delta':
                this.textBuffer += event.text
                return []

            case 'tool':
                return this.projectToolByVerbosity(event, options)

            case 'decision_request':
                return [
                    ...this.flushText(),
                    {
                        message: {
                            text: `<b>${escapeHtml(event.title)}</b>${event.body ? `\n\n${escapeHtml(event.body)}` : ''}`,
                            format: 'html',
                            replyMarkup: {
                                inline_keyboard: [
                                    event.options.map(option => ({
                                        text: option.label,
                                        callback_data: `decision:${event.decisionId}:${option.id}`,
                                    })),
                                ],
                            },
                        },
                        isToolEvent: false,
                        isTerminal: false,
                        semanticEvent: event,
                    },
                ]

            case 'mode_change':
                return [
                    ...this.flushText(),
                    {
                        message: { text: `Mode: <code>${escapeHtml(event.mode)}</code>`, format: 'html' },
                        isToolEvent: false,
                        isTerminal: false,
                        semanticEvent: event,
                    },
                ]

            case 'command_result':
                // Suppress messages for available_commands_update and config_option_update
                const commandLower = event.command.toLowerCase()
                if (commandLower.includes('available_commands') || commandLower.includes('commands_update') || commandLower.includes('config_option')) {
                    return []
                }
                return [
                    ...this.flushText(),
                    {
                        message: {
                            text: formatCommandResult(event.command, event.output),
                            format: 'html',
                        },
                        isToolEvent: false,
                        isTerminal: false,
                        semanticEvent: event,
                    },
                ]

            case 'turn_finished':
                return this.projectTurnFinished(event)

            case 'turn_started':
            case 'provider_raw':
                return []
        }
    }

    flush(semanticEvent?: ConversationEvent): ProjectedMessage[] {
        return this.flushText(semanticEvent)
    }

    statusMessage(text: string): ProjectedMessage {
        return {
            message: { text, format: 'html' },
            isToolEvent: false,
            isTerminal: false,
        }
    }

    reset(): void {
        this.textBuffer = ''
        this.toolStates.clear()
        this.normalToolGroupKey = null
        this.normalToolGroupIndex = 0
        this.normalToolGroupToolIds = []
    }

    private flushText(semanticEvent?: ConversationEvent): ProjectedMessage[] {
        const text = this.textBuffer
        this.textBuffer = ''
        if (!text.trim()) return []
        this.closeNormalToolGroup()
        return [{
            message: { text, format: 'markdown' },
            isToolEvent: false,
            isTerminal: semanticEvent?.kind === 'turn_finished',
            semanticEvent,
        }]
    }

    private projectToolByVerbosity(event: Extract<ConversationEvent, { kind: 'tool' }>, options: ChannelProjectorOptions): ProjectedMessage[] {
        const verboseLevel = options.verboseLevel ?? 1
        const messages = this.flushText()
        if (verboseLevel === 0) {
            const state = this.mergeToolState(event)
            if (isExitPlanModeTool(state) && hasExitPlanContent(state)) {
                messages.push({
                    message: {
                        text: this.formatToolState(state),
                        format: 'html',
                    },
                    toolUseId: event.toolCallId,
                    isToolEvent: true,
                    isTerminal: event.phase === 'completed' || event.phase === 'failed',
                    semanticEvent: withMergedToolContent(event, state),
                })
            }
            return messages
        }

        if (verboseLevel === 1) {
            messages.push(this.projectNormalToolGroup(event))
            return messages
        }

        messages.push(this.projectVerboseTool(event))
        return messages
    }

    private projectNormalToolGroup(event: Extract<ConversationEvent, { kind: 'tool' }>): ProjectedMessage {
        const groupKey = this.ensureNormalToolGroup()
        const state = this.mergeToolState(event)
        if (!this.normalToolGroupToolIds.includes(event.toolCallId)) {
            this.normalToolGroupToolIds.push(event.toolCallId)
        }

        const text = this.normalToolGroupToolIds
            .map(toolCallId => this.toolStates.get(toolCallId))
            .filter((state): state is ProjectedToolState => state !== undefined)
            .map(state => this.formatToolState(state))
            .join('\n\n')

        return {
            message: { text, format: 'html' },
            toolUseId: groupKey,
            isToolEvent: true,
            isTerminal: event.phase === 'completed' || event.phase === 'failed',
            semanticEvent: withMergedToolContent(event, state),
        }
    }

    private ensureNormalToolGroup(): string {
        if (!this.normalToolGroupKey) {
            this.normalToolGroupKey = `normal-tool-group:${++this.normalToolGroupIndex}`
            this.normalToolGroupToolIds = []
        }
        return this.normalToolGroupKey
    }

    private closeNormalToolGroup(): void {
        this.normalToolGroupKey = null
        this.normalToolGroupToolIds = []
    }

    private projectTurnFinished(event: Extract<ConversationEvent, { kind: 'turn_finished' }>): ProjectedMessage[] {
        const messages = this.flushText(event)
        if (event.status === 'success') return messages

        messages.push({
            message: {
                text: this.formatTurnFinishedStatus(event),
                format: 'html',
            },
            isToolEvent: false,
            isTerminal: true,
            semanticEvent: event,
        })
        return messages
    }

    private formatTurnFinishedStatus(event: Extract<ConversationEvent, { kind: 'turn_finished' }>): string {
        const summary = event.summary?.trim()
        const detail = summary ? `\n<pre>${escapeHtml(summary)}</pre>` : `\n<code>${escapeHtml(event.status)}</code>`

        switch (event.status) {
            case 'cancelled':
                return `⏹️ <b>Task interrupted</b>${detail}`
            case 'max_turns':
                return `⚠️ <b>Task stopped: max turns reached</b>${detail}`
            case 'error':
            default:
                return `❌ <b>Agent error</b>${detail}`
        }
    }

    private projectVerboseTool(event: Extract<ConversationEvent, { kind: 'tool' }>): ProjectedMessage {
        const state = this.mergeToolState(event)
        return {
            message: {
                text: this.formatToolState(state),
                format: 'html',
            },
            toolUseId: event.toolCallId,
            isToolEvent: true,
            isTerminal: event.phase === 'completed' || event.phase === 'failed',
            semanticEvent: withMergedToolContent(event, state),
        }
    }

    private mergeToolState(event: Extract<ConversationEvent, { kind: 'tool' }>): ProjectedToolState {
        const existing = this.toolStates.get(event.toolCallId)

        // Patch merge: preserve canonical toolName from initial event
        // Only use event.toolName if it's a known canonical name, otherwise keep existing
        let toolName: string
        if (existing?.toolName && !isGenericToolName(existing.toolName)) {
            toolName = existing.toolName
        } else if (event.toolName && !isGenericToolName(event.toolName)) {
            toolName = event.toolName
        } else {
            toolName = existing?.toolName || event.toolName || 'tool_call'
        }

        // Merge input: prefer current event's input, fall back to existing
        const input = event.input !== undefined ? event.input : existing?.input

        // Merge output/error so terminal patches can enrich an existing started event.
        const output = event.output !== undefined ? event.output : existing?.output
        const isError = event.isError ?? existing?.isError

        // Merge displayTitle: prefer the latest descriptive title/path.
        const displayTitle = event.displayTitle ?? existing?.displayTitle

        // Merge category
        const category = event.category ?? existing?.category

        // Merge content blocks
        const content = event.content ?? existing?.content

        // Save merged state
        const state = { toolName, phase: event.phase, input, output, isError, displayTitle, category, content }
        this.toolStates.set(event.toolCallId, state)
        return state
    }

    private formatToolState(state: ProjectedToolState): string {
        const status = state.phase === 'failed'
            ? 'interrupted'
            : state.phase === 'completed'
                ? 'completed'
                : state.phase === 'updated'
                    ? 'running'
                    : 'pending'

        // Build effective tool name for display
        // Use toolName for canonical tools, displayTitle for path-like titles
        // If toolName is generic (tool_call/tool), use displayTitle if available
        let effectiveToolName = state.toolName
        if (isGenericToolName(state.toolName) && state.displayTitle) {
            effectiveToolName = state.displayTitle
        }

        return formatToolBubble({
            toolName: effectiveToolName,
            input: state.input,
            status,
            output: allowedToolOutput(state),
            isError: state.isError,
            displayTitle: state.displayTitle,
            category: state.category,
            content: state.content,
        })
    }
}

function isGenericToolName(toolName: string | undefined): boolean {
    return !toolName || toolName === 'tool' || toolName === 'tool_call'
}

function withMergedToolContent(
    event: Extract<ConversationEvent, { kind: 'tool' }>,
    state: ProjectedToolState,
): Extract<ConversationEvent, { kind: 'tool' }> {
    return state.content && state.content !== event.content ? { ...event, content: state.content } : event
}

function allowedToolOutput(state: ProjectedToolState): string | undefined {
    if (isExitPlanModeTool(state) && typeof state.output === 'string') return state.output
    if (state.category !== 'search' || typeof state.output !== 'string') return undefined
    const output = state.output.trim()
    return /^\d+ (matches|match|files|file)( \(truncated\))?$/.test(output) ? output : undefined
}

function isExitPlanModeTool(state: ProjectedToolState): boolean {
    return state.toolName === 'ExitPlanMode' || state.toolName === 'exit_plan_mode'
}

function hasExitPlanContent(state: ProjectedToolState): boolean {
    if (!isExitPlanModeTool(state)) return false
    if (typeof state.output === 'string' && state.output.trim()) return true
    if (typeof state.displayTitle === 'string' && state.displayTitle.trim()) return true
    const input = state.input as Record<string, unknown> | undefined
    return typeof input?.plan === 'string' && input.plan.trim().length > 0
        || typeof input?.content === 'string' && input.content.trim().length > 0
}

function formatUnknown(value: unknown): string {
    if (typeof value === 'string') return value
    try {
        return JSON.stringify(value, null, 2)
    } catch {
        return String(value)
    }
}

function formatCommandResult(command: string, output: unknown): string {
    const commandLower = command.toLowerCase()

    // available_commands_update: show as a list of commands
    if (commandLower.includes('available_commands') || commandLower.includes('commands_update')) {
        const commands = Array.isArray(output) ? output : []
        if (commands.length === 0) {
            return '💡 Provider commands updated (0 available). Use /help to see them.'
        }
        const lines = commands.map((cmd: any) => {
            const name = cmd.name || cmd.command || 'unknown'
            const desc = cmd.description || ''
            const hint = cmd.inputHint || cmd.input?.hint || ''
            const prefix = String(name).startsWith('/') ? '' : '/'
            return `• <code>${prefix}${escapeHtml(String(name))}</code>${desc ? ` - ${escapeHtml(String(desc))}` : ''}${hint ? ` <i>(${escapeHtml(String(hint))})</i>` : ''}`
        })
        return `💡 Provider commands updated (${commands.length} available). Use /help to see them.\n${lines.join('\n')}`
    }

    // plan: show plan content
    if (commandLower === 'plan') {
        const planText = extractPlanContent(output)
        if (planText) {
            return `<b>📋 Plan</b>\n${escapeHtml(planText)}`
        }
        return '📋 <b>Exited plan mode</b>'
    }

    // usage_update: show token/cost info
    if (commandLower.includes('usage')) {
        const usage = asRecord(output)
        if (usage) {
            const parts: string[] = ['<b>📊 Usage</b>']
            const inputTokens = usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens
            const outputTokens = usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens
            const totalTokens = usage.totalTokens ?? usage.total_tokens
            const cost = usage.costUSD ?? usage.costUsd ?? usage.cost_usd ?? usage.totalCost ?? usage.total_cost
            if (inputTokens !== undefined || outputTokens !== undefined) {
                parts.push(`Tokens: ${inputTokens ?? 0} in / ${outputTokens ?? 0} out`)
            }
            if (totalTokens !== undefined) {
                parts.push(`Total: ${totalTokens}`)
            }
            if (cost !== undefined) {
                parts.push(`Cost: $${cost}`)
            }
            if (parts.length === 1) parts.push('Updated')
            return parts.join('\n')
        }
    }

    // session_info_update: show session info
    if (commandLower.includes('session_info')) {
        const info = asRecord(output)
        if (info) {
            const parts: string[] = ['<b>ℹ️ Session Info</b>']
            if (info.model) parts.push(`Model: <code>${escapeHtml(String(info.model))}</code>`)
            if (info.cwd) parts.push(`CWD: <code>${escapeHtml(String(info.cwd))}</code>`)
            if (info.sessionId) parts.push(`Session: <code>${escapeHtml(String(info.sessionId))}</code>`)
            return parts.join('\n')
        }
    }

    // config_option_update: show config changes
    if (commandLower.includes('config_option')) {
        // Try to extract configOptions array from output
        let configArray: Array<{ name?: string; value?: unknown; description?: string }> = []

        if (Array.isArray(output)) {
            configArray = output as Array<{ name?: string; value?: unknown; description?: string }>
        } else {
            const record = asRecord(output)
            if (record) {
                // Try common field names for config options array
                const options = record.configOptions ?? record.options ?? record.config
                if (Array.isArray(options)) {
                    configArray = options as Array<{ name?: string; value?: unknown; description?: string }>
                }
            }
        }

        if (configArray.length > 0) {
            const parts: string[] = ['<b>⚙️ Config Update</b>']
            for (const opt of configArray) {
                const name = opt.name ?? 'unknown'
                const value = opt.value !== undefined ? String(opt.value) : ''
                const desc = opt.description ? ` - ${opt.description}` : ''
                parts.push(`• ${escapeHtml(name)}: <code>${escapeHtml(value)}</code>${desc ? ` ${escapeHtml(desc)}` : ''}`)
            }
            return parts.join('\n')
        }

        // Fallback: don't dump JSON, just show a short message
        return '⚙️ <b>Config updated</b>'
    }

    // Default: fallback to JSON dump with proper escaping
    return `<b>${escapeHtml(command)}</b>\n<pre>${escapeHtml(formatUnknown(output))}</pre>`
}

function extractPlanContent(output: unknown): string | null {
    if (typeof output === 'string') return output
    const record = asRecord(output)
    if (!record) return null

    // Try common field names for plan content
    const content = record.content || record.text || record.description || record.plan
    if (typeof content === 'string') return content

    // If output has options (decision request), don't try to extract plan
    if (record.options || record.choices) return null

    return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? value as Record<string, unknown> : null
}
