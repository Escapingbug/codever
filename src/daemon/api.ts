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
 *   POST /api/send-file  — Immediately send a file attachment to a session
 *   GET  /api/sessions   — List sessions (for providerSessionId lookup)
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'

export interface ScheduleRequest {
    /** topicKey, providerSessionId, or coreSessionId to target */
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
    /** topicKey, providerSessionId, or coreSessionId to target */
    sessionId: string
    /** Message text to inject */
    message: string
}

export interface SendFileRequest {
    /** topicKey, providerSessionId, or coreSessionId to target */
    sessionId: string
    /** Local file path to send */
    path: string
    /** Optional caption to send with the file */
    caption?: string
    /** Optional display filename */
    filename?: string
    /** Optional render/delivery type */
    type?: 'document' | 'file' | 'markdown' | 'code' | 'image'
    /** Optional language tag for code rendering */
    language?: string
}

export interface DeliveryStatusRequest {
    /** topicKey, providerSessionId, or coreSessionId to target */
    sessionId: string
    /** Optional delivery id returned by send_file */
    deliveryId?: string
    /** Include retained message text in the response */
    includeText?: boolean
}

export interface RetryDeliveryRequest {
    /** topicKey, providerSessionId, or coreSessionId to target */
    sessionId: string
    /** Delivery id to retry */
    deliveryId: string
}

export interface RetryDeliveryResponse {
    status: 'sent' | 'failed' | 'not_found'
    deliveryId?: string
    retryOf?: string
    messageId?: string | number
    message?: string
}

export interface DeliveryStatusResponse {
    deliveries: Array<{
        id: string
        kind: 'send' | 'edit'
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

export interface DaemonApiHandlers {
    onSchedule: (req: ScheduleRequest) => { taskId: string }
    onCancel: (req: CancelRequest) => void
    onSend: (req: SendRequest) => void
    onSendFile: (req: SendFileRequest) => void | Promise<unknown>
    onDeliveryStatus: (req: DeliveryStatusRequest) => DeliveryStatusResponse
    onRetryDelivery: (req: RetryDeliveryRequest) => Promise<RetryDeliveryResponse>
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

                if (req.method === 'POST' && req.url === '/api/send-file') {
                    const body = await readBody()
                    const data = JSON.parse(body) as SendFileRequest
                    if (!data.sessionId || !data.path) {
                        sendJson(400, { error: 'Missing required fields: sessionId, path' })
                        return
                    }
                    const result = await handlers.onSendFile(data)
                    sendJson(200, { ok: true, result })
                    return
                }

                if (req.method === 'POST' && req.url === '/api/delivery-status') {
                    const body = await readBody()
                    const data = JSON.parse(body) as DeliveryStatusRequest
                    if (!data.sessionId) {
                        sendJson(400, { error: 'Missing required field: sessionId' })
                        return
                    }
                    sendJson(200, handlers.onDeliveryStatus(data))
                    return
                }

                if (req.method === 'POST' && req.url === '/api/retry-delivery') {
                    const body = await readBody()
                    const data = JSON.parse(body) as RetryDeliveryRequest
                    if (!data.sessionId || !data.deliveryId) {
                        sendJson(400, { error: 'Missing required fields: sessionId, deliveryId' })
                        return
                    }
                    const result = await handlers.onRetryDelivery(data)
                    sendJson(200, result)
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
