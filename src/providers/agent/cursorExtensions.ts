import type { AcpExtensionHandler } from '@/providers/acp/AcpClientManager'
import type { AgentQueryConfig } from '@/providers/provider'
import type { AgentEvent } from '@/providers/types'
import type { PushableAsyncIterable } from '@/utils/PushableAsyncIterable'

const CURSOR_CREATE_PLAN = 'cursor/create_plan'
const CURSOR_ASK_QUESTION = 'cursor/ask_question'
const CURSOR_UPDATE_TODOS = 'cursor/update_todos'
const CURSOR_TASK = 'cursor/task'
const CURSOR_GENERATE_IMAGE = 'cursor/generate_image'

export function createCursorAcpExtensionHandler(
    events: PushableAsyncIterable<AgentEvent>,
    config: AgentQueryConfig,
): AcpExtensionHandler {
    return {
        extMethod: async (method, params) => {
            switch (method) {
                case CURSOR_CREATE_PLAN:
                    return handleCreatePlan(params, events, config)
                case CURSOR_ASK_QUESTION:
                    return handleAskQuestion(params, config)
                default:
                    console.error(`[agent] Unhandled Cursor extension method: ${method}`)
                    return {}
            }
        },
        extNotification: async (method, params) => {
            switch (method) {
                case CURSOR_UPDATE_TODOS:
                    pushTodos(params, events, method)
                    return
                case CURSOR_TASK:
                    pushTask(params, events)
                    return
                case CURSOR_GENERATE_IMAGE:
                    pushGeneratedImage(params, events)
                    return
                default:
                    console.error(`[agent] Unhandled Cursor extension notification: ${method}`)
            }
        },
    }
}

async function handleCreatePlan(
    params: Record<string, unknown>,
    events: PushableAsyncIterable<AgentEvent>,
    config: AgentQueryConfig,
): Promise<Record<string, unknown>> {
    pushTodos(params, events, CURSOR_CREATE_PLAN)

    if (!config.decisionHandler) {
        return { outcome: { outcome: 'accepted' } }
    }

    const title = pickString(params, ['name', 'title']) ?? 'Review plan'
    const overview = pickString(params, ['overview', 'description'])
    const markdown = pickString(params, ['markdown', 'plan', 'content'])
    const details = [overview, markdown].filter(Boolean).join('\n\n')
    const response = await config.decisionHandler.requestDecision({
        type: 'question',
        title,
        details,
        options: [
            { label: 'Accept', value: 'accepted' },
            { label: 'Reject', value: 'rejected' },
        ],
    })

    return response.value === 'rejected'
        ? { outcome: { outcome: 'rejected' } }
        : { outcome: { outcome: 'accepted' } }
}

async function handleAskQuestion(
    params: Record<string, unknown>,
    config: AgentQueryConfig,
): Promise<Record<string, unknown>> {
    const questions = extractQuestions(params)
    const firstQuestion = questions[0]
    if (!config.decisionHandler || !firstQuestion) {
        return { outcome: { outcome: 'skipped', reason: 'No supported question UI available' } }
    }

    const title = pickString(params, ['title', 'name']) ?? firstQuestion.text ?? 'Question'
    const response = await config.decisionHandler.requestDecision({
        type: 'question',
        title,
        details: firstQuestion.text && firstQuestion.text !== title ? firstQuestion.text : undefined,
        options: firstQuestion.options.map(option => ({
            label: option.label,
            value: `${firstQuestion.id}:${option.id}`,
        })),
    })

    const [questionId, optionId] = response.value.split(':')
    if (!questionId || !optionId) {
        return { outcome: { outcome: 'skipped', reason: 'No option selected' } }
    }

    return {
        outcome: {
            outcome: 'answered',
            answers: [{ questionId, selectedOptionIds: [optionId] }],
        },
    }
}

function pushTodos(params: Record<string, unknown>, events: PushableAsyncIterable<AgentEvent>, method: string): void {
    const todos = extractTodos(params)
    if (todos.length === 0) return

    events.push({
        kind: 'tool_use',
        toolName: 'TodoWrite',
        toolUseId: stableExtensionId(method),
        input: { todos },
        status: 'running',
        isInputComplete: true,
        displayTitle: pickString(params, ['name', 'title']) ?? undefined,
    })
}

function pushTask(params: Record<string, unknown>, events: PushableAsyncIterable<AgentEvent>): void {
    const description = pickString(params, ['description', 'summary', 'title', 'name']) ?? 'Cursor task'
    const taskId = pickString(params, ['taskId', 'id']) ?? stableExtensionId(CURSOR_TASK)
    events.push({
        kind: 'tool_use',
        toolName: 'Task',
        toolUseId: taskId,
        input: {
            description,
            subagent_type: pickString(params, ['subagentType', 'subagent_type', 'type']),
        },
        status: 'running',
        isInputComplete: true,
    })
    events.push({
        kind: 'tool_result',
        toolName: 'Task',
        toolUseId: taskId,
        output: pickString(params, ['result', 'output', 'message']) ?? description,
        isError: false,
    })
}

function pushGeneratedImage(params: Record<string, unknown>, events: PushableAsyncIterable<AgentEvent>): void {
    const url = pickString(params, ['url', 'uri', 'path'])
    const description = pickString(params, ['description', 'prompt', 'title'])
    const text = url
        ? `Generated image: ${url}${description ? `\n${description}` : ''}`
        : `Generated image${description ? `: ${description}` : ''}`
    events.push({ kind: 'text', text })
}

function extractTodos(params: Record<string, unknown>): Array<{ content: string; status: string }> {
    const rawTodos = Array.isArray(params.todos) ? params.todos : []
    return rawTodos.flatMap((todo) => {
        const record = asRecord(todo)
        if (!record) return []
        const content = pickString(record, ['content', 'title', 'text', 'description'])
        if (!content) return []
        return [{
            content,
            status: normalizeTodoStatus(pickString(record, ['status', 'state']) ?? 'pending'),
        }]
    })
}

function extractQuestions(params: Record<string, unknown>): Array<{
    id: string
    text?: string
    options: Array<{ id: string; label: string }>
}> {
    const rawQuestions = Array.isArray(params.questions) ? params.questions : []
    return rawQuestions.flatMap((question, questionIndex) => {
        const record = asRecord(question)
        if (!record) return []
        const options = Array.isArray(record.options) ? record.options : []
        const parsedOptions = options.flatMap((option, optionIndex) => {
            const optionRecord = asRecord(option)
            if (!optionRecord) return []
            const id = pickString(optionRecord, ['id', 'value']) ?? `option-${optionIndex}`
            const label = pickString(optionRecord, ['label', 'title', 'text', 'value']) ?? id
            return [{ id, label }]
        })
        if (parsedOptions.length === 0) return []
        return [{
            id: pickString(record, ['id', 'questionId']) ?? `question-${questionIndex}`,
            text: pickString(record, ['question', 'text', 'title']),
            options: parsedOptions,
        }]
    })
}

function normalizeTodoStatus(status: string): string {
    const normalized = status.toLowerCase()
    if (normalized === 'completed' || normalized === 'done') return 'completed'
    if (normalized === 'in_progress' || normalized === 'in-progress' || normalized === 'active') return 'in_progress'
    return 'pending'
}

function stableExtensionId(method: string): string {
    return `cursor:${method}`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = record[key]
        if (typeof value === 'string' && value.trim()) return value
    }
    return undefined
}
