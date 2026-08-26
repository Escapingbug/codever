import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import type { AgentPermissionResult } from '@/providers/provider'

const CODEBUDDY_TOOL_NAME_META_KEY = 'codebuddy.ai/toolName'

export interface CodebuddyQuestionOption {
    label: string
    description?: string
}

export interface CodebuddyQuestion {
    question: string
    header: string
    options: CodebuddyQuestionOption[]
    multiSelect: boolean
}

export interface CodebuddyAskUserQuestionInput {
    input: Record<string, unknown>
    questions: CodebuddyQuestion[]
}

export function resolveCodebuddyPermissionToolName(toolCall: RequestPermissionRequest['toolCall']): string | undefined {
    const meta = asRecord(toolCall._meta)
    const toolName = meta?.[CODEBUDDY_TOOL_NAME_META_KEY]
    return typeof toolName === 'string' && toolName.trim() ? toolName.trim() : undefined
}

export function parseCodebuddyAskUserQuestion(
    toolName: string,
    input: unknown,
): CodebuddyAskUserQuestionInput | undefined {
    if (!isAskUserQuestionToolName(toolName)) return undefined

    const parsedInput = parseMaybeJson(input)
    const record = asRecord(parsedInput)
    if (!record || !Array.isArray(record.questions)) return undefined

    const questions = record.questions.slice(0, 4).flatMap(parseQuestion)
    if (questions.length === 0) return undefined

    return { input: record, questions }
}

export function addCodebuddyAnswersToPermissionResponse(
    response: RequestPermissionResponse,
    result: AgentPermissionResult,
): RequestPermissionResponse {
    const updatedInput = asRecord(result.updatedInput)
    const rawAnswers = asRecord(updatedInput?.answers)
    if (!rawAnswers) return response

    const answers = Object.fromEntries(
        Object.entries(rawAnswers).flatMap(([question, answer]) => {
            return typeof answer === 'string' ? [[question, answer]] : []
        }),
    )
    if (Object.keys(answers).length === 0) return response

    // CodeBuddy extends ACP's permission response with top-level answers for
    // AskUserQuestion. Keep this vendor field inside the CodeBuddy adapter.
    return { ...response, answers } as RequestPermissionResponse
}

function parseQuestion(value: unknown): CodebuddyQuestion[] {
    const record = asRecord(value)
    const question = stringValue(record?.question)
    if (!record || !question || !Array.isArray(record.options)) return []

    const options = record.options.slice(0, 4).flatMap(parseOption)
    if (options.length === 0) return []

    return [{
        question,
        header: stringValue(record.header) ?? 'Question',
        options,
        multiSelect: record.multiSelect === true,
    }]
}

function parseOption(value: unknown): CodebuddyQuestionOption[] {
    const record = asRecord(value)
    const label = stringValue(record?.label)
    if (!record || !label) return []
    const description = stringValue(record.description)
    return [{ label, ...(description ? { description } : {}) }]
}

function isAskUserQuestionToolName(toolName: string): boolean {
    return toolName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '') === 'askuserquestion'
}

function parseMaybeJson(value: unknown): unknown {
    if (typeof value !== 'string') return value
    try {
        return JSON.parse(value)
    } catch {
        return value
    }
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
}
