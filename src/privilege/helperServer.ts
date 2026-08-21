import { createHash, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import {
  access,
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  stat,
  unlink,
} from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { ZodError } from 'zod'
import {
  MAX_PRIVILEGED_OUTPUT_BYTES,
  PRIVILEGE_HELPER_PROTOCOL_VERSION,
  privilegeHelperConfigSchema,
  privilegedExecutionRequestSchema,
  privilegedExecutionResultSchema,
  type PrivilegeHelperConfig,
  type PrivilegedExecutionRequest,
  type PrivilegedExecutionResult,
} from './protocol.js'

const MAX_BODY_BYTES = 64 * 1024
const MAX_REQUEST_CLOCK_SKEW_MS = 5_000
const REPLAY_RETENTION_MS = 24 * 60 * 60_000

class HelperHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HelperHttpError'
  }
}

export interface PrivilegeHelperServer {
  socketPath: string
  stop(): Promise<void>
}

export interface PrivilegeHelperServerOptions {
  config: PrivilegeHelperConfig
  now?: () => number
  onLog?: (message: string) => void
}

export async function startPrivilegeHelperServer(
  options: PrivilegeHelperServerOptions,
): Promise<PrivilegeHelperServer> {
  const config = privilegeHelperConfigSchema.parse(options.config)
  const now = options.now ?? Date.now
  await prepareSocketPath(config.socketPath)
  await mkdir(config.replayDirectory, { recursive: true, mode: 0o700 })
  await chmod(config.replayDirectory, 0o700)
  await pruneReplayClaims(config.replayDirectory, now())

  const server = createServer(async (request, response) => {
    setResponseHeaders(response)
    try {
      if (request.method === 'GET' && request.url === '/v1/status') {
        authorize(request, config.tokenSha256)
        sendJson(response, 200, {
          version: PRIVILEGE_HELPER_PROTOCOL_VERSION,
          state: 'ready',
        })
        return
      }
      if (request.method !== 'POST' || request.url !== '/v1/execute') {
        throw new HelperHttpError(404, 'not_found', 'Privilege Helper route not found')
      }
      authorize(request, config.tokenSha256)
      const execution = privilegedExecutionRequestSchema.parse(
        await readJsonBody(request),
      )
      const currentTime = now()
      if (execution.expiresAt <= currentTime) {
        throw new HelperHttpError(409, 'request_expired', 'Privilege grant has expired')
      }
      if (execution.requestedAt > currentTime + MAX_REQUEST_CLOCK_SKEW_MS) {
        throw new HelperHttpError(
          409,
          'request_not_yet_valid',
          'Privilege grant creation time is too far in the future',
        )
      }
      const result = await executeOnce(config, execution, now, options.onLog)
      sendJson(response, 200, result)
    } catch (error) {
      const mapped = mapError(error)
      options.onLog?.(
        `[privilege-helper] ${request.method ?? 'UNKNOWN'} ${request.url ?? '/'} `
        + `failed: ${mapped.code}`,
      )
      sendJson(response, mapped.status, {
        error: { code: mapped.code, message: mapped.message },
      })
    }
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 1_000

  await listen(server, config.socketPath)
  if (
    process.getuid?.() === 0
    || process.getuid?.() !== config.allowedUid
    || process.getgid?.() !== config.allowedGid
  ) {
    await chown(config.socketPath, config.allowedUid, config.allowedGid)
  }
  await chmod(config.socketPath, 0o600)
  options.onLog?.(`[privilege-helper] listening on ${config.socketPath}`)

  let stopped = false
  return {
    socketPath: config.socketPath,
    async stop() {
      if (stopped) return
      stopped = true
      await close(server)
      await removeSocket(config.socketPath)
    },
  }
}

async function executeOnce(
  config: PrivilegeHelperConfig,
  request: PrivilegedExecutionRequest,
  now: () => number,
  onLog?: (message: string) => void,
): Promise<PrivilegedExecutionResult> {
  await claimRequest(config.replayDirectory, request)
  const executable = await validateExecutable(config, request.executable)
  const cwd = await realpath(request.cwd)
  const cwdStat = await stat(cwd)
  if (!cwdStat.isDirectory()) {
    throw new HelperHttpError(400, 'invalid_cwd', 'Privileged working directory is not a directory')
  }
  const startedAt = now()
  onLog?.(
    `[privilege-helper] execute request=${request.requestId} session=${request.sessionId} `
    + `executable=${executable} argc=${request.args.length}`,
  )
  const outcome = await spawnPrivileged(executable, request.args, cwd, request.timeoutMs)
  const completedAt = now()
  const result = privilegedExecutionResultSchema.parse({
    requestId: request.requestId,
    status: outcome.timedOut
      ? 'timed_out'
      : outcome.exitCode === 0
        ? 'succeeded'
        : 'failed',
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    truncated: outcome.truncated,
    startedAt,
    completedAt,
  })
  onLog?.(
    `[privilege-helper] completed request=${request.requestId} status=${result.status} `
    + `exit=${result.exitCode ?? 'null'}`,
  )
  return result
}

async function validateExecutable(
  config: PrivilegeHelperConfig,
  requestedPath: string,
): Promise<string> {
  const executable = await realpath(requestedPath).catch(() => {
    throw new HelperHttpError(400, 'executable_not_found', 'Privileged executable does not exist')
  })
  const policyPaths = await Promise.all(
    config.policy.allowedExecutables.map(path => realpath(path).catch(() => path)),
  )
  if (
    !config.policy.allowArbitraryRootExecutables
    && !policyPaths.includes(executable)
  ) {
    throw new HelperHttpError(
      403,
      'executable_not_allowed',
      'Privileged executable is not allowed by the host policy',
    )
  }
  const metadata = await stat(executable)
  if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
    throw new HelperHttpError(
      403,
      'unsafe_executable',
      'Privileged executable must be a root-owned file that is not group/world writable',
    )
  }
  await access(executable, fsConstants.X_OK)
  return executable
}

async function claimRequest(
  replayDirectory: string,
  request: PrivilegedExecutionRequest,
): Promise<void> {
  const key = createHash('sha256').update(request.requestId).digest('hex')
  const path = join(replayDirectory, `${key}.json`)
  let handle
  try {
    handle = await open(path, 'wx', 0o600)
    await handle.writeFile(JSON.stringify({
      requestId: request.requestId,
      sessionId: request.sessionId,
      requestedAt: request.requestedAt,
      executable: request.executable,
    }))
    await handle.sync()
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) {
      throw new HelperHttpError(409, 'request_replayed', 'Privilege grant was already consumed')
    }
    throw error
  } finally {
    await handle?.close()
  }
}

function spawnPrivileged(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<{
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        HOME: process.platform === 'darwin' ? '/var/root' : '/root',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        LOGNAME: 'root',
        PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
        USER: 'root',
      },
    })
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let truncated = false
    let timedOut = false
    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
    ): Buffer<ArrayBufferLike> => {
      if (current.length >= MAX_PRIVILEGED_OUTPUT_BYTES) {
        truncated = true
        return current
      }
      const remaining = MAX_PRIVILEGED_OUTPUT_BYTES - current.length
      if (chunk.length > remaining) truncated = true
      return Buffer.concat([current, chunk.subarray(0, remaining)])
    }
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {}
    }, timeoutMs)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (exitCode, signal) => {
      clearTimeout(timer)
      resolve({
        exitCode,
        signal,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        truncated,
        timedOut,
      })
    })
  })
}

function authorize(request: IncomingMessage, tokenSha256: string): void {
  const header = request.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice(7) : ''
  const actual = createHash('sha256').update(token).digest()
  const expected = Buffer.from(tokenSha256, 'hex')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new HelperHttpError(401, 'unauthorized', 'Privilege Helper credential is invalid')
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      throw new HelperHttpError(413, 'body_too_large', 'Privilege request is too large')
    }
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HelperHttpError(400, 'invalid_json', 'Privilege request is not valid JSON')
  }
}

function mapError(error: unknown): HelperHttpError {
  if (error instanceof HelperHttpError) return error
  if (error instanceof ZodError) {
    return new HelperHttpError(
      400,
      'invalid_request',
      error.issues.map(issue => issue.message).join('; '),
    )
  }
  return new HelperHttpError(
    500,
    'execution_failed',
    error instanceof Error ? error.message : String(error),
  )
}

function setResponseHeaders(response: ServerResponse): void {
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return
  response.writeHead(status)
  response.end(JSON.stringify(body))
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o755 })
  let metadata
  try {
    metadata = await lstat(socketPath)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return
    throw error
  }
  if (metadata.isSymbolicLink() || !metadata.isSocket()) {
    throw new Error('Privilege Helper socket path is not a socket')
  }
  if (await socketAcceptsConnections(socketPath)) {
    throw new Error('Another Privilege Helper is already running')
  }
  await unlink(socketPath)
}

function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath })
    let settled = false
    const finish = (result: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(250, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', error => {
      if (
        isNodeError(error, 'ECONNREFUSED')
        || isNodeError(error, 'ENOENT')
        || isNodeError(error, 'ECONNRESET')
      ) {
        finish(false)
      } else if (!settled) {
        settled = true
        reject(error)
      }
    })
  })
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
}

async function removeSocket(socketPath: string): Promise<void> {
  try {
    const metadata = await lstat(socketPath)
    if (metadata.isSocket()) await unlink(socketPath)
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
  }
}

async function pruneReplayClaims(replayDirectory: string, now: number): Promise<void> {
  const entries = await readdir(replayDirectory, { withFileTypes: true })
  await Promise.all(entries.map(async entry => {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) return
    const path = join(replayDirectory, entry.name)
    const metadata = await lstat(path)
    if (metadata.mtimeMs + REPLAY_RETENTION_MS < now) await unlink(path)
  }))
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code
}
