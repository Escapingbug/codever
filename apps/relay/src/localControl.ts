import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Server } from 'node:net'
import { join } from 'node:path'
import type { SecureGatewayAuthenticator } from './secureGatewayAuth'
import type { SecureClientAuthenticator } from './secureClientAuth'

const SECRET_FILE = 'relay-control.secret'
const SOCKET_FILE = 'relay-control.sock'

interface ControlRequest {
    secret: string
    command: 'pair'
    target: 'gateway' | 'client'
}

export interface LocalControlServer {
    address: string
    close(): Promise<void>
}

export async function startLocalControlServer(
    dataDirectory: string,
    secureGatewayAuthenticator: SecureGatewayAuthenticator,
    secureClientAuthenticator: SecureClientAuthenticator,
): Promise<LocalControlServer> {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
    const secret = await loadOrCreateSecret(dataDirectory)
    const address = controlAddress(dataDirectory)
    if (process.platform !== 'win32') await rm(address, { force: true })
    const server = createServer(socket => {
        let input = ''
        socket.setEncoding('utf8')
        socket.on('data', chunk => {
            input += chunk
            if (input.length > 16_384) socket.destroy(new Error('Control request too large'))
            const newline = input.indexOf('\n')
            if (newline < 0) return
            const line = input.slice(0, newline)
            input = ''
            void handle(line, secret, secureGatewayAuthenticator, secureClientAuthenticator).then(
                result => socket.end(`${JSON.stringify({ ok: true, result })}\n`),
                error => socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`),
            )
        })
    })
    await listen(server, address)
    if (process.platform !== 'win32') await chmod(address, 0o600)
    return {
        address,
        close: async () => {
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
            if (process.platform !== 'win32') await rm(address, { force: true })
        },
    }
}

export async function runLocalPairCommand(dataDirectory: string, target: 'gateway' | 'client'): Promise<unknown> {
    const secret = (await readFile(join(dataDirectory, SECRET_FILE), 'utf8')).trim()
    return send(controlAddress(dataDirectory), { secret, command: 'pair', target })
}

export function controlAddress(dataDirectory: string): string {
    if (process.platform !== 'win32') return join(dataDirectory, SOCKET_FILE)
    const suffix = createHash('sha256').update(dataDirectory).digest('hex').slice(0, 24)
    return `\\\\.\\pipe\\codever-relay-${suffix}`
}

async function handle(
    line: string,
    expectedSecret: string,
    gatewayAuthenticator: SecureGatewayAuthenticator,
    clientAuthenticator: SecureClientAuthenticator,
): Promise<unknown> {
    const request = JSON.parse(line) as ControlRequest
    if (!request || typeof request !== 'object' || !safeEqual(request.secret, expectedSecret)) throw new Error('Local control authentication failed')
    if (request.command !== 'pair' || (request.target !== 'gateway' && request.target !== 'client')
        || Object.keys(request).some(key => key !== 'secret' && key !== 'command' && key !== 'target')) {
        throw new Error('Unknown local control command')
    }
    return request.target === 'gateway' ? gatewayAuthenticator.issuePairing() : clientAuthenticator.issuePairing()
}

async function loadOrCreateSecret(dataDirectory: string): Promise<string> {
    const path = join(dataDirectory, SECRET_FILE)
    try {
        const value = (await readFile(path, 'utf8')).trim()
        if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('Relay control secret is invalid')
        await chmod(path, 0o600)
        return value
    } catch (error) {
        if (!isNotFound(error)) throw error
        const value = randomBytes(32).toString('base64url')
        await writeFile(path, `${value}\n`, { flag: 'wx', mode: 0o600 })
        return value
    }
}

function send(address: string, request: ControlRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(address)
        let output = ''
        socket.setEncoding('utf8')
        socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`))
        socket.on('data', chunk => { output += chunk })
        socket.once('error', reject)
        socket.once('end', () => {
            try {
                const response = JSON.parse(output) as { ok: boolean; result?: unknown; error?: string }
                if (!response.ok) reject(new Error(response.error ?? 'Local control command failed'))
                else resolve(response.result)
            } catch (error) {
                reject(error)
            }
        })
    })
}

function listen(server: Server, address: string): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(address, () => {
            server.off('error', reject)
            resolve()
        })
    })
}

function safeEqual(left: unknown, right: string): boolean {
    if (typeof left !== 'string') return false
    const a = Buffer.from(left)
    const b = Buffer.from(right)
    return a.length === b.length && timingSafeEqual(a, b)
}

function isNotFound(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
