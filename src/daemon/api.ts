/**
 * Daemon Internal API — HTTP server for MCP subprocess → daemon communication.
 *
 * The MCP server runs as a separate subprocess and cannot directly access
 * daemon in-memory state (Scheduler, sessions, etc.). This API provides
 * the IPC bridge via localhost HTTP.
 *
 * Routes:
 *   POST /api/schedule   — Register a scheduled reminder
 *   POST /api/cancel     — Cancel a scheduled reminder
 *   POST /api/send       — Immediately inject a message into a session
 *   GET  /api/sessions   — List sessions (for providerSessionId lookup)
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'

export interface ScheduleRequest {
    /** providerSessionId or coreSessionId to target */
    sessionId: string
    /** Epoch ms when the reminder should fire */
    triggerAt: number
    /** Message text to inject when the reminder fires */
    message: string
    /** Optional context/reason for the reminder */
    context?: string
    /** If set, repeat every this many ms after firing */
    recurringMs?: number
}

export interface CancelRequest {
    taskId: string
}

export interface SendRequest {
    /** providerSessionId or coreSessionId to target */
    sessionId: string
    /** Message text to inject */
    message: string
}

export interface DaemonApiHandlers {
    onSchedule: (req: ScheduleRequest) => { taskId: string }
    onCancel: (req: CancelRequest) => void
    onSend: (req: SendRequest) => void
}

export interface DaemonApi {
    port: number
    stop: () => void
}

export async function startDaemonApi(handlers: DaemonApiHandlers): Promise<DaemonApi> {
    return new Promise((resolve, reject) => {
        const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            // Shared CORS + content-type headers
            res.setHeader('Content-Type', 'application/json')

            const readBody = (): Promise<string> => new Promise((resolve, reject) => {
                const chunks: Buffer[] = []
                req.on('data', (chunk: Buffer) => chunks.push(chunk))
                req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
                req.on('error', reject)
            })

            const sendJson = (status: number, data: unknown) => {
                if (!res.headersSent) {
                    res.writeHead(status)
                    res.end(JSON.stringify(data))
                }
            }

            try {
                if (req.method === 'POST' && req.url === '/api/schedule') {
                    const body = await readBody()
                    const data = JSON.parse(body) as ScheduleRequest
                    if (!data.sessionId || !data.triggerAt || !data.message) {
                        sendJson(400, { error: 'Missing required fields: sessionId, triggerAt, message' })
                        return
                    }
                    const result = handlers.onSchedule(data)
                    sendJson(200, result)
                    return
                }

                if (req.method === 'POST' && req.url === '/api/cancel') {
                    const body = await readBody()
                    const data = JSON.parse(body) as CancelRequest
                    if (!data.taskId) {
                        sendJson(400, { error: 'Missing required field: taskId' })
                        return
                    }
                    handlers.onCancel(data)
                    sendJson(200, { ok: true })
                    return
                }

                if (req.method === 'POST' && req.url === '/api/send') {
                    const body = await readBody()
                    const data = JSON.parse(body) as SendRequest
                    if (!data.sessionId || !data.message) {
                        sendJson(400, { error: 'Missing required fields: sessionId, message' })
                        return
                    }
                    handlers.onSend(data)
                    sendJson(200, { ok: true })
                    return
                }

                sendJson(404, { error: 'Not found' })
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e)
                console.error(`[DaemonApi] Error handling ${req.method} ${req.url}: ${msg}`)
                sendJson(500, { error: msg })
            }
        })

        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            if (!address || typeof address === 'string') {
                reject(new Error('Failed to get server address'))
                return
            }
            console.log(`[DaemonApi] Listening on 127.0.0.1:${address.port}`)
            resolve({
                port: address.port,
                stop: () => server.close(),
            })
        })

        server.on('error', reject)
    })
}
