import { escapeHtml, sanitizeXmlLikeTags } from '@/utils/formatting'

export interface ToolBubbleState {
    toolName: string
    input: unknown
    status: 'pending' | 'running' | 'completed' | 'interrupted'
    output?: string
    isError?: boolean
    displayTitle?: string
    category?: 'read' | 'edit' | 'write' | 'execute' | 'search' | 'agent' | 'unknown'
    content?: Array<{ type: 'content'; contentType: string; text?: string } | { type: 'diff'; path?: string; oldText?: string; newText?: string } | { type: 'terminal'; terminalId?: string }>
}

const TOOL_NAME_ALIASES: Record<string, string> = {
    bash: 'Bash',
    read: 'Read',
    'read file': 'Read',
    read_file: 'Read',
    todo_write: 'TodoWrite',
    'todo write': 'TodoWrite',
    todo: 'TodoWrite',
    edit: 'Edit',
    'edit file': 'Edit',
    edit_file: 'Edit',
    write: 'Write',
    'write file': 'Write',
    write_file: 'Write',
    glob: 'Glob',
    grep: 'Grep',
    agent: 'Agent',
    websearch: 'WebSearch',
    web_search: 'WebSearch',
    webfetch: 'WebFetch',
    web_fetch: 'WebFetch',
    todowrite: 'TodoWrite',
    exitplanmode: 'ExitPlanMode',
    exit_plan_mode: 'ExitPlanMode',
    task: 'Task',
    skill: 'Skill',
    'loaded skill': 'Skill',
}

function normalizeToolName(name: string): string {
    return TOOL_NAME_ALIASES[name.toLowerCase()] || name
}

const SUPPRESS_RESULT_TOOLS = new Set([
    'TodoWrite', 'Write', 'Edit', 'Read', 'WebSearch', 'WebFetch', 'ExitPlanMode', 'Task',
])

export function formatToolBubble(state: ToolBubbleState): string {
    const name = normalizeToolName(state.toolName)
    const input = state.input as Record<string, unknown> | undefined
    const isRunning = state.status === 'pending' || state.status === 'running'
    const isInterrupted = state.status === 'interrupted'
    const suppressResult = SUPPRESS_RESULT_TOOLS.has(name)

    const parts: string[] = []

    // If displayTitle exists and toolName is canonical, show "ToolName: displayTitle"
    // If displayTitle exists and toolName is generic, show displayTitle as the header
    const header = renderToolHeader(name, input, state.displayTitle, state.content)
    parts.push(header)

    for (const path of getContentFilePaths(state.content)) {
        if (!header.includes(escapeHtml(path))) {
            parts.push(`📄 <code>${escapeHtml(path)}</code>`)
        }
    }

    if (isRunning) {
        parts.push('⏳')
    } else if (isInterrupted) {
        parts.push('⏹️')
    } else if (!suppressResult && state.status === 'completed') {
        const resultPart = renderToolResultInline(name, state.output || '', state.isError ?? false)
        if (resultPart) parts.push(resultPart)
    }

    return parts.join('\n')
}

function renderToolHeader(
    name: string,
    input: Record<string, unknown> | undefined,
    displayTitle?: string,
    content?: ToolBubbleState['content'],
): string {
    const isEmptyInput = !input || (typeof input === 'object' && Object.keys(input).length === 0)

    // Helper to extract file path from various field names
    const getFilePath = (): string => {
        return String((input as any)?.file_path || (input as any)?.filePath || (input as any)?.path || getContentFilePaths(content)[0] || '')
    }

    switch (name) {
        case 'Bash': {
            if (isEmptyInput) return '💻 <b>Bash</b>'
            const cmd = (input as any)?.command as string | undefined
            if (!cmd) return '💻 <b>Bash</b>'
            return `💻 <code>$ ${escapeHtml(cmd)}</code>`
        }
        case 'Read': {
            const filePath = getFilePath()
            const displayPath = displayTitle || filePath
            if (!displayPath) return '📖 <b>Read</b>'
            return `📖 <b>Read</b>: <code>${escapeHtml(displayPath)}</code>`
        }
        case 'Edit': {
            const filePath = getFilePath()
            const displayPath = displayTitle || filePath
            if (!displayPath) return '✏️ <b>Edit</b>'
            return `✏️ <b>Edit</b>: <code>${escapeHtml(displayPath)}</code>`
        }
        case 'Write': {
            const filePath = getFilePath()
            const displayPath = displayTitle || filePath
            if (!displayPath) return '📝 <b>Write</b>'
            return `📝 <b>Write</b>: <code>${escapeHtml(displayPath)}</code>`
        }
        case 'Glob': {
            if (isEmptyInput) return '🔍 <b>Glob</b>'
            return `🔍 <b>Glob</b>: <code>${escapeHtml(String((input as any)?.pattern || ''))}</code>`
        }
        case 'Grep': {
            if (displayTitle) return `🔍 <b>${escapeHtml(displayTitle)}</b>`
            if (isEmptyInput) return '🔍 <b>Grep</b>'
            return `🔍 <b>Grep</b>: <code>${escapeHtml(String((input as any)?.pattern || ''))}</code>`
        }
        case 'Agent': {
            const desc = (input as any)?.description || (input as any)?.prompt?.slice(0, 100) || ''
            const displayDesc = displayTitle || desc
            if (!displayDesc) return '🤖 <b>Agent</b>'
            return `🤖 <b>Agent</b>: ${escapeHtml(String(displayDesc))}`
        }
        case 'WebSearch': {
            if (isEmptyInput) return '🌐 <b>Search</b>'
            return `🌐 <b>Search</b>: <code>${escapeHtml(String((input as any)?.query || ''))}</code>`
        }
        case 'WebFetch': {
            if (isEmptyInput) return '🌐 <b>Fetch</b>'
            return `🌐 <b>Fetch</b>: <code>${escapeHtml(String((input as any)?.url || ''))}</code>`
        }
        case 'TodoWrite': {
            const todos = (input as any)?.todos as Array<{ content: string; status: string }> | undefined
            if (!todos || !Array.isArray(todos)) return '📋 <b>Tasks</b>'
            const lines = todos.map(t => {
                const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜'
                return `${icon} ${escapeHtml(t.content)}`
            })
            return `📋 <b>Tasks</b>\n${lines.join('\n')}`
        }
        case 'ExitPlanMode': {
            // Show full plan content if available (HTML escaped)
            const planContent = (input as any)?.plan as string | undefined
                || (input as any)?.content as string | undefined
                || displayTitle
            if (planContent && typeof planContent === 'string' && planContent.trim()) {
                return `📋 <b>Plan</b>\n<pre>${escapeHtml(planContent)}</pre>`
            }
            return '📋 <b>Exited plan mode</b>'
        }
        case 'Task': {
            const desc = (input as any)?.description as string | undefined
            const subagentType = (input as any)?.subagent_type as string | undefined
            const typeLabel = subagentType ? ` (${subagentType})` : ''
            const displayDesc = displayTitle || desc
            if (!displayDesc) return `🚀 <b>Task</b>${typeLabel}`
            return `🚀 <b>Task</b>${typeLabel}: ${escapeHtml(displayDesc)}`
        }
        case 'Skill': {
            const skillName = (input as any)?.name as string | undefined
            const command = (input as any)?.command as string | undefined
            const displayDesc = displayTitle || skillName || command
            if (displayDesc) return `⚡ <b>Skill</b>: <code>${escapeHtml(displayDesc)}</code>`
            return `⚡ <b>Skill</b>`
        }
        default: {
            // For generic tool names, displayTitle might be the actual descriptive name
            if (isGenericToolName(name) && displayTitle) {
                return `🔧 <b>${escapeHtml(displayTitle)}</b>`
            }
            if (isEmptyInput) return `🔧 <b>${escapeHtml(name)}</b>`
            const inputStr = JSON.stringify(input, null, 2)
            return `🔧 <b>${escapeHtml(name)}</b>\n<pre>${escapeHtml(inputStr)}</pre>`
        }
    }
}

function getContentFilePaths(content: ToolBubbleState['content']): string[] {
    if (!content?.length) return []
    const paths: string[] = []
    const seen = new Set<string>()

    for (const item of content) {
        if (item.type !== 'diff' || !item.path) continue
        if (seen.has(item.path)) continue
        seen.add(item.path)
        paths.push(item.path)
    }

    return paths
}

function renderToolResultInline(name: string, output: string, isError: boolean): string | null {
    const sanitizedOutput = sanitizeXmlLikeTags(output)

    if (name === 'Bash') {
        if (!sanitizedOutput.trim()) return isError ? '❌ <i>(no output)</i>' : null
        return `${isError ? '❌' : ''}<pre>${escapeHtml(sanitizedOutput)}</pre>`
    }

    if (name === 'Glob' || name === 'Grep') {
        if (!sanitizedOutput.trim()) return null
        if (/^\d+ (matches|match|files|file)( \(truncated\))?$/.test(sanitizedOutput.trim())) {
            return `${isError ? '❌' : '✅'} ${escapeHtml(sanitizedOutput.trim())}`
        }
        const lines = sanitizedOutput.trim().split('\n').filter(Boolean)
        return `${isError ? '❌' : '✅'} ${lines.length} match${lines.length !== 1 ? 'es' : ''}`
    }

    if (name === 'Agent') {
        if (!sanitizedOutput.trim()) return null
        try {
            const parsed = JSON.parse(sanitizedOutput)
            if (typeof parsed === 'object' && parsed !== null) {
                const taskResult = parsed.task_result as string | undefined
                if (taskResult && taskResult.trim()) {
                    return escapeHtml(sanitizeXmlLikeTags(taskResult.trim()))
                }
                const result = parsed.result as string | undefined
                if (result && result.trim()) {
                    return escapeHtml(sanitizeXmlLikeTags(result.trim()))
                }
                const message = parsed.message as string | undefined
                if (message && message.trim()) {
                    return escapeHtml(sanitizeXmlLikeTags(message.trim()))
                }
                return `<pre>${escapeHtml(JSON.stringify(parsed, null, 2))}</pre>`
            }
        } catch {}
        return escapeHtml(sanitizedOutput)
    }

    if (!sanitizedOutput.trim()) return null
    return `${isError ? '❌' : '✅'} <code>${escapeHtml(sanitizedOutput)}</code>`
}

export class ToolMessageTracker {
    private messages = new Map<string, number>()
    /** Sentinel value indicating a message has been reserved but the real messageId isn't known yet */
    private static readonly RESERVED = -1

    /** Reserve a slot for this toolUseId before the async send completes.
     *  This ensures subsequent events see the toolUseId as "already tracked"
     *  and route to edit instead of sending a new message. */
    reserve(toolUseId: string): void {
        this.messages.set(toolUseId, ToolMessageTracker.RESERVED)
    }

    set(toolUseId: string, messageId: number): void {
        this.messages.set(toolUseId, messageId)
    }

    get(toolUseId: string): number | undefined {
        const val = this.messages.get(toolUseId)
        if (val === ToolMessageTracker.RESERVED) return undefined
        return val
    }

    has(toolUseId: string): boolean {
        return this.messages.has(toolUseId)
    }

    delete(toolUseId: string): void {
        this.messages.delete(toolUseId)
    }

    finalizeAll(): Array<{ toolUseId: string; messageId: number }> {
        const pending: Array<{ toolUseId: string; messageId: number }> = []
        for (const [toolUseId, messageId] of this.messages) {
            if (messageId !== ToolMessageTracker.RESERVED) {
                pending.push({ toolUseId, messageId })
            }
        }
        this.messages.clear()
        return pending
    }
}

function isGenericToolName(toolName: string | undefined): boolean {
    return !toolName || toolName === 'tool' || toolName === 'tool_call'
}
