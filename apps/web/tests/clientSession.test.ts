import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClientSession, normalizeRelayUrl } from '../src/state/clientSession'

const timestamp = '2026-07-16T08:00:00.000Z'

describe('client session', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('persists multiple Relay profiles and the active selection', async () => {
    const storage = new MemoryStorage()
    const first = createClientSession(storage)
    const home = first.saveProfile({ name: 'Home', baseUrl: 'https://home.example.test/' })
    const work = first.saveProfile({ name: 'Work', baseUrl: 'https://work.example.test/api/' })
    first.selectProfile(home.id)

    const restored = createClientSession(storage)
    await restored.initialize()

    expect(restored.profiles.value).toEqual([home, work])
    expect(restored.activeProfile.value).toEqual(home)
    restored.removeProfile(home.id)
    expect(restored.activeProfile.value).toEqual(work)
  })

  it('stores authentication independently for each profile and restores it through session validation', async () => {
    const storage = new MemoryStorage()
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        accessToken: 'token-for-home-profile', expiresAt: timestamp,
        user: { id: 'user-1', username: 'alice', workspaceId: 'workspace-1', roles: ['operator'] },
      }))
      .mockResolvedValueOnce(jsonResponse({
        expiresAt: timestamp,
        user: { id: 'user-1', username: 'alice', workspaceId: 'workspace-1', roles: ['operator'] },
      }))
    vi.stubGlobal('fetch', fetcher)
    const first = createClientSession(storage)
    first.saveProfile({ name: 'Home', baseUrl: 'https://home.example.test' })
    await first.login({ username: 'alice', password: 'password', deviceName: 'phone' })

    const restored = createClientSession(storage)
    await restored.initialize()

    expect(restored.isAuthenticated.value).toBe(true)
    expect(restored.activeAuth.value?.user.username).toBe('alice')
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://home.example.test/v1/auth/session')
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe('Bearer token-for-home-profile')
  })

  it('clears only the active profile session after a 401', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        accessToken: 'token-that-is-long-enough', expiresAt: timestamp,
        user: { id: 'user-1', username: 'alice', workspaceId: 'workspace-1', roles: ['viewer'] },
      }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 })))
    const session = createClientSession(new MemoryStorage())
    session.saveProfile({ name: 'Home', baseUrl: 'https://home.example.test' })
    await session.login({ username: 'alice', password: 'password' })
    const unauthorized = vi.fn()
    session.onUnauthorized(unauthorized)

    await expect(session.api.getAuthSession()).rejects.toMatchObject({ status: 401 })
    expect(session.isAuthenticated.value).toBe(false)
    expect(unauthorized).toHaveBeenCalledOnce()
  })

  it('normalizes URLs and rejects unsafe schemes', () => {
    expect(normalizeRelayUrl(' https://relay.example.test/api/ ')).toBe('https://relay.example.test/api')
    expect(() => normalizeRelayUrl('file:///relay')).toThrow('http:// or https://')
  })

  it('drops credentials when an existing profile points to another Relay', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      accessToken: 'token-that-is-long-enough', expiresAt: timestamp,
      user: { id: 'user-1', username: 'alice', workspaceId: 'workspace-1', roles: ['operator'] },
    })))
    const session = createClientSession(new MemoryStorage())
    const profile = session.saveProfile({ name: 'Home', baseUrl: 'https://home.example.test' })
    await session.login({ username: 'alice', password: 'password' })

    session.saveProfile({ id: profile.id, name: 'Home', baseUrl: 'https://other.example.test' })

    expect(session.isAuthenticated.value).toBe(false)
  })
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}
