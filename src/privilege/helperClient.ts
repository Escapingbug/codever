import { lstat, readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import {
  privilegeClientCredentialSchema,
  privilegeHelperStatusSchema,
  privilegedExecutionResultSchema,
  type PrivilegeClientCredential,
  type PrivilegeExecutor,
  type PrivilegeHelperStatus,
  type PrivilegedExecutionRequest,
  type PrivilegedExecutionResult,
} from './protocol.js'

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export class PrivilegeHelperClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'PrivilegeHelperClientError'
  }
}

export class UnixSocketPrivilegeExecutor implements PrivilegeExecutor {
  private credential: PrivilegeClientCredential | null = null

  constructor(private readonly credentialPath: string) {}

  async execute(
    request: PrivilegedExecutionRequest,
  ): Promise<PrivilegedExecutionResult> {
    const credential = await this.loadCredential()
    return await this.requestJson(
      credential,
      'POST',
      '/v1/execute',
      request,
      request.timeoutMs + 30_000,
      value => privilegedExecutionResultSchema.parse(value),
    )
  }

  async status(): Promise<PrivilegeHelperStatus> {
    const credential = await this.loadCredential()
    return await this.requestJson(
      credential,
      'GET',
      '/v1/status',
      undefined,
      2_000,
      value => privilegeHelperStatusSchema.parse(value),
    )
  }

  private requestJson<T>(
    credential: PrivilegeClientCredential,
    method: 'GET' | 'POST',
    path: string,
    value: unknown,
    timeoutMs: number,
    parse: (value: unknown) => T,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const body = value === undefined ? '' : JSON.stringify(value)
      const clientRequest = httpRequest({
        socketPath: credential.socketPath,
        method,
        path,
        headers: {
          authorization: `Bearer ${credential.token}`,
          ...(body
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body).toString(),
              }
            : {}),
        },
      }, response => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_RESPONSE_BYTES) {
            clientRequest.destroy(new Error('Privilege Helper response is too large'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: unknown
          try {
            parsed = text ? JSON.parse(text) : {}
          } catch (error) {
            reject(new Error('Privilege Helper returned invalid JSON', { cause: error }))
            return
          }
          const status = response.statusCode ?? 500
          if (status < 200 || status >= 300) {
            const body = parsed as { error?: { code?: string; message?: string } }
            reject(new PrivilegeHelperClientError(
              status,
              body.error?.code ?? 'unknown_error',
              body.error?.message ?? `Privilege Helper returned HTTP ${status}`,
            ))
            return
          }
          try {
            resolve(parse(parsed))
          } catch (error) {
            reject(new Error('Privilege Helper returned an invalid response', {
              cause: error,
            }))
          }
        })
      })
      clientRequest.setTimeout(timeoutMs, () => {
        clientRequest.destroy(new Error('Privilege Helper request timed out'))
      })
      clientRequest.once('error', reject)
      if (body) clientRequest.write(body)
      clientRequest.end()
    })
  }

  private async loadCredential(): Promise<PrivilegeClientCredential> {
    if (this.credential) return this.credential
    const metadata = await lstat(this.credentialPath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('Privilege Helper credential is not a regular file')
    }
    if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
      throw new Error('Privilege Helper credential must not be accessible by group or others')
    }
    if (
      process.getuid?.() !== undefined
      && process.getuid() !== 0
      && metadata.uid !== process.getuid()
    ) {
      throw new Error('Privilege Helper credential must be owned by the Gateway user')
    }
    const parsed = privilegeClientCredentialSchema.parse(
      JSON.parse(await readFile(this.credentialPath, 'utf8')),
    )
    const token = Buffer.from(parsed.token, 'base64url')
    if (token.length !== 32) {
      throw new Error('Privilege Helper credential token is invalid')
    }
    this.credential = parsed
    return parsed
  }
}
