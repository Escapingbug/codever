import type { Bot } from 'grammy'
import { InlineKeyboard } from 'grammy'
import { escapeHtml, sanitizeXmlLikeTags } from '@/utils/formatting'
import type { AgentPermissionHandler, AgentPermissionResult, ToolCallRecord } from '@/providers/provider'
import type { AgentEvent } from '@/providers/types'
import type { EventBus } from '@/core/eventBus'
import { randomBytes } from 'node:crypto'
import { resolvePermission, decisionToResult, type PermissionMode } from '@/permissions/resolvePermission'
import { buildMessageThreadParams } from '@/bridge/sessionManager'

export interface AskQuestion {
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiSelect: boolean
}

export function permissionKeyboard(requestId: string): InlineKeyboard {
    return new InlineKeyboard()
        .text('✅ Allow', `perm:allow:${requestId}`)
        .text('✅ Always', `perm:session:${requestId}`)
        .text('❌ Deny', `perm:deny:${requestId}`)
}

export function askQuestionKeyboard(requestId: string, questions: AskQuestion[]): InlineKeyboard {
    const kb = new InlineKeyboard()
    for (let qIdx = 0; qIdx < questions.length; qIdx++) {
        const q = questions[qIdx]
        for (let oIdx = 0; oIdx < q.options.length; oIdx++) {
            kb.text(q.options[oIdx].label, `ask:${requestId}:${qIdx}:${oIdx}`).row()
        }
    }
    return kb
}

interface PendingRequest {
    resolve: (result: AgentPermissionResult) => void
    reject: (error: Error) => void
    toolName: string
    input: unknown
    questions?: AskQuestion[]
}

export class TelegramPermissionHandler implements AgentPermissionHandler {
    private pendingRequests = new Map<string, PendingRequest>()
    private toolCalls: { id: string; name: string; input: any; used: boolean }[] = []
    private toolKindMap = new Map<string, string>()
    private onPermissionRequestCallback?: (requestId: string) => void
    private onAnswerCallback?: (text: string) => void
    private approvedTools = new Set<string>()
    private _getPermissionMode?: () => PermissionMode | undefined
    private _eventBus: EventBus | null = null
    private _sessionId: string | null = null

    chatId: number
    messageThreadId: number | undefined

    constructor(private bot: Bot, chatId: number, messageThreadId?: number) {
        this.chatId = chatId
        this.messageThreadId = messageThreadId
    }

    setEventBus(bus: EventBus, sessionId: string): void {
        this._eventBus = bus
        this._sessionId = sessionId
    }

    setPermissionModeGetter(getter: () => PermissionMode | undefined): void {
        this._getPermissionMode = getter
    }

    setOnPermissionRequest(cb: (requestId: string) => void): void {
        this.onPermissionRequestCallback = cb
    }

    setOnAnswer(cb: (text: string) => void): void {
        this.onAnswerCallback = cb
    }

    handleToolCall = async (
        toolName: string,
        input: unknown,
        options: { signal: AbortSignal; recentToolCalls?: ToolCallRecord[] }
    ): Promise<AgentPermissionResult> => {
        if (this.approvedTools.has(toolName)) {
            return {
                behavior: 'allow',
                updatedInput: (input as Record<string, unknown>) || {},
            }
        }

        const mode = this._getPermissionMode?.()
        if (mode) {
            const kind = this.toolKindMap.get(toolName)
            const decision = resolvePermission(mode, { toolName, input, toolKind: kind })
            const result = decisionToResult(decision, input)
            if (result) return result
        }

        const requestId = randomBytes(8).toString('hex')

        return new Promise<AgentPermissionResult>((resolve, reject) => {
            const abortHandler = () => {
                this.pendingRequests.delete(requestId)
                reject(new Error('Permission request aborted'))
            }
            options.signal.addEventListener('abort', abortHandler, { once: true })

            this.pendingRequests.set(requestId, {
                resolve: (r) => {
                    options.signal.removeEventListener('abort', abortHandler)
                    resolve(r)
                },
                reject: (e) => {
                    options.signal.removeEventListener('abort', abortHandler)
                    reject(e)
                },
                toolName,
                input,
            })

            if (this.onPermissionRequestCallback) {
                this.onPermissionRequestCallback(requestId)
            }

            this._eventBus?.emit({
                type: 'permission.request',
                sessionId: this._sessionId ?? '',
                requestId,
                toolName,
                input,
            })

            this.sendPermissionRequest(requestId, toolName, input, options.recentToolCalls).catch(console.error)
        })
    }

    private async sendPermissionRequest(
        requestId: string,
        toolName: string,
        input: unknown,
        recentToolCalls?: ToolCallRecord[]
    ): Promise<void> {
        // Special handling for AskUserQuestion
        if (toolName === 'AskUserQuestion' && input && typeof input === 'object' && 'questions' in input) {
            const { questions } = input as { questions: AskQuestion[] }
            const pending = this.pendingRequests.get(requestId)
            if (pending) pending.questions = questions

            const lines: string[] = []
            for (const q of questions) {
                lines.push(`❓ <b>${escapeHtml(q.question)}</b>`)
                if (q.header) lines.push(`<i>${escapeHtml(q.header)}</i>`)
                lines.push('')
                for (const opt of q.options) {
                    lines.push(`• <b>${escapeHtml(opt.label)}</b> — ${escapeHtml(opt.description)}`)
                }
                lines.push('')
            }

            await this.bot.api.sendMessage(this.chatId, lines.join('\n'), {
                parse_mode: 'HTML',
                reply_markup: askQuestionKeyboard(requestId, questions),
                ...buildMessageThreadParams(this.messageThreadId),
            })
            return
        }

        // Special handling for ExitPlanMode (Claude): show plan from recent Write tool call
        if (toolName === 'ExitPlanMode') {
            await this.sendExitPlanModeRequest(requestId, input, recentToolCalls)
            return
        }

        const inputStr = JSON.stringify(input, null, 2)
        const truncated = inputStr.length > 800 ? inputStr.slice(0, 800) + '...' : inputStr
        const text = `🔧 <b>Tool: ${escapeHtml(toolName)}</b>\n<pre>${escapeHtml(truncated)}</pre>`

        await this.bot.api.sendMessage(this.chatId, text, {
            parse_mode: 'HTML',
            reply_markup: permissionKeyboard(requestId),
            ...buildMessageThreadParams(this.messageThreadId),
        })
    }

    private async sendExitPlanModeRequest(
        requestId: string,
        input: unknown,
        recentToolCalls?: ToolCallRecord[]
    ): Promise<void> {
        // Find plan content from the most recent Write tool call to a .claude/plans/ path
        let planContent: string | null = null
        const calls = recentToolCalls ?? this.toolCalls
        for (let i = calls.length - 1; i >= 0; i--) {
            const tc = calls[i] as { name: string; input: any }
            if (tc.name === 'Write' && tc.input?.file_path?.includes('.claude/plans/')) {
                planContent = tc.input.content as string
                break
            }
        }

        if (!planContent) {
            // Fallback: show allowedPrompts summary
            const inputObj = input as Record<string, unknown> | null
            const ap = inputObj?.allowedPrompts
            if (ap && Array.isArray(ap) && ap.length > 0) {
                const prompts = ap.map((p: any) => `• ${p.tool}: ${p.prompt}`).join('\n')
                await this.bot.api.sendMessage(
                    this.chatId,
                    `📋 <b>Plan ready for review</b>\n\n<i>Permissions required:</i>\n${escapeHtml(prompts)}`,
                    { parse_mode: 'HTML', reply_markup: permissionKeyboard(requestId), ...buildMessageThreadParams(this.messageThreadId) }
                )
            } else {
                await this.bot.api.sendMessage(
                    this.chatId,
                    `📋 <b>Plan ready for review</b>`,
                    { parse_mode: 'HTML', reply_markup: permissionKeyboard(requestId), ...buildMessageThreadParams(this.messageThreadId) }
                )
            }
            return
        }

        // Sanitize XML-like tags before sending
        const sanitizedPlan = sanitizeXmlLikeTags(planContent)

        // Send plan content (split into multiple messages for Telegram's 4096 limit)
        const MAX_MSG = 4000

        if (sanitizedPlan.length + 30 <= MAX_MSG) {
            await this.bot.api.sendMessage(this.chatId, `📋 Plan ready for review\n\n${sanitizedPlan}`, buildMessageThreadParams(this.messageThreadId))
        } else {
            await this.bot.api.sendMessage(this.chatId, `📋 <b>Plan ready for review</b>`, { parse_mode: 'HTML', ...buildMessageThreadParams(this.messageThreadId) })
            for (let i = 0; i < sanitizedPlan.length; i += MAX_MSG) {
                await this.bot.api.sendMessage(this.chatId, sanitizedPlan.slice(i, i + MAX_MSG), buildMessageThreadParams(this.messageThreadId))
            }
        }

        await this.bot.api.sendMessage(this.chatId, '👆 Approve this plan?', {
            parse_mode: 'HTML',
            reply_markup: permissionKeyboard(requestId),
            ...buildMessageThreadParams(this.messageThreadId),
        })
    }

    handleCallback(requestId: string, action: 'allow' | 'session' | 'deny'): boolean {
        const pending = this.pendingRequests.get(requestId)
        if (!pending) return false

        this.pendingRequests.delete(requestId)

        if (action === 'deny') {
            this._eventBus?.emit({
                type: 'permission.respond',
                sessionId: this._sessionId ?? '',
                requestId,
                decision: 'deny',
            })
            pending.resolve({
                behavior: 'deny',
                message: 'User denied this tool call. Stop and wait for the user to tell you how to proceed.',
            })
        } else {
            this._eventBus?.emit({
                type: 'permission.respond',
                sessionId: this._sessionId ?? '',
                requestId,
                decision: 'allow',
            })
            if (action === 'session') {
                this.approvedTools.add(pending.toolName)
            }
            pending.resolve({
                behavior: 'allow',
                updatedInput: (pending.input as Record<string, unknown>) || {},
                permanent: action === 'session',
            })
        }
        return true
    }

    handleAskCallback(requestId: string, qIdx: number, oIdx: number): boolean {
        const pending = this.pendingRequests.get(requestId)
        if (!pending || !pending.questions) return false

        const question = pending.questions[qIdx]
        if (!question) return false
        const option = question.options[oIdx]
        if (!option) return false

        this.pendingRequests.delete(requestId)

        // Build answer text and push to message queue
        const answerText = `${question.header}: ${option.label}`
        if (this.onAnswerCallback) {
            this.onAnswerCallback(answerText)
        }

        // Build the updatedInput with the user's answer
        const inputObj = (pending.input as Record<string, unknown>) || {}
        const updatedInput = {
            ...inputObj,
            answers: { [question.question]: option.label },
        }

        // Approve the permission
        pending.resolve({
            behavior: 'allow',
            updatedInput,
        })
        return true
    }

    onEvent(event: AgentEvent): void {
        if (event.kind === 'tool_use') {
            this.toolCalls.push({
                id: event.toolUseId || '',
                name: event.toolName,
                input: event.input,
                used: false,
            })
            if (event.toolKind && event.toolName) {
                this.toolKindMap.set(event.toolName, event.toolKind)
            }
        }
    }

    reset(): void {
        this.toolCalls = []
        this.toolKindMap.clear()
        this.approvedTools.clear()
        for (const [, pending] of this.pendingRequests) {
            pending.reject(new Error('Query loop reset'))
        }
        this.pendingRequests.clear()
    }

    hasPending(): boolean {
        return this.pendingRequests.size > 0
    }
}
