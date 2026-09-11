import type { AgentToolResultEvent, AgentToolUseEvent, ToolResultContentBlock } from '@/providers/types'
import type { TeamMemberState } from '@/runtime/semantic'

export interface CodebuddyTeamUpdate {
    action: 'team_created' | 'member_status_change' | 'team_deleted'
    teamName: string
    isAutoTeam?: boolean
    members?: TeamMemberState[]
}

export function parseCodebuddyTeamUpdate(raw: Record<string, unknown>): CodebuddyTeamUpdate | undefined {
    const providerMeta = asRecord(raw._meta)
    const update = asRecord(providerMeta?.['codebuddy.ai/teamUpdate'])
    if (!update) return undefined

    const action = update.type
    if (action !== 'team_created' && action !== 'member_status_change' && action !== 'team_deleted') return undefined

    const teamName = typeof update.teamName === 'string' ? update.teamName.trim() : ''
    if (!teamName) return undefined

    const members = Array.isArray(update.members)
        ? update.members.flatMap(parseCodebuddyTeamMember)
        : undefined

    return {
        action,
        teamName,
        ...(typeof update.isAutoTeam === 'boolean' ? { isAutoTeam: update.isAutoTeam } : {}),
        ...(members !== undefined ? { members } : {}),
    }
}

export function isCodebuddyHousekeepingTool(event: AgentToolUseEvent): boolean {
    if (!isGenericToolName(event.toolName) || !isCodebuddyHousekeepingTitle(event.displayTitle)) return false
    if (event.locations?.length || hasMeaningfulContent(event.content)) return false
    if (isMeaningfulValue(event.input) || isMeaningfulRawInput(event.rawInput)) return false

    return true
}

export function isCodebuddyHousekeepingResult(event: AgentToolResultEvent): boolean {
    if (!isGenericToolName(event.toolName) || !isCodebuddyHousekeepingTitle(event.displayTitle)) return false
    if (event.isError || hasMeaningfulContent(event.content)) return false
    if (isMeaningfulValue(event.output) || isMeaningfulValue(event.structuredOutput)) return false

    return true
}

function isCodebuddyHousekeepingTitle(displayTitle: string | undefined): boolean {
    const title = displayTitle
        ?.trim()
        .toLowerCase()
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')

    return title === 'session info'
        || title === 'session info update'
        || title === 'static update'
        || title === 'status update'
        || title === 'usage update'
}

function parseCodebuddyTeamMember(value: unknown): TeamMemberState[] {
    const member = asRecord(value)
    const name = typeof member?.name === 'string' ? member.name.trim() : ''
    if (!member || !name) return []

    const tokenUsageRecord = asRecord(member.tokenUsage)
    const tokenUsage = tokenUsageRecord
        ? compactObject({
            inputTokens: finiteNumber(tokenUsageRecord.inputTokens),
            outputTokens: finiteNumber(tokenUsageRecord.outputTokens),
            lastContextWindow: finiteNumber(tokenUsageRecord.lastContextWindow),
        })
        : undefined
    const toolCallCount = finiteNumber(member.toolCallCount)

    return [{
        name,
        ...stringField(member, 'color'),
        ...stringField(member, 'description'),
        ...stringField(member, 'status'),
        ...stringField(member, 'taskId'),
        ...stringField(member, 'sessionId'),
        ...(tokenUsage && Object.keys(tokenUsage).length > 0 ? { tokenUsage } : {}),
        ...(toolCallCount !== undefined ? { toolCallCount } : {}),
    }]
}

function stringField<Key extends 'color' | 'description' | 'status' | 'taskId' | 'sessionId'>(record: Record<string, unknown>, key: Key): Partial<Pick<TeamMemberState, Key>> {
    const value = record[key]
    return typeof value === 'string' && value.trim() ? { [key]: value.trim() } as Partial<Pick<TeamMemberState, Key>> : {}
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function compactObject<T extends Record<string, unknown>>(record: T): Partial<T> {
    return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as Partial<T>
}

function isGenericToolName(toolName: string | undefined): boolean {
    return !toolName || toolName === 'tool' || toolName === 'tool_call'
}

function isMeaningfulValue(value: unknown): boolean {
    if (value === undefined || value === null) return false
    if (typeof value === 'string') return value.trim().length > 0
    if (Array.isArray(value)) return value.some(isMeaningfulValue)
    if (typeof value === 'object') return Object.values(value as Record<string, unknown>).some(isMeaningfulValue)
    return true
}

function isMeaningfulRawInput(rawInput: string | undefined): boolean {
    if (!rawInput?.trim()) return false
    try {
        return isMeaningfulValue(JSON.parse(rawInput))
    } catch {
        return true
    }
}

function hasMeaningfulContent(content: ToolResultContentBlock[] | undefined): boolean {
    return content?.some(block => {
        if (block.type === 'content') return Boolean(block.text?.trim())
        if (block.type === 'diff') return Boolean(block.path?.trim() || block.oldText?.trim() || block.newText?.trim())
        return Boolean(block.terminalId?.trim())
    }) ?? false
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
}
