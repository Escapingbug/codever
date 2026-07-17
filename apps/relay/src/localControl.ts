import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Server } from 'node:net'
import { join } from 'node:path'
import type { GatewayEnrollmentRepository } from './enrollmentRepository'
import type { SecureGatewayAuthenticator } from './secureGatewayAuth'

const SECRET_FILE = 'relay-control.secret'
const SOCKET_FILE = 'relay-control.sock'

type ControlRequest =
    | { secret: string; command: 'list' }
    | { secret: string; command: 'approve'; code: string }
    | { secret: string; command: 'reject'; code: string; reason?: string }
    | { secret: string; command: 'pair' }
    | { secret: string; command: 'reset-bootstrap'; confirm: string }

export interface LocalControlServer {
    address: string
    close(): Promise<void>
}

export async function startLocalControlServer(
    dataDirectory: string,
    enrollments: GatewayEnrollmentRepository,
    secureGatewayAuthenticator?: SecureGatewayAuthenticator,
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
            void handle(line, secret, enrollments, secureGatewayAuthenticator).then(
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

export async function runLocalControlCommand(dataDirectory: string, args: string[]): Promise<unknown> {
    const secret = (await readFile(join(dataDirectory, SECRET_FILE), 'utf8')).trim()
    const [command, rawCode, ...rest] = args
    let request: ControlRequest
    if (command === 'list') request = { secret, command }
    else if (command === 'pair') request = { secret, command }
    else if (command === 'approve' && rawCode) request = { secret, command, code: normalizeCode(rawCode) }
    else if (command === 'reject' && rawCode) request = { secret, command, code: normalizeCode(rawCode), ...(rest.length && { reason: rest.join(' ') }) }
    else if (command === 'reset-bootstrap') request = { secret, command, confirm: rest[0] ?? rawCode ?? '' }
    else throw new Error('Usage: relay enrollment <pair|list|approve CODE|reject CODE [reason]|reset-bootstrap RESET-GATEWAY-BOOTSTRAP>')
    return send(controlAddress(dataDirectory), request)
}

export function controlAddress(dataDirectory: string): string {
    if (process.platform !== 'win32') return join(dataDirectory, SOCKET_FILE)
    const suffix = createHash('sha256').update(dataDirectory).digest('hex').slice(0, 24)
    return `\\\\.\\pipe\\codever-relay-${suffix}`
}

async function handle(
    line: string,
    expectedSecret: string,
    enrollments: GatewayEnrollmentRepository,
    secureGatewayAuthenticator?: SecureGatewayAuthenticator,
): Promise<unknown> {
    const request = JSON.parse(line) as ControlRequest
    if (!request || typeof request !== 'object' || !safeEqual(request.secret, expectedSecret)) throw new Error('Local control authentication failed')
    if (request.command === 'list') return { bootstrapComplete: enrollments.bootstrapComplete, enrollments: await enrollments.listPending() }
    if (request.command === 'pair') {
        if (!secureGatewayAuthenticator) throw new Error('Secure Gateway pairing is not configured')
        return secureGatewayAuthenticator.issuePairing()
    }
    if (request.command === 'approve') return enrollments.approve(normalizeCode(request.code), 'local')
    if (request.command === 'reject') return enrollments.reject(normalizeCode(request.code), request.reason)
    if (request.command === 'reset-bootstrap') {
        await enrollments.resetBootstrap(request.confirm)
        return { bootstrapComplete: false }
    }
    throw new Error('Unknown local control command')
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
            } catch (error) { reject(error) }
        })
    })
}

function listen(server: Server, address: string): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(address, () => { server.off('error', reject); resolve() })
    })
}

function safeEqual(left: unknown, right: string): boolean {
    if (typeof left !== 'string') return false
    const a = Buffer.from(left)
    const b = Buffer.from(right)
    return a.length === b.length && timingSafeEqual(a, b)
}

function normalizeCode(value: string): string { return value.replace(/[\s-]/g, '').toUpperCase() }
function isNotFound(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }
