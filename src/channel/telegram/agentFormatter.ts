import type { AgentEvent, AgentToolUseEvent, AgentToolResultEvent, ToolResultContentBlock } from '@/providers/types'
import type { ConversationModel } from '@/middleware/conversationModel'
import { escapeHtml, sanitizeXmlLikeTags } from '@/utils/formatting'

export { escapeHtml, sanitizeXmlLikeTags }

export interface FormatOptions {
    verboseLevel?: 0 | 1 | 2
    toolNameMap?: Map<string, string>
    conversationModel?: ConversationModel
}

// "Report" tools visible at level 0
const REPORT_TOOLS = new Set(['TodoWrite', 'ExitPlanMode'])

function isReportEvent(event: AgentEvent): boolean {
    if (event.kind === 'session_init' || event.kind === 'text' || event.kind === 'result') return true
    if (event.kind === 'tool_use' && REPORT_TOOLS.has(event.toolName)) return true
    return false
}

export function formatAgentEventForTelegram(event: AgentEvent, options?: FormatOptions): string | null {
    const level = options?.verboseLevel ?? 1
    const conversationModel = options?.conversationModel
    const toolNameMap = conversationModel?.toolNameMap ?? options?.toolNameMap

    // Level 0: only report events
    if (level === 0 && !isReportEvent(event)) return null

    switch (event.kind) {
        case 'session_init': {
            // Session start message is already sent by telegramLauncher.ts
            // when the query is started, so we don't need to send it again here
            return null
        }

        case 'commands_update': {
            // Provider commands are displayed via /help.
            // Show a brief hint when commands are updated so users know.
            const count = event.commands.length
            if (count === 0) return null
            return `💡 Provider commands updated (${count} available). Use /help to see them.`
        }

        case 'text': {
            const rawText = event.text
            // Do NOT trim per-delta — in streaming mode each delta may start/end
            // with meaningful whitespace (code indentation, inter-word spaces).
            // Trimming is done once on the full buffer at flush time.
            if (!rawText) return null
            // Output raw markdown — tgmdrender handles conversion.
            // sanitizeXmlLikeTags prevents XML-like tags from being
            // misinterpreted by the markdown parser.
            return sanitizeXmlLikeTags(rawText)
        }

        case 'tool_use':
            return renderToolUse(event, conversationModel)

        case 'tool_result':
            return renderToolResult(event, toolNameMap, conversationModel, level)

        case 'result': {
            if (event.status === 'success') {
                const parts = ['✅ <b>Done</b>']
                if (event.tokenCount) parts.push(`${event.tokenCount} tokens`)
                if (event.costUsd != null) parts.push(`$${event.costUsd.toFixed(4)}`)
                if (event.durationMs != null) parts.push(`${(event.durationMs / 1000).toFixed(1)}s`)
                return parts.join(' | ')
            } else if (event.status === 'max_turns') {
                return '⚠️ <b>Max turns reached</b>'
            } else {
                const detail = event.summary ? `\n<pre>${escapeHtml(String(event.summary))}</pre>` : ''
                return `❌ <b>Error during execution</b>${detail}`
            }
        }

        case 'raw': {
            if (event.providerName === 'opencode' && event.rawMessage) {
                const raw = event.rawMessage as Record<string, unknown>

                // SSEEventListener sends part directly as rawMessage for step events
                // raw = { type: 'step-start'/'step-finish', task_result: '...', ... }
                const rawType = raw.type as string | undefined
                if (rawType === 'step-start' || rawType === 'step-finish') {
                    // Extract task_result content
                    const taskResult = raw.task_result as string | undefined
                    if (taskResult && taskResult.trim()) {
                        return escapeHtml(sanitizeXmlLikeTags(taskResult.trim()))
                    }
                    // Fallback: check for text in nested part object
                    const part = raw.part as Record<string, unknown> | undefined
                    if (part) {
                        const text = part.text as string | undefined
                        if (text && text.trim()) {
                            return escapeHtml(sanitizeXmlLikeTags(text.trim()))
                        }
                    }
                }

                // Also handle wrapped format: raw = { type: 'step_start', part: {...} }
                const part = raw.part as Record<string, unknown> | undefined
                if (part && (rawType === 'step_start' || rawType === 'step_finish')) {
                    const text = part.text as string | undefined
                    if (text && text.trim()) {
                        return escapeHtml(sanitizeXmlLikeTags(text.trim()))
                    }
                }
            }

            if (event.providerName === 'acp' && event.rawMessage) {
                const raw = event.rawMessage as Record<string, unknown>
                const rawType = raw.sessionUpdate as string | undefined

                if (rawType === 'plan') {
                    const content = raw.content as string | undefined
                        || (raw as any).plan as string | undefined
                        || (raw as any).text as string | undefined
                    if (content && typeof content === 'string' && content.trim()) {
                        return `📋 <b>Plan</b>\n${escapeHtml(sanitizeXmlLikeTags(content.trim()))}`
                    }
                    const planObj = raw.plan as Record<string, unknown> | undefined
                    if (planObj && typeof planObj === 'object') {
                        const planText = planObj.text as string | undefined
                            || planObj.content as string | undefined
                        if (planText && planText.trim()) {
                            return `📋 <b>Plan</b>\n${escapeHtml(sanitizeXmlLikeTags(planText.trim()))}`
                        }
                    }
                    return `📋 <b>Exited plan mode</b>`
                }

                if (level === 2) {
                    if (rawType === 'agent_thought_chunk') {
                        const text = (raw as any).text as string | undefined
                            || (raw as any).content as string | undefined
                        if (text && typeof text === 'string' && text.trim()) {
                            return `💭 ${escapeHtml(sanitizeXmlLikeTags(text.trim()))}`
                        }
                        return null
                    }

                    if (rawType === 'current_mode_update') {
                        const mode = (raw as any).mode as string | undefined
                        if (mode) {
                            return `🔄 Mode: <b>${escapeHtml(mode)}</b>`
                        }
                        return null
                    }

                    if (rawType === 'usage_update') {
                        const usage = (raw as any).usage as Record<string, unknown> | undefined
                        if (usage) {
                            const tokens = (usage.inputTokens as number ?? 0) + (usage.outputTokens as number ?? 0)
                            const cost = usage.totalCostUsd as number | undefined
                            const parts = [`${tokens} tokens`]
                            if (cost != null) parts.push(`$${cost.toFixed(4)}`)
                            return `📊 ${parts.join(' | ')}`
                        }
                        return null
                    }

                    if (rawType === 'session_info_update' || rawType === 'config_option_update') {
                        return null
                    }

                    const preview = JSON.stringify(raw).substring(0, 200)
                    return `🔍 <code>${escapeHtml(preview)}</code>`
                }
            }

            if (level === 2 && event.rawMessage) {
                const preview = JSON.stringify(event.rawMessage).substring(0, 200)
                return `🔍 <code>${escapeHtml(preview)}</code>`
            }

            return null
        }

        default:
            return null
    }
}

// --- ToolKind classification ---

const TOOL_KIND_ICONS: Record<string, string> = {
    read: '📖',
    edit: '✏️',
    write: '📝',
    execute: '💻',
    search: '🔍',
}

function toolKindIcon(toolKind?: string): string | undefined {
    if (!toolKind) return undefined
    return TOOL_KIND_ICONS[toolKind.toLowerCase()]
}

function formatLocations(locations: Array<{ path: string; line?: number }> | undefined): string {
    if (!locations || locations.length === 0) return ''
    const paths = locations.map(loc => {
        const base = loc.path.split(/[\\/]/).pop() || loc.path
        return loc.line != null ? `${base}:${loc.line}` : base
    })
    return `<code>${escapeHtml(paths.join(', '))}</code>`
}

// --- Tool-specific renderers ---

const TOOL_NAME_ALIASES: Record<string, string> = {
    bash: 'Bash',
    read: 'Read',
    edit: 'Edit',
    write: 'Write',
    glob: 'Glob',
    grep: 'Grep',
    agent: 'Agent',
    websearch: 'WebSearch',
    webfetch: 'WebFetch',
    todowrite: 'TodoWrite',
    exitplanmode: 'ExitPlanMode',
    task: 'Task',
    skill: 'Skill',
    'loaded skill': 'Skill',
}

function normalizeToolName(name: string): string {
    return TOOL_NAME_ALIASES[name.toLowerCase()] || name
}

function isReadToolKind(toolKind?: string): boolean {
    if (!toolKind) return false
    return toolKind.toLowerCase() === 'read' || toolKind.toLowerCase() === 'search'
}

function isReadTitleHeuristic(toolName: string): boolean {
    const lower = toolName.toLowerCase()
    return lower === 'read' || lower.startsWith('read:') || lower === 'glob' || lower === 'grep'
        || lower === 'fetch' || lower === 'webfetch' || lower.startsWith('webfetch:')
}

function renderToolUse(event: AgentToolUseEvent, conversationModel?: ConversationModel): string | null {
    const input = event.input as Record<string, unknown> | undefined
    const name = normalizeToolName(event.toolName)
    const kind = event.toolKind ?? conversationModel?.getToolKind(event.toolUseId ?? '')
    const locStr = formatLocations(event.locations)

    switch (name) {
        case 'TodoWrite': {
            const todos = (input as any)?.todos as Array<{ content: string; status: string }> | undefined
            if (!todos || !Array.isArray(todos)) return null
            const lines = todos.map(t => {
                const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜'
                return `${icon} ${escapeHtml(t.content)}`
            })
            return `📋 <b>Tasks</b>\n${lines.join('\n')}`
        }

        case 'Bash': {
            const cmd = (input as any)?.command as string | undefined
            if (!cmd) return `💻 <b>Bash</b>${locStr ? ' ' + locStr : ''}`
            return `💻 <code>$ ${escapeHtml(cmd)}</code>${locStr ? '\n📂 ' + locStr : ''}`
        }

        case 'Write':
            return `📝 <b>Write</b>: ${locStr || `<code>${escapeHtml(String((input as any)?.file_path || ''))}</code>`}`

        case 'Edit':
            return `✏️ <b>Edit</b>: ${locStr || `<code>${escapeHtml(String((input as any)?.file_path || ''))}</code>`}`

        case 'Read':
            return `📖 <b>Read</b>: ${locStr || `<code>${escapeHtml(String((input as any)?.file_path || ''))}</code>`}`

        case 'Glob': {
            const pattern = (input as any)?.pattern as string | undefined
            if (!pattern) return '🔍 <b>Glob</b>'
            return `🔍 <b>Glob</b>: <code>${escapeHtml(pattern)}</code>`
        }

        case 'Grep': {
            const pattern = (input as any)?.pattern as string | undefined
            if (!pattern) return '🔍 <b>Grep</b>'
            return `🔍 <b>Grep</b>: <code>${escapeHtml(pattern)}</code>`
        }

        case 'Agent':
            return `🤖 <b>Agent</b>: ${escapeHtml(String((input as any)?.description || (input as any)?.prompt?.slice(0, 100) || ''))}`

        case 'WebSearch':
            return `🌐 <b>Search</b>: <code>${escapeHtml(String((input as any)?.query || ''))}</code>`

        case 'WebFetch':
            return `🌐 <b>Fetch</b>: <code>${escapeHtml(String((input as any)?.url || ''))}</code>`

        case 'ExitPlanMode': {
            const planInput = (input as any)?.plan as string | undefined
                || (input as any)?.content as string | undefined
            if (planInput && typeof planInput === 'string' && planInput.trim()) {
                return `📋 <b>Plan</b>\n${escapeHtml(sanitizeXmlLikeTags(planInput.trim()))}`
            }
            return `📋 <b>Exited plan mode</b>`
        }

        case 'Task': {
            const desc = (input as any)?.description as string | undefined
            const subagentType = (input as any)?.subagent_type as string | undefined
            const typeLabel = subagentType ? ` (${subagentType})` : ''
            if (!desc) return `🚀 <b>Task</b>${typeLabel}`
            return `🚀 <b>Task</b>${typeLabel}: ${escapeHtml(desc)}`
        }

        case 'Skill': {
            const skillName = (input as any)?.name as string | undefined
            const command = (input as any)?.command as string | undefined
            if (skillName) return `⚡ <b>Skill</b>: <code>${escapeHtml(skillName)}</code>`
            if (command) return `⚡ <b>Skill</b>: <code>${escapeHtml(command)}</code>`
            return `⚡ <b>Skill</b>`
        }

        default: {
            if (kind) {
                const icon = toolKindIcon(kind) ?? '🔧'
                const label = escapeHtml(name)
                return locStr
                    ? `${icon} <b>${label}</b>: ${locStr}`
                    : `${icon} <b>${label}</b>`
            }
            return genericToolUse(name, input)
        }
    }
}

function genericToolUse(name: string, input: unknown): string {
    const inputStr = JSON.stringify(input, null, 2)
    return `🔧 <b>${escapeHtml(name)}</b>\n<pre>${escapeHtml(inputStr)}</pre>`
}

// Tools whose tool_result should be suppressed (the tool_use already conveys meaning)
const SUPPRESS_RESULT_TOOLS = new Set([
    'TodoWrite', 'Write', 'Edit', 'Read', 'WebSearch', 'WebFetch', 'ExitPlanMode', 'Task', 'Skill'
])

function renderDiffSummary(blocks: Array<ToolResultContentBlock>): string | null {
    const diffBlocks = blocks.filter(b => b.type === 'diff')
    if (diffBlocks.length === 0) return null

    const parts = diffBlocks.map(b => {
        const diff = b as { type: 'diff'; path?: string; oldText?: string; newText?: string }
        const path = diff.path ? diff.path.split(/[\\/]/).pop() || diff.path : ''
        const oldLines = diff.oldText ? diff.oldText.split('\n').length : 0
        const newLines = diff.newText ? diff.newText.split('\n').length : 0
        const summary = path
            ? `${escapeHtml(path)}: ${oldLines}→${newLines} lines`
            : `${oldLines}→${newLines} lines`
        return summary
    })
    return `📄 <b>Diff</b> ${parts.join(', ')}`
}

function renderContentBlocks(event: AgentToolResultEvent): string | null {
    const content = event.content
    if (!content || content.length === 0) return null

    // Check for diff blocks first — they get special rendering
    const diffResult = renderDiffSummary(content)
    if (diffResult) return diffResult

    // Check for terminal blocks
    const terminalBlocks = content.filter(b => b.type === 'terminal')
    if (terminalBlocks.length > 0) {
        const term = terminalBlocks[0] as { type: 'terminal'; terminalId?: string }
        return `${event.isError ? '❌' : '✅'} <b>Terminal</b>${term.terminalId ? ` <code>${escapeHtml(term.terminalId)}</code>` : ''}`
    }

    // Check for content blocks with text
    const textParts: string[] = []
    for (const block of content) {
        if (block.type === 'content') {
            const c = block as { type: 'content'; contentType: string; text?: string }
            if (c.text) textParts.push(c.text)
        }
    }
    if (textParts.length > 0) {
        const joined = textParts.join('\n')
        const sanitized = sanitizeXmlLikeTags(joined)
        if (!sanitized.trim()) return null
        return `${event.isError ? '❌' : '✅'} ${escapeHtml(sanitized)}`
    }

    return null
}

function renderToolResult(event: AgentToolResultEvent, toolNameMap?: Map<string, string>, conversationModel?: ConversationModel, verboseLevel?: 0 | 1 | 2): string | null {
    // Idempotent guard: skip if this toolUseId's result was already rendered
    if (event.toolUseId && conversationModel?.isResultRendered(event.toolUseId)) {
        return null
    }

    const rawToolName = event.toolName
        ?? (event.toolUseId && toolNameMap ? toolNameMap.get(event.toolUseId) : undefined)
    const toolName = rawToolName ? normalizeToolName(rawToolName) : undefined
    const toolKind = conversationModel?.getToolKind(event.toolUseId ?? '')

    // Dynamic Read suppression: if toolKind is 'read' or 'search', suppress result
    if (toolKind && isReadToolKind(toolKind)) {
        if (event.toolUseId && conversationModel) conversationModel.markResultRendered(event.toolUseId)
        return null
    }

    // Heuristic fallback: suppress if toolName/title suggests a read-like tool
    if (!toolKind && rawToolName && isReadTitleHeuristic(rawToolName)) {
        if (event.toolUseId && conversationModel) conversationModel.markResultRendered(event.toolUseId)
        return null
    }

    // Level < 2: suppress raw tool output (Bash stdout, generic previews)
    // Summary-style results (Grep/Glob match counts, Agent task results) are still shown at level 1
    // Error results are always shown
    if (verboseLevel !== undefined && verboseLevel < 2 && !event.isError) {
        if (toolName === 'Bash') {
            if (event.toolUseId && conversationModel) conversationModel.markResultRendered(event.toolUseId)
            return null
        }
        if (toolName !== 'Glob' && toolName !== 'Grep' && toolName !== 'Agent' && toolName !== 'Task' && toolName !== 'Skill') {
            if (event.toolUseId && conversationModel) conversationModel.markResultRendered(event.toolUseId)
            return null
        }
    }

    // Try structured content blocks (diff, terminal, etc.)
    // For SUPPRESS_RESULT_TOOLS, only diff blocks are meaningful — skip text/terminal
    const isSuppressed = toolName != null && SUPPRESS_RESULT_TOOLS.has(toolName)
    if (event.content && event.content.length > 0) {
        if (isSuppressed) {
            const diffResult = renderDiffSummary(event.content)
            if (diffResult) {
                if (event.toolUseId && conversationModel) conversationModel.markResultRendered(event.toolUseId)
                return diffResult
            }
        } else {
            const contentResult = renderContentBlocks(event)
            if (contentResult) {
                if (event.toolUseId && conversationModel) conversationModel.markResultRendered(event.toolUseId)
                return contentResult
            }
        }
    }

    // Suppress results for tools where raw output adds no value
    if (isSuppressed) {
        if (event.toolUseId && conversationModel) conversationModel.markResultRendered(event.toolUseId)
        return null
    }

    // Sanitize XML-like tags in tool output
    const sanitizedOutput = sanitizeXmlLikeTags(event.output || '')

    if (toolName === 'Bash') {
        const output = sanitizedOutput
        if (!output.trim()) {
            const result = event.isError ? '❌ <i>(no output)</i>' : null
            if (event.toolUseId && conversationModel) conversationModel.markResultRendered(event.toolUseId)
            return result
        }
        if (event.toolUseId && conversationModel) conversationModel.markResultRendered(event.toolUseId)
        return `${event.isError ? '❌' : ''}<pre>${escapeHtml(output)}</pre>`
    }

    if (toolName === 'Glob' || toolName === 'Grep') {
        const output = sanitizedOutput
        const lines = output.trim().split('\n').filter(Boolean)
        if (event.toolUseId && conversationModel) conversationModel.markResultRendered(event.toolUseId)
        return `${event.isError ? '❌' : '✅'} ${lines.length} match${lines.length !== 1 ? 'es' : ''}`
    }

    if (toolName === 'Agent') {
        const output = sanitizedOutput
        if (!output.trim()) {
            if (event.toolUseId && conversationModel) conversationModel.markResultRendered(event.toolUseId)
            return null
        }

        // Try to parse JSON output from subagent
        try {
            const parsed = JSON.parse(output)
            if (typeof parsed === 'object' && parsed !== null) {
                const taskResult = parsed.task_result as string | undefined
                if (taskResult && taskResult.trim()) {
                    if (event.toolUseId && conversationModel) conversationModel.markResultRendered(event.toolUseId)
                    return escapeHtml(sanitizeXmlLikeTags(taskResult.trim()))
                }
                const result = parsed.result as string | undefined
                if (result && result.trim()) {
                    if (event.toolUseId && conversationModel) conversationModel.markResultRendered(event.toolUseId)
                    return escapeHtml(sanitizeXmlLikeTags(result.trim()))
                }
                const message = parsed.message as string | undefined
                if (message && message.trim()) {
                    if (event.toolUseId && conversationModel) conversationModel.markResultRendered(event.toolUseId)
                    return escapeHtml(sanitizeXmlLikeTags(message.trim()))
                }
                if (event.toolUseId && conversationModel) conversationModel.markResultRendered(event.toolUseId)
                return `<pre>${escapeHtml(JSON.stringify(parsed, null, 2))}</pre>`
            }
        } catch {
            // Not JSON, output as-is
        }
        if (event.toolUseId && conversationModel) conversationModel.markResultRendered(event.toolUseId)
        return escapeHtml(output)
    }

    if (toolName === 'Task') {
        const output = sanitizedOutput
        if (!output.trim()) {
            if (event.toolUseId && conversationModel) conversationModel.markResultRendered(event.toolUseId)
            return event.isError ? '❌' : null
        }
        // Task output is typically a text summary from the subagent
        if (event.toolUseId && conversationModel) conversationModel.markResultRendered(event.toolUseId)
        return `${event.isError ? '❌' : '✅'} ${escapeHtml(sanitizeXmlLikeTags(output.trim()))}`
    }

    if (toolName === 'Skill') {
        const output = sanitizedOutput
        if (!output.trim()) {
            if (event.toolUseId && conversationModel) conversationModel.markResultRendered(event.toolUseId)
            return event.isError ? '❌' : null
        }
        // Skill output is typically the skill execution result
        if (event.toolUseId && conversationModel) conversationModel.markResultRendered(event.toolUseId)
        return `${event.isError ? '❌' : '✅'} ${escapeHtml(sanitizeXmlLikeTags(output.trim()))}`
    }

    // Generic
    const preview = sanitizedOutput
    if (!preview.trim()) {
        if (event.toolUseId && conversationModel) conversationModel.markResultRendered(event.toolUseId)
        return null
    }
    if (event.toolUseId && conversationModel) conversationModel.markResultRendered(event.toolUseId)
    return `${event.isError ? '❌' : '✅'} <code>${escapeHtml(preview)}</code>`
}
