import type { ChannelMessage } from '@/bridge/channelPort'
import type { OutputMessage } from '@/middleware/pipeline'
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

    fromPipelineOutput(output: OutputMessage, semanticEvent?: ConversationEvent): ProjectedMessage {
        return {
            message: output.isMarkdown
                ? { text: output.text, format: 'markdown' }
                : { text: output.text, format: 'html', replyMarkup: output.replyMarkup },
            toolUseId: output.toolUseId,
            isToolEvent: output.isToolEvent,
            isTerminal: output.isDone,
            semanticEvent,
        }
    }

    project(event: ConversationEvent, options: ChannelProjectorOptions = {}): ProjectedMessage[] {
        switch (event.kind) {
            case 'assistant_text_delta':
                this.textBuffer += event.text
                return []

            case 'tool':
                return [
                    ...this.flushText(),
                    this.projectTool(event, options),
                ]

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
    }

    private flushText(semanticEvent?: ConversationEvent): ProjectedMessage[] {
        const text = this.textBuffer
        this.textBuffer = ''
        if (!text.trim()) return []
        return [{
            message: { text, format: 'markdown' },
            isToolEvent: false,
            isTerminal: semanticEvent?.kind === 'turn_finished',
            semanticEvent,
        }]
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

    private projectTool(event: Extract<ConversationEvent, { kind: 'tool' }>, options: ChannelProjectorOptions): ProjectedMessage {
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
        this.toolStates.set(event.toolCallId, { toolName, input, output, isError, displayTitle, category, content })

        const status = event.phase === 'failed'
            ? 'interrupted'
            : event.phase === 'completed'
                ? 'completed'
                : event.phase === 'updated'
                    ? 'running'
                    : 'pending'

        const includeOutput = shouldIncludeToolOutput(event, options.verboseLevel ?? 1)

        // Build effective tool name for display
        // Use toolName for canonical tools, displayTitle for path-like titles
        // If toolName is generic (tool_call/tool), use displayTitle if available
        let effectiveToolName = toolName
        if (isGenericToolName(toolName) && displayTitle) {
            effectiveToolName = displayTitle
        }

        return {
            message: {
                text: formatToolBubble({
                    toolName: effectiveToolName,
                    input,
                    status,
                    output: includeOutput
                        ? typeof output === 'string' ? output : output === undefined ? undefined : formatUnknown(output)
                        : undefined,
                    isError,
                    displayTitle,
                    category,
                    content,
                }),
                format: 'html',
            },
            toolUseId: event.toolCallId,
            isToolEvent: true,
            isTerminal: event.phase === 'completed' || event.phase === 'failed',
            semanticEvent: event,
        }
    }
}

function isGenericToolName(toolName: string | undefined): boolean {
    return !toolName || toolName === 'tool' || toolName === 'tool_call'
}

function shouldIncludeToolOutput(event: Extract<ConversationEvent, { kind: 'tool' }>, verboseLevel: 0 | 1 | 2): boolean {
    if (event.phase !== 'completed' && event.phase !== 'failed') return false
    if (event.isError) return true
    return verboseLevel >= 2
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
