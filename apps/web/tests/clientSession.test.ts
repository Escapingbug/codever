import { describe, expect, it, vi } from 'vitest'
import { createClientSession, normalizeHomeserver } from '../src/state/clientSession'
import type { NativeMatrixClient } from '../src/api/nativeMatrixClient'

describe('Matrix client session', () => {
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
})

function fakeNative() {
  const listeners = new Set<(value: never) => void>()
  const login = vi.fn(async () => ({ homeserver: 'https://rd.anciety.my.id', userId: '@codever:test', deviceId: 'PHONE' }))
  const restore = vi.fn(async () => undefined)
  const value = {
    login, restore,
    ensureControlRoom: vi.fn(async () => '!control:test'),
    createExecutionIdentity: vi.fn(async () => ({ keyId: 'key-1', publicKey: { kty: 'EC' } })),
    close: vi.fn(async () => undefined),
    subscribe: vi.fn((listener: (value: never) => void) => { listeners.add(listener); return () => listeners.delete(listener) }),
    signExecution: vi.fn(async () => 'token'),
    send: vi.fn(async () => '$event'),
  } as unknown as NativeMatrixClient
  return { value, login, restore }
}

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size }, clear: () => values.clear(),
    getItem: key => values.get(key) ?? null, key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key) }, setItem: (key, value) => { values.set(key, value) },
  }
}
