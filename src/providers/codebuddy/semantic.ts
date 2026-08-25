import type { AgentToolUseEvent } from '@/providers/types'
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
    if (!isGenericToolName(event.toolName) || event.toolKind || event.content?.length || event.locations?.length) return false
    if (isUsefulInput(event.input) || (typeof event.rawInput === 'string' && event.rawInput.trim())) return false

    const title = event.displayTitle
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

function isUsefulInput(value: unknown): boolean {
    if (value === undefined || value === null) return false
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0) return false
    return true
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
}
