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

            return {
                content: [{ type: 'text' as const, text: `File sent: "${args.path}"` }],
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
}
