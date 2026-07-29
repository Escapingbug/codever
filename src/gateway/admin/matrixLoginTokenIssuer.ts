import { readFile } from 'node:fs/promises'
import type {
  MatrixLoginTokenIssueResult,
  MatrixLoginTokenIssuer,
} from '@/gateway/pairing'

interface MatrixLoginFile {
  access_token?: unknown
  user_id?: unknown
}

export interface FileMatrixLoginTokenIssuerOptions {
  credentialsPath: string
  fetch?: typeof globalThis.fetch
  now?: () => number
}

export class FileMatrixLoginTokenIssuer implements MatrixLoginTokenIssuer {
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(private readonly options: FileMatrixLoginTokenIssuerOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  async issue(input: {
    homeserver: string
    offerExpiresAt: number
  }): Promise<MatrixLoginTokenIssueResult> {
    let parsed: MatrixLoginFile
    try {
      parsed = JSON.parse(
        await readFile(this.options.credentialsPath, 'utf8'),
      ) as MatrixLoginFile
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return { status: 'unavailable' }
      throw new Error('Could not read the Matrix login credential file', {
        cause: error,
      })
    }
    const accessToken =
      typeof parsed.access_token === 'string' ? parsed.access_token.trim() : ''
    const userId = typeof parsed.user_id === 'string' ? parsed.user_id.trim() : ''
    if (!accessToken || !userId) return { status: 'unavailable' }

    const homeserver = new URL(input.homeserver).origin
    const response = await this.fetchImpl(
      `${homeserver}/_matrix/client/v1/login/get_token`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: '{}',
      },
    )
    const body = await readJson(response)
    if (response.ok) {
      const loginToken =
        typeof body?.login_token === 'string' ? body.login_token : ''
      const expiresInMs =
        typeof body?.expires_in_ms === 'number'
        && Number.isSafeInteger(body.expires_in_ms)
        && body.expires_in_ms > 0
          ? body.expires_in_ms
          : 2 * 60_000
      if (!loginToken) {
        throw new Error('Matrix did not return a one-time login token')
      }
      const now = this.options.now?.() ?? Date.now()
      return {
        status: 'ready',
        invitation: {
          homeserver,
          userId,
          loginToken,
          expiresAt: Math.min(input.offerExpiresAt, now + expiresInMs),
        },
      }
    }
    if (
      response.status === 404
      || response.status === 405
      || body?.errcode === 'M_UNRECOGNIZED'
    ) {
      return { status: 'unsupported' }
    }
    if (response.status === 401) return { status: 'reauth-required' }
    const detail =
      typeof body?.error === 'string' ? `: ${body.error}` : ''
    throw new Error(`Matrix could not create a one-time login token${detail}`)
  }
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value = await response.json() as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code
}
