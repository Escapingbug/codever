import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import type {
  CreateInvitationRequest,
  GatewayAdminDevice,
  GatewayAdminErrorBody,
  GatewayAdminInvitation,
  GatewayAdminStatus,
  ReceiveWorkspaceFileRequest,
  ReceiveWorkspaceFileResponse,
  GatewayPrivilegedExecutionRequest,
  GatewayPrivilegedExecutionResponse,
  PublishNativeClientReleaseRequest,
  PublishNativeClientReleaseResponse,
  RevokeDeviceRequest,
} from './types.js'

export class GatewayAdminClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'GatewayAdminClientError'
  }
}

export interface GatewayAdminClientOptions {
  socketPath: string
  timeoutMs?: number
}

export class GatewayAdminClient {
  private readonly timeoutMs: number

  constructor(private readonly options: GatewayAdminClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 5_000
  }

  status(): Promise<GatewayAdminStatus> {
    return this.request('GET', '/v1/status')
  }

  async devices(): Promise<GatewayAdminDevice[]> {
    const response = await this.request<{ devices: GatewayAdminDevice[] }>(
      'GET',
      '/v1/devices',
    )
    return response.devices
  }

  createInvitation(
    input: CreateInvitationRequest,
    idempotencyKey: string = randomUUID(),
  ): Promise<GatewayAdminInvitation> {
    return this.request(
      'POST',
      '/v1/device-invitations',
      input,
      { 'idempotency-key': idempotencyKey },
    )
  }

  cancelInvitation(
    invitationId: string,
  ): Promise<{ ok: true; invitationId: string }> {
    return this.request(
      'DELETE',
      `/v1/device-invitations/${encodeURIComponent(invitationId)}`,
    )
  }

  revokeDevice(
    deviceId: string,
    input: RevokeDeviceRequest = {},
  ): Promise<{ ok: true; deviceId: string }> {
    return this.request(
      'POST',
      `/v1/devices/${encodeURIComponent(deviceId)}/revoke`,
      input,
    )
  }

  sendFile(
    input: ReceiveWorkspaceFileRequest,
    idempotencyKey: string = randomUUID(),
  ): Promise<ReceiveWorkspaceFileResponse> {
    return this.request(
      'POST',
      '/v1/files',
      input,
      { 'idempotency-key': idempotencyKey },
    )
  }

  privilegedExecution(
    input: GatewayPrivilegedExecutionRequest,
  ): Promise<GatewayPrivilegedExecutionResponse> {
    return this.request('POST', '/v1/privileged-executions', input)
  }

  publishNativeClientRelease(
    input: PublishNativeClientReleaseRequest,
  ): Promise<PublishNativeClientReleaseResponse> {
    return this.request('POST', '/v1/client-releases/android', input)
  }

  private request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const encoded = body === undefined ? undefined : JSON.stringify(body)
      const request = httpRequest({
        socketPath: this.options.socketPath,
        method,
        path,
        headers: {
          accept: 'application/json',
          ...(encoded === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(encoded).toString(),
              }),
          ...headers,
        },
      }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: unknown
          try {
            parsed = text ? JSON.parse(text) as unknown : {}
          } catch (error) {
            reject(new Error('Gateway admin returned invalid JSON', { cause: error }))
            return
          }
          const status = response.statusCode ?? 500
          if (status < 200 || status >= 300) {
            const error = parsed as Partial<GatewayAdminErrorBody>
            reject(new GatewayAdminClientError(
              status,
              error.error?.code ?? 'unknown_error',
              error.error?.message ?? `Gateway admin request failed with HTTP ${status}`,
            ))
            return
          }
          resolve(parsed as T)
        })
      })
      request.setTimeout(this.timeoutMs, () => {
        request.destroy(new Error('Gateway admin request timed out'))
      })
      request.once('error', reject)
      if (encoded !== undefined) request.write(encoded)
      request.end()
    })
  }
}
