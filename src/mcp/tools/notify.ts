/**
 * MCP Notify Tools — schedule_reminder, cancel_reminder, send_message, send_file
 * 
 * These tools allow the agent to proactively schedule reminders and
 * send messages. They communicate with the daemon process via HTTP
 * (the DaemonApi), since the MCP server runs as a separate subprocess.
 *
 * Session identity is provided via the CODEVER_CONVERSATION_ID
 * environment variable, injected by the AcpProvider during loadSession
 * or resumeSession. The flow is:
 *   1. newSession with base MCP config (no sessionId) → get sessionId
 *   2. resumeSession/loadSession with full MCP config + CODEVER_CONVERSATION_ID env
 *   3. Agent calls MCP tools → subprocess reads env → passes sessionId to daemon API
 *
 * Some agents (e.g. Cursor's `agent` CLI) don't support resumeSession, and their
 * loadSession only works after the session has been persisted (i.e. after at least
 * one prompt completes). For those agents, the flow is:
 *   1. newSession with base MCP config → get sessionId
 *   2. Skip Phase 2 → prompt directly (session-scoped tools unavailable on first turn)
 *   3. After prompt completes → loadSession with full MCP config
 *   4. On next turn, session-scoped tools are available
 * If a session-scoped tool is called before the session identity is available,
 * it returns an error asking the user to retry on the next message.
 */

import { z } from 'zod'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, existsSync } from 'node:fs'

/** Read the daemon API port from the well-known file */
function getDaemonApiPort(): number | null {
    const portFile = join(homedir(), '.config', 'codever', 'daemon.api.port')
    if (!existsSync(portFile)) return null
    try {
        return parseInt(readFileSync(portFile, 'utf-8').trim(), 10)
    } catch {
        return null
    }
}

/** Resolve sessionId: accept either a topicKey or conversationId */
async function resolveSessionId(apiPort: number, sessionId: string): Promise<string | null> {
    // Try as-is first (might be a topicKey)
    // The daemon API handler will resolve conversationId → topicKey
    return sessionId
}

export function createScheduleReminderHandler() {
    return async (args: { delayMs: number; message: string; context?: string; recurringMs?: number }) => {
        const apiPort = getDaemonApiPort()
        if (!apiPort) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Daemon API not available. Is the codever daemon running?' }],
            }
        }

        // Session identity comes from env, injected by AcpProvider during loadSession/resumeSession.
        // See buildCodeverMcpFullConfig() in src/providers/acp/index.ts.
        // On the first turn of a new session, this env var may not be set yet because
        // some agents (e.g. Cursor's `agent` CLI) only support loadSession after the
        // session has been persisted (i.e. after the first prompt completes).
        const conversationId = process.env.CODEVER_CONVERSATION_ID
        if (!conversationId) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Session identity not available yet. Schedule_reminder requires a session context that is established after the first turn. Please retry on the next message — it will be available then.' }],
            }
        }

        const triggerAt = Date.now() + args.delayMs
        const requestBody = {
            sessionId: conversationId,
            triggerAt,
            message: args.message,
            context: args.context,
            ...(args.recurringMs ? { recurringMs: args.recurringMs } : {}),
        }

        try {
            const res = await fetch(`http://127.0.0.1:${apiPort}/api/schedule`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            })

            if (!res.ok) {
                const err = await res.text()
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Schedule failed: ${err}` }],
                }
            }

            const data = await res.json() as { taskId: string }
            const fireTime = new Date(triggerAt).toLocaleTimeString()
            const recurringNote = args.recurringMs
                ? ` (repeats every ${args.recurringMs / 1000}s)`
                : ''
            return {
                content: [{
                    type: 'text' as const,
                    text: `Reminder scheduled for ${fireTime}${recurringNote} (task ID: ${data.taskId}). Message: "${args.message}"`,
                }],
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return {
                isError: true,
                content: [{ type: 'text' as const, text: `Failed to connect to daemon: ${msg}` }],
            }
        }
    }
}

export function createCancelReminderHandler() {
    return async (args: { taskId: string }) => {
        const apiPort = getDaemonApiPort()
        if (!apiPort) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Daemon API not available.' }],
            }
        }

        try {
            const res = await fetch(`http://127.0.0.1:${apiPort}/api/cancel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId: args.taskId }),
            })

            if (!res.ok) {
                const err = await res.text()
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Cancel failed: ${err}` }],
                }
            }

            return {
                content: [{ type: 'text' as const, text: `Reminder ${args.taskId} cancelled.` }],
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return {
                isError: true,
                content: [{ type: 'text' as const, text: `Failed to connect to daemon: ${msg}` }],
            }
        }
    }
}

export function createSendMessageHandler() {
    return async (args: { message: string }) => {
        const apiPort = getDaemonApiPort()
        if (!apiPort) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Daemon API not available.' }],
            }
        }

        const conversationId = process.env.CODEVER_CONVERSATION_ID
        if (!conversationId) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Session identity not available yet. Send_message requires a session context that is established after the first turn. Please retry on the next message — it will be available then.' }],
            }
        }

        try {
            const res = await fetch(`http://127.0.0.1:${apiPort}/api/send`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: conversationId, message: args.message }),
            })

            if (!res.ok) {
                const err = await res.text()
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Send failed: ${err}` }],
                }
            }

            return {
                content: [{ type: 'text' as const, text: `Message sent: "${args.message}"` }],
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return {
                isError: true,
                content: [{ type: 'text' as const, text: `Failed to connect to daemon: ${msg}` }],
            }
        }
    }
}

type SendFileType = 'document' | 'file' | 'markdown' | 'code' | 'image'

interface SendFileApiResponse {
    ok: boolean
    result?: {
        status?: string
        deliveryId?: string
        path?: string
        filename?: string
        type?: string
        message?: string
    }
}

export function createSendFileHandler() {
    return async (args: { path: string; caption?: string; filename?: string; type?: SendFileType; language?: string }) => {
        const apiPort = getDaemonApiPort()
        if (!apiPort) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Daemon API not available.' }],
            }
        }

        const conversationId = process.env.CODEVER_CONVERSATION_ID
        if (!conversationId) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Session identity not available yet. Send_file requires a session context that is established after the first turn. Please retry on the next message — it will be available then.' }],
            }
        }

        const requestBody = {
            sessionId: conversationId,
            path: args.path,
            ...(args.caption ? { caption: args.caption } : {}),
            ...(args.filename ? { filename: args.filename } : {}),
            ...(args.type ? { type: args.type } : {}),
            ...(args.language ? { language: args.language } : {}),
        }

        try {
            const res = await fetch(`http://127.0.0.1:${apiPort}/api/send-file`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            })

            if (!res.ok) {
                const err = await res.text()
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Send file failed: ${err}` }],
                }
            }

            const data = await res.json() as SendFileApiResponse
            const result = data.result
            if (result?.status === 'queued' && result.deliveryId) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `File delivery queued: "${args.path}" (delivery ID: ${result.deliveryId}). The upload may still be in progress; call get_delivery_status with this delivery ID to check whether it is pending, sent, or failed.`,
                    }],
                }
            }

            if (result?.status === 'failed') {
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Send file failed: ${result.message ?? 'unknown error'}` }],
                }
            }

            return {
                content: [{ type: 'text' as const, text: `File delivered: "${args.path}"` }],
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return {
                isError: true,
                content: [{ type: 'text' as const, text: `Failed to connect to daemon: ${msg}` }],
            }
        }
    }
}

export function createGetDeliveryStatusHandler() {
    return async (args: { deliveryId?: string; includeText?: boolean }) => {
        const apiPort = getDaemonApiPort()
        if (!apiPort) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Daemon API not available.' }],
            }
        }

        const conversationId = process.env.CODEVER_CONVERSATION_ID
        if (!conversationId) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Session identity not available yet. Get_delivery_status requires a session context that is established after the first turn. Please retry on the next message.' }],
            }
        }

        try {
            const res = await fetch(`http://127.0.0.1:${apiPort}/api/delivery-status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: conversationId,
                    ...(args.deliveryId ? { deliveryId: args.deliveryId } : {}),
                    ...(args.includeText ? { includeText: true } : {}),
                }),
            })

            if (!res.ok) {
                const err = await res.text()
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Delivery status failed: ${err}` }],
                }
            }

            const data = await res.json() as {
                deliveries?: Array<{
                    id: string
                    kind: string
                    status: string
                    messageId?: string | number
                    createdAt: number
                    completedAt?: number
                    error?: string
                    textChars: number
                    text?: string
                    format?: string
                    retryOf?: string
                    resolvedBy?: string
                    resolvedAt?: number
                    attachments?: Array<{ type: string; path: string; filename?: string }>
                }>
            }
            const deliveries = data.deliveries ?? []
            if (deliveries.length === 0) {
                return {
                    content: [{ type: 'text' as const, text: args.deliveryId ? `No delivery found for ${args.deliveryId}.` : 'No deliveries found for this session.' }],
                }
            }

            const lines = deliveries.map(delivery => {
                const attachment = delivery.attachments?.[0]
                const target = attachment?.filename ?? attachment?.path ?? `${delivery.textChars} text chars`
                const completed = delivery.completedAt ? ` completed=${new Date(delivery.completedAt).toISOString()}` : ''
                const messageId = delivery.messageId !== undefined ? ` messageId=${delivery.messageId}` : ''
                const error = delivery.error ? ` error=${delivery.error}` : ''
                const retryOf = delivery.retryOf ? ` retryOf=${delivery.retryOf}` : ''
                const resolvedBy = delivery.resolvedBy ? ` resolvedBy=${delivery.resolvedBy}` : ''
                const resolvedAt = delivery.resolvedAt ? ` resolvedAt=${new Date(delivery.resolvedAt).toISOString()}` : ''
                const header = `${delivery.id}: ${delivery.status} ${target}${messageId}${completed}${retryOf}${resolvedBy}${resolvedAt}${error}`
                if (!args.includeText || delivery.text === undefined) return header
                return `${header}\nformat=${delivery.format ?? 'unknown'}\ntext:\n${delivery.text}`
            })
            return {
                content: [{ type: 'text' as const, text: `Delivery status:\n${lines.join('\n')}` }],
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return {
                isError: true,
                content: [{ type: 'text' as const, text: `Failed to connect to daemon: ${msg}` }],
            }
        }
    }
}

export function createRetryDeliveryHandler() {
    return async (args: { deliveryId: string }) => {
        const apiPort = getDaemonApiPort()
        if (!apiPort) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Daemon API not available.' }],
            }
        }

        const conversationId = process.env.CODEVER_CONVERSATION_ID
        if (!conversationId) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Session identity not available yet. Retry_delivery requires a session context that is established after the first turn. Please retry on the next message.' }],
            }
        }

        try {
            const res = await fetch(`http://127.0.0.1:${apiPort}/api/retry-delivery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: conversationId,
                    deliveryId: args.deliveryId,
                }),
            })

            if (!res.ok) {
                const err = await res.text()
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Retry delivery failed: ${err}` }],
                }
            }

            const result = await res.json() as {
                status: 'sent' | 'failed' | 'not_found'
                deliveryId?: string
                retryOf?: string
                messageId?: string | number
                message?: string
            }
            if (result.status === 'not_found') {
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: result.message ?? `No delivery found for ${args.deliveryId}.` }],
                }
            }
            if (result.status === 'failed') {
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Delivery retry failed for ${result.retryOf ?? args.deliveryId}: ${result.message ?? 'unknown error'}` }],
                }
            }

            const messageId = result.messageId !== undefined ? ` messageId=${result.messageId}` : ''
            return {
                content: [{ type: 'text' as const, text: `Delivery resent: ${result.retryOf ?? args.deliveryId} -> ${result.deliveryId ?? 'unknown'}${messageId}` }],
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return {
                isError: true,
                content: [{ type: 'text' as const, text: `Failed to connect to daemon: ${msg}` }],
            }
        }
    }
}

/** Register all notify tools on an MCP server */
export function registerNotifyTools(server: any): void {
    server.tool(
        'schedule_reminder',
        'Schedule a timed reminder. When the timer fires, the agent will be invoked with the specified message. Can be one-shot or recurring.',
        {
            delayMs: z.number().positive().describe('Delay in milliseconds before the reminder fires'),
            message: z.string().describe('The message to inject when the reminder fires'),
            context: z.string().optional().describe('Why the agent is being invoked (for logging)'),
            recurringMs: z.number().positive().optional().describe('If set, repeat every this many milliseconds after each firing'),
        },
        createScheduleReminderHandler(),
    )

    server.tool(
        'cancel_reminder',
        'Cancel a previously scheduled reminder by its task ID.',
        {
            taskId: z.string().describe('The task ID returned by schedule_reminder'),
        },
        createCancelReminderHandler(),
    )

    server.tool(
        'send_message',
        'Send an immediate message to the user via the channel, injecting it into the current session.',
        {
            message: z.string().describe('The message to send'),
        },
        createSendMessageHandler(),
    )

    server.tool(
        'send_file',
        'Send an immediate file attachment to the user via the channel. The path must be readable and inside the session working directory or an allowed Codever directory.',
        {
            path: z.string().describe('Local file path to send as an attachment'),
            caption: z.string().optional().describe('Optional caption to send with the file'),
            filename: z.string().optional().describe('Optional display filename for the attachment'),
            type: z.enum(['document', 'file', 'markdown', 'code', 'image']).optional().describe('How to send the file: document/file sends the raw file, markdown renders markdown text, code renders a fenced code block, image sends as a Telegram photo'),
            language: z.string().optional().describe('Optional language tag for code rendering'),
        },
        createSendFileHandler(),
    )

    server.tool(
        'get_delivery_status',
        'Check asynchronous channel delivery status for files or messages queued by Codever. Pass deliveryId to inspect a specific delivery; set includeText to recover retained message text.',
        {
            deliveryId: z.string().optional().describe('Optional delivery ID returned by send_file. If omitted, recent deliveries for the session are listed.'),
            includeText: z.boolean().optional().describe('Include retained message text in the response. Use for failed deliveries whose Telegram message was not shown.'),
        },
        createGetDeliveryStatusHandler(),
    )

    server.tool(
        'retry_delivery',
        'Retry a retained channel delivery by ID.',
        {
            deliveryId: z.string().describe('Delivery ID to retry, such as delivery-123.'),
        },
        createRetryDeliveryHandler(),
    )
}
