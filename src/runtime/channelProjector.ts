import type { ChannelMessage } from '@/bridge/channelPort'
import type { ConversationEvent, TeamMemberState } from './semantic'
import { escapeHtml } from '@/utils/formatting'
import { formatToolBubble } from '@/channel/telegram/toolBubble'

export interface ProjectedMessage {
    message: ChannelMessage
    toolUseId?: string
    stateKey?: string
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

interface ProjectedTeamState {
    teamName: string
    isAutoTeam?: boolean
    members: Map<string, TeamMemberState>
    ended: boolean
    generation: number
    lastRendered?: string
}

const MAX_TEAM_CARD_MEMBERS = 12

export class ChannelProjector {
    private textBuffer = ''
    private toolStates = new Map<string, ProjectedToolState>()
    private normalToolGroupKey: string | null = null
    private normalToolGroupIndex = 0
    private teamStates = new Map<string, ProjectedTeamState>()

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

            case 'session_metadata_update':
                return []

            case 'team_state_update':
                return this.projectTeamState(event, options)

            case 'command_result':
                // Provider metadata updates mutate session state and do not belong in the transcript.
                const commandLower = event.command.toLowerCase()
                if (commandLower.includes('available_commands') || commandLower.includes('commands_update') || commandLower.includes('config_option') || commandLower.includes('session_info')) {
                    return []
                }
                const commandText = formatCommandResult(event.command, event.output)
                if (!commandText) return this.flushText()
                return [
                    ...this.flushText(),
                    {
                        message: {
                            text: commandText,
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

    resetTurn(): void {
        this.textBuffer = ''
        this.toolStates.clear()
        this.normalToolGroupKey = null
        this.normalToolGroupIndex = 0
    }

    reset(): void {
        this.resetTurn()
        this.teamStates.clear()
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

        return {
            message: { text: this.formatToolState(state), format: 'html' },
            toolUseId: groupKey,
            isToolEvent: true,
            isTerminal: event.phase === 'completed' || event.phase === 'failed',
            semanticEvent: withMergedToolContent(event, state),
        }
    }

    private ensureNormalToolGroup(): string {
        if (!this.normalToolGroupKey) {
            this.normalToolGroupKey = `normal-tool-group:${++this.normalToolGroupIndex}`
        }
        return this.normalToolGroupKey
    }

    private closeNormalToolGroup(): void {
        this.normalToolGroupKey = null
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

    private projectTeamState(
        event: Extract<ConversationEvent, { kind: 'team_state_update' }>,
        options: ChannelProjectorOptions,
    ): ProjectedMessage[] {
        const state = this.mergeTeamState(event)
        const verboseLevel = options.verboseLevel ?? 1
        if (verboseLevel === 0) return []

        const text = formatTeamState(state, verboseLevel)
        if (text === state.lastRendered) return []
        state.lastRendered = text

        return [{
            message: { text, format: 'html' },
            stateKey: `team-state:${state.teamName}:${state.generation}`,
            isToolEvent: false,
            isTerminal: event.action === 'team_deleted',
            semanticEvent: event,
        }]
    }

    private mergeTeamState(event: Extract<ConversationEvent, { kind: 'team_state_update' }>): ProjectedTeamState {
        const existing = this.teamStates.get(event.teamName)
        const startsNewLifecycle = !existing
            || (existing.ended && event.action !== 'team_deleted')
        const state: ProjectedTeamState = startsNewLifecycle
            ? {
                teamName: event.teamName,
                members: new Map(),
                ended: false,
                generation: (existing?.generation ?? 0) + 1,
            }
            : existing

        if (event.isAutoTeam !== undefined) state.isAutoTeam = event.isAutoTeam
        for (const member of event.members ?? []) this.mergeTeamMember(state, member)
        state.ended = event.action === 'team_deleted'
        this.teamStates.set(event.teamName, state)
        return state
    }

    private mergeTeamMember(state: ProjectedTeamState, member: TeamMemberState): void {
        const matchingEntry = Array.from(state.members.entries()).find(([, existing]) => {
            return existing.sessionId && member.sessionId && existing.sessionId === member.sessionId
                || existing.taskId && member.taskId && existing.taskId === member.taskId
                || existing.name === member.name
        })
        const existing = matchingEntry?.[1]
        const merged: TeamMemberState = {
            ...existing,
            ...member,
            ...(existing?.tokenUsage || member.tokenUsage
                ? { tokenUsage: { ...existing?.tokenUsage, ...member.tokenUsage } }
                : {}),
        }
        const key = merged.sessionId ?? merged.taskId ?? merged.name
        if (matchingEntry && matchingEntry[0] !== key) state.members.delete(matchingEntry[0])
        state.members.set(key, merged)
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
                text: this.formatToolState(state, true),
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

    private formatToolState(state: ProjectedToolState, showGenericInput = false): string {
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
            showGenericInput,
            content: state.content,
        })
    }
}

function formatTeamState(state: ProjectedTeamState, verboseLevel: 1 | 2): string {
    const autoLabel = state.isAutoTeam ? ' <i>(auto)</i>' : ''
    const parts = [`<b>👥 Agent Team: ${escapeHtml(state.teamName)}</b>${autoLabel}`]
    if (state.ended) {
        parts.push('⏹️ Team ended')
        const summary = formatTeamSummary(state.members)
        if (summary) parts.push(summary)
        return parts.join('\n')
    }

    const members = Array.from(state.members.values())
    if (members.length === 0) {
        parts.push('Team ready')
        return parts.join('\n')
    }

    for (const member of members.slice(0, MAX_TEAM_CARD_MEMBERS)) {
        parts.push(formatTeamMember(member, verboseLevel))
    }
    if (members.length > MAX_TEAM_CARD_MEMBERS) {
        parts.push(`<i>… ${members.length - MAX_TEAM_CARD_MEMBERS} more members</i>`)
    }

    const summary = formatTeamSummary(state.members)
    if (summary) parts.push(summary)
    return parts.join('\n')
}

function formatTeamMember(member: TeamMemberState, verboseLevel: 1 | 2): string {
    const status = member.status?.trim() || 'unknown'
    const lines = [`${teamStatusIcon(status)} <b>${escapeHtml(member.name)}</b> — ${escapeHtml(status)}`]
    const details: string[] = []
    if (member.description) details.push(escapeHtml(truncateText(member.description, 120)))
    if (member.tokenUsage?.lastContextWindow !== undefined) {
        details.push(`${formatTokenCount(member.tokenUsage.lastContextWindow)} context`)
    }
    if (member.toolCallCount !== undefined) {
        details.push(`${member.toolCallCount} tool${member.toolCallCount === 1 ? '' : 's'}`)
    }
    if (details.length > 0) lines.push(`  ${details.join(' · ')}`)

    if (verboseLevel === 2) {
        const diagnostics: string[] = []
        if (member.tokenUsage?.inputTokens !== undefined || member.tokenUsage?.outputTokens !== undefined) {
            diagnostics.push(`${member.tokenUsage?.inputTokens ?? 0} in / ${member.tokenUsage?.outputTokens ?? 0} out`)
        }
        if (member.taskId) diagnostics.push(`task <code>${escapeHtml(truncateText(member.taskId, 16))}</code>`)
        if (member.sessionId) diagnostics.push(`session <code>${escapeHtml(truncateText(member.sessionId, 16))}</code>`)
        if (diagnostics.length > 0) lines.push(`  ${diagnostics.join(' · ')}`)
    }

    return lines.join('\n')
}

function formatTeamSummary(members: Map<string, TeamMemberState>): string {
    const counts = new Map<string, number>()
    for (const member of members.values()) {
        const status = member.status?.trim() || 'unknown'
        counts.set(status, (counts.get(status) ?? 0) + 1)
    }
    return Array.from(counts.entries())
        .map(([status, count]) => `${count} ${escapeHtml(status)}`)
        .join(' · ')
}

function teamStatusIcon(status: string): string {
    switch (status.toLowerCase()) {
        case 'running':
        case 'in_progress':
            return '🟡'
        case 'completed':
        case 'success':
        case 'done':
            return '✅'
        case 'failed':
        case 'error':
            return '❌'
        case 'blocked':
            return '⚠️'
        case 'pending':
            return '🕓'
        case 'stopped':
        case 'cancelled':
            return '⏹️'
        case 'idle':
            return '⚪'
        default:
            return '🔵'
    }
}

function formatTokenCount(value: number): string {
    if (Math.abs(value) < 1_000) return String(value)
    if (Math.abs(value) < 1_000_000) return `${trimDecimal(value / 1_000)}k`
    return `${trimDecimal(value / 1_000_000)}m`
}

function trimDecimal(value: number): string {
    return value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, '')
}

function truncateText(value: string, maxLength: number): string {
    return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`
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

function formatCommandResult(command: string, output: unknown): string | null {
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
        const entriesText = formatPlanEntries(output)
        if (entriesText) return entriesText

        const planText = extractPlanContent(output)
        if (planText) {
            return `<b>📋 Plan</b>\n${escapeHtml(planText)}`
        }
        return null
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

function formatPlanEntries(output: unknown): string | null {
    const record = asRecord(output)
    const entries = Array.isArray(record?.entries) ? record.entries : undefined
    if (!entries) return null

    const lines = entries.flatMap((entry) => {
        const item = asRecord(entry)
        const content = typeof item?.content === 'string' ? item.content.trim() : ''
        if (!content) return []
        return `${planEntryStatusIcon(item?.status)} ${escapeHtml(content)}`
    })

    if (lines.length === 0) return null
    return `<b>📋 Tasks</b>\n${lines.join('\n')}`
}

function planEntryStatusIcon(status: unknown): string {
    switch (status) {
        case 'completed':
            return '✅'
        case 'in_progress':
            return '🔄'
        case 'cancelled':
            return '⏹️'
        case 'pending':
        default:
            return '⬜'
    }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? value as Record<string, unknown> : null
}
