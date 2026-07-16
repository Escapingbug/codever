import { describe, expect, it, vi } from 'vitest'
import { RelayApi, RelayApiError } from '../src/api/relayApi'

const timestamp = '2026-07-16T08:00:00.000Z'

describe('RelayApi', () => {
  it('validates typed responses and builds scoped resource URLs', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      gateways: [{
        id: 'gateway-1', workspaceId: 'workspace-1', name: 'Workstation', platform: 'linux',
        version: '0.1.0', status: 'online', capabilities: {
          protocolVersions: [1], providers: ['cursor'], features: ['events'],
        },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const api = new RelayApi({ baseUrl: 'https://relay.example.test/', fetch: fetcher })

    const gateways = await api.listGateways()

    expect(gateways[0]?.name).toBe('Workstation')
    expect(fetcher).toHaveBeenCalledWith(
      'https://relay.example.test/v1/gateways',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
  })

  it('adds an idempotency key to mutations', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      commandId: 'command-1', status: 'relay_accepted', acceptedAt: timestamp,
    }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
    const api = new RelayApi({ baseUrl: 'https://relay.example.test', fetch: fetcher })

    await api.sendMessage('session/one', { text: 'hello' })

    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('https://relay.example.test/v1/sessions/session%2Fone/messages')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBeTruthy()
    expect(JSON.parse(String(init?.body))).toEqual({ text: 'hello' })
  })

  it('surfaces structured Relay errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'gateway_offline', message: 'Gateway is offline' },
    }), { status: 409, headers: { 'Content-Type': 'application/json' } }))
    const api = new RelayApi({ baseUrl: 'https://relay.example.test', fetch: fetcher })

    await expect(api.cancelSession('session-1')).rejects.toEqual(
      expect.objectContaining<Partial<RelayApiError>>({ status: 409, code: 'gateway_offline' }),
    )
  })

  it('uses dynamic Relay settings and implements health and auth APIs', async () => {
    let baseUrl = 'https://one.example.test'
    let token: string | undefined
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        accessToken: 'a'.repeat(24), expiresAt: timestamp,
        user: { id: 'user-1', username: 'alice', workspaceId: 'workspace-1', roles: ['admin'] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        expiresAt: timestamp,
        user: { id: 'user-1', username: 'alice', workspaceId: 'workspace-1', roles: ['admin'] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const api = new RelayApi({ baseUrl: () => baseUrl, getAccessToken: () => token, fetch: fetcher })

    await api.checkHealth()
    const login = await api.login({ username: 'alice', password: 'secret', deviceName: 'phone' })
    token = login.accessToken
    baseUrl = 'https://two.example.test/'
    await api.getAuthSession()

    expect(fetcher.mock.calls[0]?.[0]).toBe('https://one.example.test/health')
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('Authorization')).toBeNull()
    expect(fetcher.mock.calls[2]?.[0]).toBe('https://two.example.test/v1/auth/session')
    expect(new Headers(fetcher.mock.calls[2]?.[1]?.headers).get('Authorization')).toBe(`Bearer ${token}`)
  })

  it('notifies the client when an authenticated request returns 401', async () => {
    const unauthorized = vi.fn()
    const api = new RelayApi({
      baseUrl: 'https://relay.example.test', getAccessToken: () => 'expired', onUnauthorized: unauthorized,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 401 })),
    })

    await expect(api.listGateways()).rejects.toMatchObject({ status: 401 })
    expect(unauthorized).toHaveBeenCalledOnce()
  })
})
