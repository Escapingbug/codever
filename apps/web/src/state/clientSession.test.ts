import { describe, expect, it, vi } from 'vitest'
import type { MatrixPublicSession, MatrixTransportEvent, MatrixTransportStatus } from '../api/nativeMatrixClient'
import { createClientSession, isMissingCredentialError, isReauthenticationError } from './clientSession'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

class RetainedSessionNative {
  readonly session: MatrixPublicSession = {
    homeserver: 'https://matrix.example', userId: '@codever:matrix.example', deviceId: 'RETAINEDDEVICE',
  }
  readonly restore = vi.fn(async () => { throw new Error('[403 / M_FORBIDDEN] refresh token is not valid anymore') })
  readonly reauthenticate = vi.fn(async () => this.session)
  private statusSubscriber?: (status: MatrixTransportStatus) => void

  subscribeStatus(subscriber: (status: MatrixTransportStatus) => void): () => void {
    this.statusSubscriber = subscriber
    return () => { this.statusSubscriber = undefined }
  }
  subscribe(_subscriber: (event: MatrixTransportEvent) => void): () => void { return () => undefined }
  close(): Promise<void> { return Promise.resolve() }
}

describe('retained Matrix session recovery', () => {
  it('recognizes native and homeserver session-expiry diagnostics', () => {
    expect(isReauthenticationError('Matrix session is no longer valid: UnknownToken')).toBe(true)
    expect(isReauthenticationError("[403 / M_FORBIDDEN] refresh token isn't valid anymore")).toBe(true)
    expect(isReauthenticationError('Temporary Matrix restore failure')).toBe(false)
  })

  it('recognizes Android backup restored without platform credentials', () => {
    expect(isMissingCredentialError('No entry found in secure storage for Matrix credential')).toBe(true)
    expect(isMissingCredentialError('Matrix secret is incomplete')).toBe(true)
  })

  it('renews an expired retained session without changing its Matrix device identity', async () => {
    const storage = new MemoryStorage()
    const native = new RetainedSessionNative()
    storage.setItem('codever.client.matrix.v1', JSON.stringify({
      version: 4,
      server: { domain: 'matrix.example', homeserver: 'https://matrix.example' },
      identity: {
        session: native.session,
        controlRoomId: '!control:matrix.example', executionKeyId: 'execution-key', executionPublicKey: {},
      },
    }))
    const session = createClientSession(storage, native as never)

    await session.initialize()
    expect(session.connectionState.value).toBe('disconnected')
    expect(session.reauthenticationRequired.value).toBe(true)

    await session.reauthenticate('correct horse battery staple')

    expect(native.reauthenticate).toHaveBeenCalledWith(expect.objectContaining({
      session: expect.objectContaining({ deviceId: 'RETAINEDDEVICE' }),
    }))
    expect(session.connectionState.value).toBe('connected')
    expect(session.identity.value?.session.deviceId).toBe('RETAINEDDEVICE')
    expect(session.initializationError.value).toBe('')
  })
})
