import type {
    SessionNotification,
    SessionUpdate,
    ContentChunk,
    ToolCall as AcpToolCall,
    ToolCallUpdate as AcpToolCallUpdate,
    ToolCallLocation as AcpToolCallLocation,
    ToolCallContent as AcpToolCallContent,
    TextContent,
    ContentBlock,
    Diff,
} from '@agentclientprotocol/sdk'
import type { AgentEvent, AgentResultEvent, AgentCommandsUpdateEvent, ToolResultContentBlock } from '@/providers/types'
import { unwrapToolOutput } from '@/utils/unwrapToolOutput'

const TOOL_NAME_ALIASES: Record<string, string> = {
    bash: 'Bash',
    read: 'Read',
    'read file': 'Read',
    read_file: 'Read',
    edit: 'Edit',
    'edit file': 'Edit',
    edit_file: 'Edit',
    write: 'Write',
    'write file': 'Write',
    write_file: 'Write',
    terminal: 'Bash',
    shell: 'Bash',
    command: 'Bash',
    run_command: 'Bash',
    glob: 'Glob',
    grep: 'Grep',
    agent: 'Agent',
    websearch: 'WebSearch',
    web_search: 'WebSearch',
    'web search': 'WebSearch',
    webfetch: 'WebFetch',
    web_fetch: 'WebFetch',
    todowrite: 'TodoWrite',
    todo_write: 'TodoWrite',
    'todo write': 'TodoWrite',
    todo: 'TodoWrite',
    exitplanmode: 'ExitPlanMode',
    exit_plan_mode: 'ExitPlanMode',
    task: 'Task',
    skill: 'Skill',
    'loaded skill': 'Skill',
}

/** Canonical ACP tool names (normalized) that we trust as real tool names */
const KNOWN_CANONICAL_TOOL_NAMES = new Set([
    'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
    'WebSearch', 'WebFetch', 'TodoWrite', 'ExitPlanMode',
    'Task', 'Skill', 'Agent',
])

/** Check if a title string looks like a trusted canonical tool name */
function isKnownToolName(title: string): boolean {
    if (!title) return false
    // Check exact match first
    if (KNOWN_CANONICAL_TOOL_NAMES.has(title)) return true
    // Check alias normalization
    const normalized = title.toLowerCase()
    return normalized in TOOL_NAME_ALIASES
}

export type AcpDebugLog = (line: string) => void

const ACP_DEBUG_MAX_STRING_LENGTH = 48
const ACP_DEBUG_MAX_ARRAY_ITEMS = 20
const ACP_DEBUG_MAX_OBJECT_KEYS = 30
const ACP_DEBUG_MAX_DEPTH = 6

function normalizeToolName(title: string): string {
    return TOOL_NAME_ALIASES[title.toLowerCase()] || title
}

export function statusIndicatesComplete(status: unknown): boolean {
    if (typeof status !== 'string') return false
    const normalized = status.toLowerCase()
    return (
        normalized.includes('complete') ||
        normalized.includes('done') ||
        normalized.includes('success') ||
        normalized.includes('failed') ||
        normalized.includes('error') ||
        normalized.includes('cancel')
    )
}

export function statusIndicatesError(status: unknown): boolean {
    if (typeof status !== 'string') return false
    const normalized = status.toLowerCase()
    return normalized.includes('fail') || normalized.includes('error')
}

function mapLocations(locations: AcpToolCallLocation[] | undefined | null): Array<{ path: string; line?: number }> | undefined {
    if (!locations || locations.length === 0) return undefined
    return locations.map((loc) => ({
        path: loc.path,
        ...(loc.line != null ? { line: loc.line } : {}),
    }))
}

function mapContentBlocks(content: AcpToolCallContent[] | undefined | null): ToolResultContentBlock[] | undefined {
    if (!content || content.length === 0) return undefined
    return content.map((item): ToolResultContentBlock => {
        if (item.type === 'content') {
            const c = item as { content: ContentBlock; type: 'content' }
            return {
                type: 'content',
                contentType: c.content.type,
                ...(c.content.type === 'text' ? { text: (c.content as TextContent & { type: 'text' }).text } : {}),
            }
        }
        if (item.type === 'diff') {
            const d = item as Diff & { type: 'diff' }
            return {
                type: 'diff',
                path: d.path,
                oldText: d.oldText ?? undefined,
                newText: d.newText,
            }
        }
        if (item.type === 'terminal') {
            const t = item as { terminalId?: string; type: 'terminal' }
            return {
                type: 'terminal',
                ...(t.terminalId ? { terminalId: t.terminalId } : {}),
            }
        }
        return { type: 'content', contentType: 'unknown' }
    })
}

export async function* adaptAcpSessionUpdates(
    updates: AsyncIterable<SessionNotification>,
): AsyncGenerator<AgentEvent> {
    for await (const notification of updates) {
        const events = mapSessionUpdate(notification.update)
        for (const event of events) {
            yield event
        }
    }
}

export function mapSessionUpdate(update: SessionUpdate, debugLog?: AcpDebugLog): AgentEvent[] {
    const events: AgentEvent[] = []
    logAcpDebugUpdate(update, debugLog)

    switch (update.sessionUpdate) {
        case 'agent_message_chunk': {
            const chunk = update as ContentChunk & { sessionUpdate: 'agent_message_chunk' }
            const block = chunk.content
            if (block.type === 'text') {
                const textContent = block as TextContent & { type: 'text' }
                events.push({
                    kind: 'text',
                    text: textContent.text,
                })
            } else if (block.type === 'resource') {
                events.push({
                    kind: 'raw',
                    providerName: 'acp',
                    rawMessage: block,
                })
            } else if (block.type === 'resource_link' || block.type === 'image' || block.type === 'audio') {
                events.push({
                    kind: 'raw',
                    providerName: 'acp',
                    rawMessage: block,
                })
            }
            break
        }

        case 'agent_thought_chunk': {
            events.push({
                kind: 'raw',
                providerName: 'acp',
                rawMessage: update,
            })
            break
        }

        case 'user_message_chunk': {
            break
        }

        case 'tool_call': {
            const toolCall = update as AcpToolCall & { sessionUpdate: 'tool_call' }
            const rawTitle = toolCall.title ?? ''
            const normalizedTitle = rawTitle.toLowerCase()

            // OpenCode sends "available_commands_update" as a tool_call title
            // Convert it to a proper commands_update event
            if (normalizedTitle === 'available_commands_update' || normalizedTitle === 'available commands update') {
                const rawInput = parseRawInput(toolCall.rawInput)
                const commands = Array.isArray(rawInput) ? rawInput : []
                events.push({
                    kind: 'commands_update',
                    commands: commands.map((c: any) => ({
                        name: c.name ?? c.command ?? '',
                        description: c.description ?? '',
                        inputHint: c.input?.hint ?? c.inputHint ?? null,
                    })),
                } as AgentCommandsUpdateEvent)
                break
            }

            // Determine canonical toolName and displayTitle
            // rawTitle might be the real tool name OR a file path / descriptive title
            const inferredToolName = inferToolNameFromKind(toolCall.kind)
            const isKnown = isKnownToolName(rawTitle)
            const toolName = isKnown ? normalizeToolName(rawTitle) : inferredToolName ?? 'tool_call'
            // IMPORTANT: Do NOT use generic 'tool_call'/'tool' as displayTitle
            const isGenericTitle = !rawTitle || rawTitle === 'tool_call' || rawTitle === 'tool'
            const displayTitle = isKnown ? undefined : (isGenericTitle ? undefined : rawTitle)
            const locations = mapLocations(toolCall.locations)
            const input = normalizeToolInput(toolName, toolCall.rawInput, locations)

            events.push({
                kind: 'tool_use',
                toolName,
                toolUseId: toolCall.toolCallId,
                input,
                status: mapToolCallStatus(toolCall.status),
                ...(toolCall.rawInput != null ? { rawInput: typeof toolCall.rawInput === 'string' ? toolCall.rawInput : JSON.stringify(toolCall.rawInput) } : {}),
                isInputComplete: statusIndicatesComplete(toolCall.status),
                ...(toolCall.kind ? { toolKind: toolCall.kind } : {}),
                locations,
                ...(displayTitle ? { displayTitle } : {}),
            })
            break
        }

        case 'tool_call_update': {
            const toolUpdate = update as AcpToolCallUpdate & { sessionUpdate: 'tool_call_update' }
            const rawTitle = toolUpdate.title ?? ''
            const normalizedTitle = rawTitle.toLowerCase()

            // Skip available_commands_update tool_call_update events entirely.
            // The commands_update was already emitted from the tool_call case.
            if (normalizedTitle === 'available_commands_update' || normalizedTitle === 'available commands update') {
                break
            }

            const isTerminal = toolUpdate.status === 'completed' || toolUpdate.status === 'failed'
            const inferredToolName = inferToolNameFromKind(toolUpdate.kind ?? undefined)
            const isKnown = isKnownToolName(rawTitle)

            if (isTerminal) {
                // For terminal events (completed/failed), do NOT blindly derive canonical toolName from title.
                // Only set toolName if the title is a known/canonical tool name.
                // Otherwise omit toolName and set displayTitle so the projector can merge with prior state.
                const toolName = isKnown ? normalizeToolName(rawTitle) : undefined
                const output = extractToolOutput(toolUpdate)
                const exitPlanContent = toolName === 'ExitPlanMode'
                    ? extractExitPlanModePlan(toolUpdate, output)
                    : undefined
                const displayTitle = exitPlanContent ?? (isKnown ? undefined : (rawTitle || undefined))
                const locations = mapLocations(toolUpdate.locations ?? undefined)
                const input = normalizeToolInput(toolName, toolUpdate.rawInput, locations)

                if (input !== undefined || locations !== undefined || toolUpdate.kind) {
                    events.push({
                        kind: 'tool_use',
                        toolName: toolName ?? inferredToolName ?? 'tool_call',
                        toolUseId: toolUpdate.toolCallId,
                        input,
                        status: 'running',
                        ...(toolUpdate.rawInput != null ? { rawInput: typeof toolUpdate.rawInput === 'string' ? toolUpdate.rawInput : JSON.stringify(toolUpdate.rawInput) } : {}),
                        isInputComplete: true,
                        ...(toolUpdate.kind ? { toolKind: toolUpdate.kind } : {}),
                        locations,
                        ...(displayTitle ? { displayTitle } : {}),
                    })
                }

                events.push({
                    kind: 'tool_result',
                    toolUseId: toolUpdate.toolCallId,
                    output: exitPlanContent ?? output,
                    isError: statusIndicatesError(toolUpdate.status),
                    ...(toolName ? { toolName } : {}),
                    ...(displayTitle ? { displayTitle } : {}),
                    ...(toolUpdate.rawOutput != null ? { structuredOutput: toolUpdate.rawOutput } : {}),
                    content: mapContentBlocks(toolUpdate.content ?? undefined),
                })
            } else {
                // For non-terminal updates, title might be a file path or descriptive text.
                // Only use as canonical toolName if it's a known tool name.
                // Otherwise use 'tool_call' as generic and store title as displayTitle.
                // IMPORTANT: Do NOT use generic 'tool_call'/'tool' as displayTitle - it's not descriptive.
                const toolName = isKnown ? normalizeToolName(rawTitle) : inferredToolName ?? 'tool_call'
                const isGenericTitle = !rawTitle || rawTitle === 'tool_call' || rawTitle === 'tool'
                const displayTitle = isKnown ? undefined : (isGenericTitle ? undefined : rawTitle)
                const locations = mapLocations(toolUpdate.locations ?? undefined)
                const input = normalizeToolInput(toolName, toolUpdate.rawInput, locations)

                events.push({
                    kind: 'tool_use',
                    toolName,
                    toolUseId: toolUpdate.toolCallId,
                    input,
                    status: mapToolCallStatus(toolUpdate.status ?? undefined),
                    ...(toolUpdate.rawInput != null ? { rawInput: typeof toolUpdate.rawInput === 'string' ? toolUpdate.rawInput : JSON.stringify(toolUpdate.rawInput) } : {}),
                    isInputComplete: statusIndicatesComplete(toolUpdate.status),
                    ...(toolUpdate.kind ? { toolKind: toolUpdate.kind } : {}),
                    locations,
                    ...(displayTitle ? { displayTitle } : {}),
                })
            }
            break
        }

        case 'plan':
        case 'current_mode_update':
        case 'config_option_update':
        case 'session_info_update':
        case 'usage_update': {
            events.push({
                kind: 'raw',
                providerName: 'acp',
                rawMessage: update,
            })
            break
        }

        case 'available_commands_update': {
            const cmds = (update as any).availableCommands as Array<{
                name: string
                description: string
                input?: { hint: string } | null
            }> | undefined
            events.push({
                kind: 'commands_update',
                commands: (cmds ?? []).map(c => ({
                    name: c.name,
                    description: c.description,
                    inputHint: c.input?.hint ?? null,
                })),
            } as AgentCommandsUpdateEvent)
            break
        }

        default: {
            events.push({
                kind: 'raw',
                providerName: 'acp',
                rawMessage: update,
            })
            break
        }
    }

    return events
}

function logAcpDebugUpdate(update: SessionUpdate, debugLog?: AcpDebugLog): void {
    if (!debugLog || shouldSkipAcpDebugUpdate(update)) return
    debugLog(`[ACP-DEBUG] ${safeStringifyForAcpDebug(update)}`)
}

function shouldSkipAcpDebugUpdate(update: SessionUpdate): boolean {
    if (update.sessionUpdate === 'user_message_chunk') return true
    if (update.sessionUpdate === 'agent_thought_chunk') return true

    if (update.sessionUpdate === 'agent_message_chunk') {
        const chunk = update as ContentChunk & { sessionUpdate: 'agent_message_chunk' }
        return chunk.content?.type === 'text'
    }

    return false
}

function safeStringifyForAcpDebug(value: unknown): string {
    try {
        return JSON.stringify(truncateForAcpDebug(value, 0, new WeakSet<object>()))
    } catch {
        return JSON.stringify({ error: 'failed_to_stringify_acp_update', sessionUpdate: (value as { sessionUpdate?: unknown })?.sessionUpdate })
    }
}

function truncateForAcpDebug(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (typeof value === 'string') {
        if (value.length <= ACP_DEBUG_MAX_STRING_LENGTH) return value
        return `${value.slice(0, ACP_DEBUG_MAX_STRING_LENGTH)}…(${value.length} chars)`
    }

    if (value === null || typeof value !== 'object') return value

    if (seen.has(value)) return '[Circular]'
    if (depth >= ACP_DEBUG_MAX_DEPTH) return '[MaxDepth]'
    seen.add(value)

    if (Array.isArray(value)) {
        const items = value.slice(0, ACP_DEBUG_MAX_ARRAY_ITEMS).map(item => truncateForAcpDebug(item, depth + 1, seen))
        if (value.length > ACP_DEBUG_MAX_ARRAY_ITEMS) {
            items.push(`…(${value.length - ACP_DEBUG_MAX_ARRAY_ITEMS} more items)`)
        }
        return items
    }

    const out: Record<string, unknown> = {}
    const entries = Object.entries(value as Record<string, unknown>)
    for (const [key, item] of entries.slice(0, ACP_DEBUG_MAX_OBJECT_KEYS)) {
        out[key] = truncateForAcpDebug(item, depth + 1, seen)
    }
    if (entries.length > ACP_DEBUG_MAX_OBJECT_KEYS) {
        out.__truncatedKeys = entries.length - ACP_DEBUG_MAX_OBJECT_KEYS
    }
    return out
}

function mapToolCallStatus(status: string | undefined | null): 'pending' | 'running' | undefined {
    if (status === 'pending') return 'pending'
    if (status === 'in_progress') return 'running'
    return undefined
}

function looksLikeJsonStringify(str: string): boolean {
    const trimmed = str.trim()
    return (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
           (trimmed.startsWith('[') && trimmed.endsWith(']'))
}

function formatMetadata(metadata: Record<string, unknown>): string {
    const entries = Object.entries(metadata)
        .filter(([, v]) => v != null)
        .map(([key, value]) => {
            const val = typeof value === 'string' ? value : JSON.stringify(value)
            return `${key}: ${val}`
        })
    return entries.join('\n')
}

function extractToolOutput(toolUpdate: AcpToolCallUpdate): string {
    if (toolUpdate.rawOutput !== undefined && toolUpdate.rawOutput !== null) {
        if (typeof toolUpdate.rawOutput === 'string') return unwrapToolOutput(toolUpdate.rawOutput)

        if (typeof toolUpdate.rawOutput === 'object') {
            const raw = toolUpdate.rawOutput as Record<string, unknown>
            const statsOutput = formatSearchStatsOutput(raw)
            if (statsOutput) return statsOutput

            const mainOutput = unwrapToolOutput(raw)

            // 如果主输出有效且不是 JSON stringify 的结果，直接返回
            if (mainOutput && !looksLikeJsonStringify(mainOutput)) {
                return mainOutput
            }

            // 尝试从 metadata 提取友好输出
            if (raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)) {
                return formatMetadata(raw.metadata as Record<string, unknown>)
            }

            // fallback: 如果主输出非空，返回主输出；否则返回空字符串
            return mainOutput || ''
        }

        return String(toolUpdate.rawOutput)
    }

    if (toolUpdate.content && toolUpdate.content.length > 0) {
        const parts: string[] = []
        for (const item of toolUpdate.content) {
            if (item.type === 'content') {
                const content = item as { content: ContentBlock; type: 'content' }
                if (content.content.type === 'text') {
                    parts.push((content.content as TextContent & { type: 'text' }).text)
                } else {
                    parts.push(JSON.stringify(content.content))
                }
            } else if (item.type === 'diff') {
                parts.push(JSON.stringify(item))
            } else {
                parts.push(JSON.stringify(item))
            }
        }
        return parts.join('\n')
    }

    return ''
}

function formatSearchStatsOutput(raw: Record<string, unknown>): string | undefined {
    const totalMatches = raw.totalMatches
    if (typeof totalMatches === 'number') {
        return `${totalMatches} match${totalMatches === 1 ? '' : 'es'}${raw.truncated === true ? ' (truncated)' : ''}`
    }

    const totalFiles = raw.totalFiles
    if (typeof totalFiles === 'number') {
        return `${totalFiles} file${totalFiles === 1 ? '' : 's'}${raw.truncated === true ? ' (truncated)' : ''}`
    }

    return undefined
}

function extractExitPlanModePlan(toolUpdate: AcpToolCallUpdate, fallbackOutput: string): string | undefined {
    return extractPlanString(toolUpdate.rawOutput)
        ?? extractPlanString(toolUpdate.rawInput)
        ?? extractPlanFromContentBlocks(toolUpdate.content ?? undefined)
        ?? (fallbackOutput.trim() && !looksLikeJsonStringify(fallbackOutput) ? fallbackOutput.trim() : undefined)
}

function extractPlanFromContentBlocks(content: AcpToolCallContent[] | undefined | null): string | undefined {
    const text = content
        ?.flatMap((item) => {
            if (item.type !== 'content') return []
            const c = item as { content: ContentBlock; type: 'content' }
            if (c.content.type !== 'text') return []
            const textContent = c.content as TextContent & { type: 'text' }
            return textContent.text?.trim() ? [textContent.text.trim()] : []
        })
        .join('\n')

    return text || undefined
}

function extractPlanString(value: unknown): string | undefined {
    if (typeof value === 'string') {
        const trimmed = value.trim()
        if (!trimmed) return undefined
        try {
            return extractPlanString(JSON.parse(trimmed))
        } catch {
            return trimmed
        }
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined

    const record = value as Record<string, unknown>
    for (const key of ['plan', 'content', 'text', 'description', 'output', 'result', 'message']) {
        const extracted = extractPlanString(record[key])
        if (extracted) return extracted
    }

    return undefined
}

function inferToolNameFromKind(kind: unknown): string | undefined {
    if (typeof kind !== 'string') return undefined
    switch (kind) {
        case 'read':
            return 'Read'
        case 'edit':
            return 'Edit'
        case 'execute':
            return 'Bash'
        case 'search':
            return 'Grep'
        case 'fetch':
            return 'WebFetch'
        default:
            return undefined
    }
}

function normalizeToolInput(
    toolName: string | undefined,
    rawInput: unknown,
    locations: Array<{ path: string; line?: number }> | undefined,
): unknown {
    const parsed = rawInput != null ? parseRawInput(rawInput) : undefined
    const normalizedName = toolName ? normalizeToolName(toolName) : undefined
    const record = asInputRecord(parsed)

    if (normalizedName === 'Bash') {
        const command = pickStringFromRecord(record, ['command', 'cmd', 'script'])
            ?? (typeof parsed === 'string' ? parsed : undefined)
        if (command) return { ...(record ?? {}), command }
        return parsed
    }

    if (normalizedName === 'Read' || normalizedName === 'Edit' || normalizedName === 'Write') {
        const filePath = pickStringFromRecord(record, ['file_path', 'filePath', 'path', 'target_file', 'targetFile'])
            ?? (typeof parsed === 'string' ? parsed : undefined)
            ?? locations?.[0]?.path
        if (filePath) return { ...(record ?? {}), file_path: filePath }
        return parsed
    }

    return parsed
}

function asInputRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
}

function pickStringFromRecord(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
    if (!record) return undefined
    for (const key of keys) {
        const value = record[key]
        if (typeof value === 'string' && value.trim()) return value
    }
    return undefined
}

export function parseRawInput(rawInput: unknown): unknown {
    if (typeof rawInput === 'string') {
        try {
            return JSON.parse(rawInput)
        } catch {
            return rawInput
        }
    }
    return rawInput
}

export function adaptStopReason(stopReason: string): AgentResultEvent {
    switch (stopReason) {
        case 'end_turn':
            return { kind: 'result', status: 'success' }
        case 'cancelled':
            return { kind: 'result', status: 'error', summary: 'Interrupted' }
        case 'max_tokens':
        case 'max_turn_requests':
            return { kind: 'result', status: 'max_turns' }
        case 'refusal':
            return { kind: 'result', status: 'error', summary: 'Agent refused' }
        default:
            return { kind: 'result', status: 'error', summary: `Unknown stop reason: ${stopReason}` }
    }
}
