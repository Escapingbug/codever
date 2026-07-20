import { describe, expect, it, vi } from 'vitest'
import { createClientSession, friendlyCodeverError, MATRIX_SYNC_STALE_MS, normalizeHomeserver } from '../src/state/clientSession'
import type { NativeMatrixClient } from '../src/api/nativeMatrixClient'

describe('Matrix client session', () => {
  it('preserves native Tauri string errors instead of replacing the actionable cause', () => {
    expect(friendlyCodeverError('Matrix device was not found')).toBe('Matrix device was not found')
    expect(friendlyCodeverError({ message: 'not an Error instance' })).toBe('Unable to connect to Codever')
  })

  it('normalizes one standard-HTTPS server and rejects protocol or port input', () => {
    expect(normalizeHomeserver('rd.anciety.my.id')).toEqual({
      domain: 'rd.anciety.my.id', homeserver: 'https://rd.anciety.my.id',
    })
    expect(() => normalizeHomeserver('https://rd.anciety.my.id')).toThrow('only the server domain')
    expect(() => normalizeHomeserver('rd.anciety.my.id:8787')).toThrow('standard HTTPS port')
  })

  it('logs in, discovers the control room, and stores only public identity metadata', async () => {
    const native = fakeNative()
    const storage = memoryStorage()
    const session = createClientSession(storage, native.value)
    session.configureServer('rd.anciety.my.id')
    await session.login('codever', 'secret')
    expect(native.login).toHaveBeenCalledWith(expect.objectContaining({ username: 'codever', password: 'secret' }))
    expect(session.identity.value).toMatchObject({ controlRoomId: '!control:test', executionKeyId: 'key-1' })
    expect(storage.getItem('codever.client.matrix.v1')).not.toContain('secret')
    expect(session.isAuthenticated.value).toBe(true)
  })

  it('restores the native Matrix session without requiring the password again', async () => {
    const storage = memoryStorage()
    const first = fakeNative()
    const session = createClientSession(storage, first.value)
    session.configureServer('rd.anciety.my.id')
    await session.login('codever', 'secret')
    const second = fakeNative()
    const restored = createClientSession(storage, second.value)
    await restored.initialize()
    expect(second.restore).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'PHONE' }), 'matrix-primary')
    expect(restored.isAuthenticated.value).toBe(true)
  })

  it('retries a failed startup restore instead of remaining permanently disconnected', async () => {
    const storage = memoryStorage()
    const first = fakeNative()
    const session = createClientSession(storage, first.value)
    session.configureServer('rd.anciety.my.id')
    await session.login('codever', 'secret')

    const second = fakeNative()
    second.restore.mockRejectedValueOnce(new Error('temporary network failure'))
    const restored = createClientSession(storage, second.value)
    await restored.initialize()
    expect(restored.connectionState.value).toBe('disconnected')
    expect(restored.initializationError.value).toBe('temporary network failure')

    await restored.resume()
    expect(second.restore).toHaveBeenCalledTimes(2)
    expect(restored.connectionState.value).toBe('connected')
    expect(restored.initializationError.value).toBe('')
    restored.destroy()
  })

  it('rebuilds the native transport after a live Matrix sync error', async () => {
    vi.useFakeTimers()
    try {
      const storage = memoryStorage()
      const first = fakeNative()
      const session = createClientSession(storage, first.value)
      session.configureServer('rd.anciety.my.id')
      await session.login('codever', 'secret')

      const second = fakeNative()
      const restored = createClientSession(storage, second.value)
      await restored.initialize()
      second.emitStatus({ kind: 'sync_error', message: 'sync stream stopped' })
      expect(restored.connectionState.value).toBe('reconnecting')

      await vi.advanceTimersByTimeAsync(1_000)
      expect(second.restore).toHaveBeenCalledTimes(2)
      expect(restored.connectionState.value).toBe('connected')
      expect(restored.initializationError.value).toBe('')
      restored.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not tear down a healthy SDK session merely because the room is quiet', async () => {
    vi.useFakeTimers()
    try {
      const storage = memoryStorage()
      const first = fakeNative()
      const session = createClientSession(storage, first.value)
      session.configureServer('rd.anciety.my.id')
      await session.login('codever', 'secret')
      session.destroy()
      const second = fakeNative()
      const restored = createClientSession(storage, second.value)
      await restored.initialize()

      await vi.advanceTimersByTimeAsync(MATRIX_SYNC_STALE_MS)

      expect(restored.connectionState.value).toBe('connected')
      expect(restored.initializationError.value).toBe('')
      expect(second.restore).toHaveBeenCalledOnce()
      restored.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the connection live while native sync completions arrive', async () => {
    vi.useFakeTimers()
    try {
      const storage = memoryStorage()
      const first = fakeNative()
      const session = createClientSession(storage, first.value)
      session.configureServer('rd.anciety.my.id')
      await session.login('codever', 'secret')
      session.destroy()
      const second = fakeNative()
      const restored = createClientSession(storage, second.value)
      await restored.initialize()

      await vi.advanceTimersByTimeAsync(MATRIX_SYNC_STALE_MS - 1_000)
      second.emitStatus({ kind: 'sync_healthy', message: 'Matrix sync is active' })
      await vi.advanceTimersByTimeAsync(MATRIX_SYNC_STALE_MS - 1_000)

      expect(restored.connectionState.value).toBe('connected')
      restored.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('coalesces repeated sync errors into one transport rebuild', async () => {
    vi.useFakeTimers()
    try {
      const storage = memoryStorage()
      const first = fakeNative()
      const session = createClientSession(storage, first.value)
      session.configureServer('rd.anciety.my.id')
      await session.login('codever', 'secret')

      const second = fakeNative()
      const restored = createClientSession(storage, second.value)
      await restored.initialize()
      second.emitStatus({ kind: 'sync_error', message: 'network changed' })
      second.emitStatus({ kind: 'sync_error', message: 'request timed out' })
      second.emitStatus({ kind: 'sync_error', message: 'connection reset' })

      await vi.advanceTimersByTimeAsync(1_000)

      expect(second.restore).toHaveBeenCalledTimes(2)
      expect((second.value.close as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2)
      expect(restored.connectionState.value).toBe('connected')
      restored.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a queued reconnect after the client session is destroyed', async () => {
    vi.useFakeTimers()
    try {
      const storage = memoryStorage()
      const first = fakeNative()
      const session = createClientSession(storage, first.value)
      session.configureServer('rd.anciety.my.id')
      await session.login('codever', 'secret')

      const second = fakeNative()
      const restored = createClientSession(storage, second.value)
      await restored.initialize()
      second.emitStatus({ kind: 'sync_error', message: 'temporary outage' })
      restored.destroy()
      await vi.advanceTimersByTimeAsync(30_000)

      expect(second.restore).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops retrying an invalid refresh token and renews the same Matrix device', async () => {
    vi.useFakeTimers()
    try {
      const storage = memoryStorage()
      const first = fakeNative()
      const session = createClientSession(storage, first.value)
      session.configureServer('rd.anciety.my.id')
      await session.login('codever', 'secret')

      const second = fakeNative()
      const restored = createClientSession(storage, second.value)
      await restored.initialize()
      second.emitStatus({ kind: 'session_error', message: "[403 / M_FORBIDDEN] refresh token isn't valid anymore" })

      expect(restored.reauthenticationRequired.value).toBe(true)
      expect(restored.connectionState.value).toBe('disconnected')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(second.restore).toHaveBeenCalledTimes(1)

      await restored.reauthenticate('renew-secret')
      expect(second.reauthenticate).toHaveBeenCalledWith(expect.objectContaining({
        password: 'renew-secret',
        session: expect.objectContaining({ deviceId: 'PHONE' }),
      }))
      expect(restored.identity.value?.session.deviceId).toBe('PHONE')
      expect(restored.reauthenticationRequired.value).toBe(false)
      expect(restored.connectionState.value).toBe('connected')
      restored.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores after native status notifications were queued before the API subscribes', async () => {
    const storage = memoryStorage()
    const first = fakeNative()
    const session = createClientSession(storage, first.value)
    session.configureServer('rd.anciety.my.id')
    await session.login('codever', 'secret')

    const second = fakeNative([
      { kind: 'sync_error', message: 'temporary outage' },
      { kind: 'session_error', message: 'token refresh failed' },
    ])
    const restored = createClientSession(storage, second.value)

    await expect(restored.initialize()).resolves.toBeUndefined()
    expect(restored.initialized.value).toBe(true)
    expect(restored.isAuthenticated.value).toBe(true)
    expect(restored.connectionState.value).toBe('connected')
    expect(restored.initializationError.value).toBe('')
  })
})

function fakeNative(backlog: unknown[] = []) {
  const listeners = new Set<(value: unknown) => void>()
  const statusListeners = new Set<(value: unknown) => void>()
  const login = vi.fn(async () => ({ homeserver: 'https://rd.anciety.my.id', userId: '@codever:test', deviceId: 'PHONE' }))
  const restore = vi.fn(async () => undefined)
  const reauthenticate = vi.fn(async (input: { session: unknown }) => input.session)
  const value = {
    login, restore, reauthenticate,
    ensureControlRoom: vi.fn(async () => '!control:test'),
    createExecutionIdentity: vi.fn(async () => ({ keyId: 'key-1', publicKey: { kty: 'EC' } })),
    close: vi.fn(async () => undefined),
    subscribeStatus: vi.fn((listener: (value: unknown) => void) => {
      statusListeners.add(listener)
      for (const value of backlog) listener(value)
      return () => statusListeners.delete(listener)
    }),
    subscribe: vi.fn((listener: (value: unknown) => void) => {
      listeners.add(listener)
      for (const value of backlog) listener(value)
      return () => listeners.delete(listener)
    }),
    signExecution: vi.fn(async () => 'token'),
    send: vi.fn(async () => '$event'),
  } as unknown as NativeMatrixClient
  return {
    value, login, restore, reauthenticate,
    emitStatus(value: unknown) { for (const listener of statusListeners) listener(value) },
  }
}

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size }, clear: () => values.clear(),
    getItem: key => values.get(key) ?? null, key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key) }, setItem: (key, value) => { values.set(key, value) },
  }
}
