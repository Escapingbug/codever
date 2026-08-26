import { escapeHtml } from '@/utils/formatting'

export interface ToolBubbleState {
    toolName: string
    input: unknown
    status: 'pending' | 'running' | 'completed' | 'interrupted'
    output?: string
    isError?: boolean
    displayTitle?: string
    category?: 'read' | 'edit' | 'write' | 'execute' | 'search' | 'agent' | 'unknown'
    showGenericInput?: boolean
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
    askuserquestion: 'AskUserQuestion',
    ask_user_question: 'AskUserQuestion',
    'ask user question': 'AskUserQuestion',
}

const SENSITIVE_INPUT_KEY = /api.?key|authorization|cookie|credential|password|private.?key|secret|token/i
const MAX_GENERIC_INPUT_PREVIEW = 1_200

function normalizeToolName(name: string): string {
    return TOOL_NAME_ALIASES[name.toLowerCase()] || name
}

export function formatToolBubble(state: ToolBubbleState): string {
    const name = normalizeToolName(state.toolName)
    const input = state.input as Record<string, unknown> | undefined
    const isRunning = state.status === 'pending' || state.status === 'running'
    const isInterrupted = state.status === 'interrupted'

    const parts: string[] = []

    // If displayTitle exists and toolName is canonical, show "ToolName: displayTitle"
    // If displayTitle exists and toolName is generic, show displayTitle as the header
    const header = renderToolHeader(name, input, state.displayTitle, state.content, state.output, state.showGenericInput)
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
    } else if (state.status === 'completed') {
        const resultPart = renderSafeToolSummary(name, state.output || '', state.isError ?? false)
        if (resultPart) parts.push(resultPart)
    }

    return parts.join('\n')
}

function renderToolHeader(
    name: string,
    input: Record<string, unknown> | undefined,
    displayTitle?: string,
    content?: ToolBubbleState['content'],
    output?: string,
    showGenericInput = false,
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
            const planContent = getExitPlanContent(input, displayTitle, content, output)
            if (planContent) {
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
        case 'AskUserQuestion': {
            return renderAskUserQuestion(input)
        }
        default: {
            // For generic tool names, displayTitle might be the actual descriptive name
            if (isGenericToolName(name) && displayTitle) {
                return `🔧 <b>${escapeHtml(displayTitle)}</b>`
            }
            const genericHeader = `🔧 <b>${escapeHtml(name)}</b>`
            if (isEmptyInput || !showGenericInput) return genericHeader
            const preview = renderGenericInputPreview(input)
            return preview ? `${genericHeader}\n<pre>${escapeHtml(preview)}</pre>` : genericHeader
        }
    }
}

function renderAskUserQuestion(input: Record<string, unknown> | undefined): string {
    const questions = Array.isArray(input?.questions) ? input.questions : []
    if (questions.length === 0) return '❓ <b>AskUserQuestion</b>'

    const parts = ['❓ <b>Question</b>']
    for (const [index, value] of questions.slice(0, 4).entries()) {
        const question = asRecord(value)
        const text = stringValue(question?.question)
        if (!text) continue
        const header = stringValue(question?.header)
        const prefix = questions.length > 1 ? `${index + 1}. ` : ''
        parts.push(`${prefix}${header ? `<b>${escapeHtml(truncate(header, 80))}</b>\n` : ''}${escapeHtml(truncate(text, 400))}`)

        const options = Array.isArray(question?.options) ? question.options : []
        for (const optionValue of options.slice(0, 6)) {
            const option = asRecord(optionValue)
            const label = stringValue(option?.label)
            if (!label) continue
            const description = stringValue(option?.description)
            parts.push(`• <b>${escapeHtml(truncate(label, 120))}</b>${description ? ` — ${escapeHtml(truncate(description, 240))}` : ''}`)
        }
        if (question?.multiSelect === true) parts.push('<i>Multiple selections allowed</i>')
    }
    return truncate(parts.join('\n'), 3_200)
}

function renderGenericInputPreview(input: unknown): string | undefined {
    try {
        const sanitized = sanitizeInput(input, 0, new WeakSet<object>())
        const text = JSON.stringify(sanitized, null, 2)
        return text ? truncate(text, MAX_GENERIC_INPUT_PREVIEW) : undefined
    } catch {
        return undefined
    }
}

function sanitizeInput(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (typeof value === 'string') return truncate(value, 300)
    if (value === null || typeof value !== 'object') return value
    if (seen.has(value)) return '[Circular]'
    if (depth >= 4) return '[Nested value]'
    seen.add(value)

    if (Array.isArray(value)) {
        return value.slice(0, 10).map(item => sanitizeInput(item, depth + 1, seen))
    }

    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .slice(0, 16)
            .map(([key, item]) => [
                key,
                SENSITIVE_INPUT_KEY.test(key) ? '[REDACTED]' : sanitizeInput(item, depth + 1, seen),
            ]),
    )
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function truncate(value: string, maxLength: number): string {
    return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`
}

function getExitPlanContent(
    input: Record<string, unknown> | undefined,
    displayTitle: string | undefined,
    content: ToolBubbleState['content'],
    output: string | undefined,
): string | null {
    const planContent = input?.plan ?? input?.content ?? displayTitle ?? output ?? getContentText(content)
    return typeof planContent === 'string' && planContent.trim() ? planContent.trim() : null
}

function getContentText(content: ToolBubbleState['content']): string | undefined {
    const text = content
        ?.flatMap(item => item.type === 'content' && item.text?.trim() ? [item.text.trim()] : [])
        .join('\n')
        .trim()
    return text || undefined
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

function renderSafeToolSummary(name: string, output: string, isError: boolean): string | null {
    if (name === 'Glob' || name === 'Grep') {
        const summary = output.trim()
        if (/^\d+ (matches|match|files|file)( \(truncated\))?$/.test(summary)) {
            return `${isError ? '❌' : '✅'} ${escapeHtml(summary)}`
        }
    }

    return isError ? '❌' : null
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
