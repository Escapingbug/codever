import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { hasSessionExtensionDescriptor } from './manifest.js'
import { HasSessionExtensionService } from './service.js'
import type { HasEngineIdentity } from './types.js'

const MAX_REQUEST_BYTES = 5 * 1024 * 1024

export interface HasExtensionServerOptions {
    service: HasSessionExtensionService
    bearerToken: string
    modelIdentity: HasEngineIdentity
    onLog?: (message: string) => void
}

export function createHasExtensionServer(options: HasExtensionServerOptions): Server {
    if (Buffer.byteLength(options.bearerToken, 'utf8') < 32) {
        throw new Error('HaS extension bearer token must contain at least 32 bytes')
    }
    return createServer(async (request, response) => {
        try {
            if (request.method === 'GET' && request.url === '/health') {
                sendJson(response, 200, {
                    status: 'ok',
                    extension: hasSessionExtensionDescriptor,
                    model: options.modelIdentity,
                })
                return
            }
            if (request.method !== 'POST') {
                sendJson(response, 404, { error: 'Not found' })
                return
            }
            if (!authorized(request.headers.authorization, options.bearerToken)) {
                sendJson(response, 401, { error: 'Unauthorized' })
                return
            }
            const body = await readJson(request)
            const handler = handlers(options.service).get(request.url ?? '')
            if (!handler) {
                sendJson(response, 404, { error: 'Not found' })
                return
            }
            sendJson(response, 200, await handler(body))
        } catch (error) {
            const message = safeError(error)
            options.onLog?.(`[has-session-extension] blocked request: ${message}`)
            sendJson(response, 400, { error: message })
        }
    })
}

function handlers(
    service: HasSessionExtensionService,
): ReadonlyMap<string, (body: unknown) => Promise<Record<string, unknown>>> {
    return new Map([
        ['/v1/turns/prepare', body => service.prepare(body)],
        ['/v1/turns/commit', body => service.commit(body)],
        ['/v1/turns/reject', body => service.reject(body)],
        ['/v1/events/present', body => service.present(body)],
        ['/v1/sessions/lifecycle', body => service.lifecycle(body)],
    ])
}

async function readJson(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.byteLength
        if (size > MAX_REQUEST_BYTES) throw new Error('Extension request is too large')
        chunks.push(buffer)
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
        throw new Error('Extension request must contain valid JSON')
    }
}

function authorized(header: string | undefined, expectedToken: string): boolean {
    if (!header?.startsWith('Bearer ')) return false
    const actual = Buffer.from(header.slice('Bearer '.length), 'utf8')
    const expected = Buffer.from(expectedToken, 'utf8')
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
    if (response.headersSent) return
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    })
    response.end(JSON.stringify(body))
}

function safeError(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 500)
}
