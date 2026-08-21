import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createConnection } from 'node:net'
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ZodError } from 'zod'
import {
  DEFAULT_PAIRING_OPERATIONS,
  DeviceInvitationCoordinator,
  DeviceInvitationError,
  FileTrustedDeviceRegistry,
  GatewayPairingService,
} from '@/gateway/pairing'
import {
  createInvitationRequestSchema,
  receiveWorkspaceFileRequestSchema,
  gatewayPrivilegedExecutionRequestSchema,
  revokeDeviceRequestSchema,
  type GatewayAdminDevice,
  type GatewayAdminErrorBody,
  type GatewayAdminInvitation,
  type GatewayAdminStatus,
  type ReceiveWorkspaceFileRequest,
  type ReceiveWorkspaceFileResponse,
  type GatewayPrivilegedExecutionRequest,
  type GatewayPrivilegedExecutionResponse,
} from './types.js'

const MAX_BODY_BYTES = 32 * 1024
const DEFAULT_RATE_LIMIT = 5
const RATE_WINDOW_MS = 60_000

export interface GatewayAdminServerOptions {
  socketPath: string
  gatewayId: string
  coordinator: DeviceInvitationCoordinator
  pairingService: GatewayPairingService
  registry: FileTrustedDeviceRegistry
  getGatewayState: () => string
  syncGatewayState?: () => Promise<void>
  receiveWorkspaceFile?: (
    input: ReceiveWorkspaceFileRequest & { requestId: string },
  ) => Promise<ReceiveWorkspaceFileResponse>
  onPrivilegedExecution?: (
    request: GatewayPrivilegedExecutionRequest,
  ) => Promise<GatewayPrivilegedExecutionResponse>
  now?: () => number
  rateLimitPerMinute?: number
  onLog?: (message: string) => void
}

export interface GatewayAdminServer {
  socketPath: string
  stop(): Promise<void>
}

interface IdempotencyEntry {
  fingerprint: string
  response: GatewayAdminInvitation
  expiresAt: number
}

interface FileIdempotencyEntry {
  fingerprint: string
  promise: Promise<ReceiveWorkspaceFileResponse>
}

class AdminHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AdminHttpError'
  }
}

export async function startGatewayAdminServer(
  options: GatewayAdminServerOptions,
): Promise<GatewayAdminServer> {
  const now = options.now ?? Date.now
  const startedAt = now()
  const rateLimit = options.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT
  if (!Number.isSafeInteger(rateLimit) || rateLimit < 1 || rateLimit > 1_000) {
    throw new RangeError('Gateway admin rate limit must be between 1 and 1000')
  }
  await prepareSocketPath(options.socketPath)

  const idempotency = new Map<string, IdempotencyEntry>()
  const fileIdempotency = new Map<string, FileIdempotencyEntry>()
  let invitationAttempts: number[] = []
  const server = createServer(async (request, response) => {
    setResponseHeaders(response)
    try {
      if (request.headers.origin) {
        throw new AdminHttpError(
          403,
          'browser_origin_forbidden',
          'Browser-origin requests are not accepted by the local admin interface',
        )
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      const path = url.pathname

      if (request.method === 'GET' && path === '/v1/status') {
        sendJson(response, 200, await statusResponse(options, startedAt, now()))
        return
      }
      if (request.method === 'GET' && path === '/v1/devices') {
        sendJson(response, 200, {
          devices: await deviceResponses(options.registry, now()),
        })
        return
      }
      if (request.method === 'POST' && path === '/v1/files') {
        if (!options.receiveWorkspaceFile) {
          throw new AdminHttpError(
            503,
            'file_inbox_unavailable',
            'The Gateway workspace file inbox is unavailable',
          )
        }
        const key = requireIdempotencyKey(request)
        const data = receiveWorkspaceFileRequestSchema.parse(await readJsonBody(request))
        const fingerprint = JSON.stringify(data)
        const cached = fileIdempotency.get(key)
        if (cached) {
          if (cached.fingerprint !== fingerprint) {
            throw new AdminHttpError(
              409,
              'idempotency_conflict',
              'The idempotency key was already used for another file',
            )
          }
          sendJson(response, 200, await cached.promise)
          return
        }
        const operation = options.receiveWorkspaceFile({ ...data, requestId: key })
        fileIdempotency.set(key, { fingerprint, promise: operation })
        let result: ReceiveWorkspaceFileResponse
        try {
          result = await operation
        } catch (error) {
          if (fileIdempotency.get(key)?.promise === operation) fileIdempotency.delete(key)
          throw error
        }
        options.onLog?.(
          `[gateway-admin] accepted workspace inbox file ${result.fileId} ${result.delivery}`,
        )
        sendJson(response, 201, result)
        return
      }
      if (request.method === 'POST' && path === '/v1/privileged-executions') {
        if (!options.onPrivilegedExecution) {
          throw new AdminHttpError(
            503,
            'privilege_unavailable',
            'Remote privileged execution is not configured',
          )
        }
        const data = gatewayPrivilegedExecutionRequestSchema.parse(
          await readJsonBody(request),
        )
        sendJson(response, 200, await options.onPrivilegedExecution(data))
        return
      }
      if (request.method === 'POST' && path === '/v1/device-invitations') {
        const key = requireIdempotencyKey(request)
        const data = createInvitationRequestSchema.parse(
          await readJsonBody(request),
        )
        const fingerprint = JSON.stringify(data)
        const cached = idempotency.get(key)
        if (cached && cached.expiresAt > now()) {
          if (cached.fingerprint !== fingerprint) {
            throw new AdminHttpError(
              409,
              'idempotency_conflict',
              'The idempotency key was already used for another request',
            )
          }
          sendJson(response, 200, cached.response)
          return
        }
        idempotency.delete(key)
        const currentTime = now()
        invitationAttempts = invitationAttempts.filter(
          (timestamp) => timestamp + RATE_WINDOW_MS > currentTime,
        )
        if (invitationAttempts.length >= rateLimit) {
          throw new AdminHttpError(
            429,
            'rate_limited',
            'Too many device invitations were requested',
          )
        }
        invitationAttempts.push(currentTime)
        const created = await options.coordinator.create({
          source: { kind: 'local-admin' },
          ...(data.lifetimeMs === undefined ? {} : { lifetimeMs: data.lifetimeMs }),
          matrixLogin: data.matrixLogin ?? 'preferred',
          ...(data.appUrl ? { appUrl: data.appUrl } : {}),
          ...(data.privilegeApproval
            ? {
                allowedOperations: [
                  ...DEFAULT_PAIRING_OPERATIONS,
                  'privilege.approve' as const,
                ],
              }
            : {}),
        })
        const invitation: GatewayAdminInvitation = {
          invitationId: created.invitationId,
          url: created.invitationLink,
          pairingLink: created.pairingLink,
          expiresAt: created.expiresAt,
          verificationCode: created.verificationCode,
          includesMatrixLogin: created.includesMatrixLogin,
          matrixLoginStatus: created.matrixLoginStatus,
        }
        idempotency.set(key, {
          fingerprint,
          response: invitation,
          expiresAt: invitation.expiresAt,
        })
        options.onLog?.(
          `[gateway-admin] created invitation ${invitation.invitationId} `
          + `expires=${new Date(invitation.expiresAt).toISOString()} `
          + `matrixLogin=${invitation.matrixLoginStatus}`,
        )
        sendJson(response, 201, invitation)
        return
      }

      const invitationMatch = path.match(/^\/v1\/device-invitations\/([^/]+)$/u)
      if (request.method === 'DELETE' && invitationMatch) {
        const invitationId = decodeURIComponent(invitationMatch[1]!)
        const cancelled = await options.registry.cancelOffer(invitationId, now())
        if (!cancelled) {
          throw new AdminHttpError(
            404,
            'invitation_not_open',
            'The pairing invitation is unknown or no longer open',
          )
        }
        for (const [key, entry] of idempotency) {
          if (entry.response.invitationId === invitationId) {
            idempotency.delete(key)
          }
        }
        options.onLog?.(`[gateway-admin] cancelled invitation ${invitationId}`)
        sendJson(response, 200, { ok: true, invitationId })
        return
      }

      const revokeMatch = path.match(/^\/v1\/devices\/([^/]+)\/revoke$/u)
      if (request.method === 'POST' && revokeMatch) {
        const deviceId = decodeURIComponent(revokeMatch[1]!)
        const data = revokeDeviceRequestSchema.parse(await readJsonBody(request))
        await options.pairingService.revoke(deviceId, data.reason, now())
        await options.syncGatewayState?.()
        options.onLog?.(`[gateway-admin] revoked device ${deviceId}`)
        sendJson(response, 200, { ok: true, deviceId })
        return
      }

      throw new AdminHttpError(404, 'not_found', 'Gateway admin route not found')
    } catch (error) {
      const mapped = mapError(error)
      options.onLog?.(
        `[gateway-admin] ${request.method ?? 'UNKNOWN'} ${request.url ?? '/'} `
        + `failed: ${mapped.code}`,
      )
      sendJson(response, mapped.status, {
        error: { code: mapped.code, message: mapped.message },
      } satisfies GatewayAdminErrorBody)
    }
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 1_000

  await listen(server, options.socketPath)
  if (process.platform !== 'win32') await chmod(options.socketPath, 0o600)
  options.onLog?.(`[gateway-admin] listening on ${options.socketPath}`)

  let stopped = false
  return {
    socketPath: options.socketPath,
    async stop() {
      if (stopped) return
      stopped = true
      await close(server)
      await removeOwnedSocket(options.socketPath)
    },
  }
}

async function statusResponse(
  options: GatewayAdminServerOptions,
  startedAt: number,
  now: number,
): Promise<GatewayAdminStatus> {
  await options.registry.pruneOffers(now)
  const [activeDevices, offers] = await Promise.all([
    options.registry.listActive(now),
    options.registry.listOffers(now),
  ])
  return {
    version: 1,
    gatewayId: options.gatewayId,
    state: options.getGatewayState(),
    pid: process.pid,
    startedAt,
    activeDeviceCount: activeDevices.length,
    openInvitationCount: offers.filter((offer) => offer.status === 'open').length,
  }
}

async function deviceResponses(
  registry: FileTrustedDeviceRegistry,
  now: number,
): Promise<GatewayAdminDevice[]> {
  return (await registry.list()).map((record) => {
    const certificate = record.certificate.certificate
    return {
      deviceId: certificate.deviceId,
      deviceName: certificate.deviceName,
      status:
        record.status === 'revoked'
          ? 'revoked'
          : certificate.expiresAt <= now
            ? 'expired'
            : 'active',
      matrixUserId: certificate.deviceTransport.userId,
      matrixDeviceId: certificate.deviceTransport.deviceId,
      activatedAt: record.activatedAt,
      expiresAt: certificate.expiresAt,
      ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
      ...(record.revocationReason
        ? { revocationReason: record.revocationReason }
        : {}),
    }
  })
}

function requireIdempotencyKey(request: IncomingMessage): string {
  const value = request.headers['idempotency-key']
  const key = Array.isArray(value) ? value[0] : value
  if (!key || !/^[A-Za-z0-9._:-]{16,128}$/u.test(key)) {
    throw new AdminHttpError(
      400,
      'invalid_idempotency_key',
      'Idempotency-Key must contain 16 to 128 safe characters',
    )
  }
  return key
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      throw new AdminHttpError(413, 'body_too_large', 'Request body is too large')
    }
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error) {
    throw new AdminHttpError(400, 'invalid_json', 'Request body is not valid JSON')
  }
}

function mapError(error: unknown): AdminHttpError {
  if (error instanceof AdminHttpError) return error
  if (error instanceof ZodError) {
    return new AdminHttpError(
      400,
      'invalid_request',
      error.issues.map((issue) => issue.message).join('; '),
    )
  }
  if (error instanceof DeviceInvitationError) {
    return new AdminHttpError(
      error.code === 'too_many_open_invitations' ? 429 : 409,
      error.code,
      error.message,
    )
  }
  const message = error instanceof Error ? error.message : String(error)
  if (
    message.startsWith('Unknown trusted device:')
    || message.startsWith('Device is already revoked:')
  ) {
    return new AdminHttpError(404, 'device_not_active', message)
  }
  return new AdminHttpError(500, 'internal_error', message)
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
  if (process.platform === 'win32') return
  const directory = dirname(socketPath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  let stat
  try {
    stat = await lstat(socketPath)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return
    throw error
  }
  if (stat.isSymbolicLink() || !stat.isSocket()) {
    throw new Error('Gateway admin socket path is not a socket')
  }
  if (process.getuid && stat.uid !== process.getuid()) {
    throw new Error('Gateway admin socket is owned by another user')
  }
  if (await socketAcceptsConnections(socketPath)) {
    throw new Error('Another Gateway admin server is already running')
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
    socket.once('error', (error) => {
      if (
        isNodeError(error, 'ECONNREFUSED')
        || isNodeError(error, 'ENOENT')
        || isNodeError(error, 'ECONNRESET')
      ) {
        finish(false)
        return
      }
      if (!settled) {
        settled = true
        reject(error)
      }
    })
  })
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(socketPath)
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function removeOwnedSocket(socketPath: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    const stat = await lstat(socketPath)
    if (stat.isSocket() && (!process.getuid || stat.uid === process.getuid())) {
      await unlink(socketPath)
    }
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code
}
