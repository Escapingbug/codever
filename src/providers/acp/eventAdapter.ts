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

export function mapSessionUpdate(update: SessionUpdate): AgentEvent[] {
    const events: AgentEvent[] = []

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

            events.push({
                kind: 'tool_use',
                toolName: normalizeToolName(rawTitle),
                toolUseId: toolCall.toolCallId,
                input: parseRawInput(toolCall.rawInput),
                status: mapToolCallStatus(toolCall.status),
                ...(toolCall.rawInput != null ? { rawInput: typeof toolCall.rawInput === 'string' ? toolCall.rawInput : JSON.stringify(toolCall.rawInput) } : {}),
                isInputComplete: statusIndicatesComplete(toolCall.status),
                ...(toolCall.kind ? { toolKind: toolCall.kind } : {}),
                locations: mapLocations(toolCall.locations),
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

            if (isTerminal) {
                const output = extractToolOutput(toolUpdate)
                const toolName = toolUpdate.title ? normalizeToolName(toolUpdate.title) : undefined
                events.push({
                    kind: 'tool_result',
                    toolUseId: toolUpdate.toolCallId,
                    output,
                    isError: statusIndicatesError(toolUpdate.status),
                    ...(toolName ? { toolName } : {}),
                    ...(toolUpdate.rawOutput != null ? { structuredOutput: toolUpdate.rawOutput } : {}),
                    content: mapContentBlocks(toolUpdate.content ?? undefined),
                })
            } else {
                const toolName = toolUpdate.title ? normalizeToolName(toolUpdate.title) : undefined
                events.push({
                    kind: 'tool_use',
                    toolName: toolName ?? 'tool_call',
                    toolUseId: toolUpdate.toolCallId,
                    input: toolUpdate.rawInput != null ? parseRawInput(toolUpdate.rawInput) : undefined,
                    status: mapToolCallStatus(toolUpdate.status ?? undefined),
                    ...(toolUpdate.rawInput != null ? { rawInput: typeof toolUpdate.rawInput === 'string' ? toolUpdate.rawInput : JSON.stringify(toolUpdate.rawInput) } : {}),
                    isInputComplete: statusIndicatesComplete(toolUpdate.status),
                    ...(toolUpdate.kind ? { toolKind: toolUpdate.kind } : {}),
                    locations: mapLocations(toolUpdate.locations ?? undefined),
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

function mapToolCallStatus(status: string | undefined | null): 'pending' | 'running' | undefined {
    if (status === 'pending') return 'pending'
    if (status === 'in_progress') return 'running'
    return undefined
}

function extractToolOutput(toolUpdate: AcpToolCallUpdate): string {
    if (toolUpdate.rawOutput !== undefined && toolUpdate.rawOutput !== null) {
        if (typeof toolUpdate.rawOutput === 'string') return unwrapToolOutput(toolUpdate.rawOutput)
        if (typeof toolUpdate.rawOutput === 'object') return unwrapToolOutput(toolUpdate.rawOutput as Record<string, unknown>)
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
