import { beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({
  listener: undefined as ((event: { payload: unknown }) => void) | undefined,
  invoke: vi.fn(async () => undefined),
  unlisten: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauri.invoke,
  isTauri: () => true,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, listener: (event: { payload: unknown }) => void) => {
    tauri.listener = listener
    return tauri.unlisten
  }),
}))

import { NativeMatrixClient } from '../src/api/nativeMatrixClient'

describe('NativeMatrixClient event boundary', () => {
  beforeEach(() => {
    tauri.listener = undefined
    tauri.invoke.mockClear()
    tauri.unlisten.mockClear()
  })

  it('separates native sync status from encrypted Matrix timeline events', async () => {
    const client = new NativeMatrixClient()
    const events: unknown[] = []
    const statuses: unknown[] = []
    client.subscribe(event => events.push(event))
    client.subscribeStatus(status => statuses.push(status))

    await client.restore({ homeserver: 'https://matrix.test', userId: '@codever:test', deviceId: 'PHONE' }, 'matrix-primary')
    const connectionId = activeConnectionId()
    tauri.listener?.({ payload: { connectionId, kind: 'sync_error', message: 'temporary outage' } })
    tauri.listener?.({ payload: { connectionId, kind: 'session_error', message: 'token expired' } })
    tauri.listener?.({ payload: {
      connectionId,
      roomId: '!control:test', encrypted: true, verifiedDevice: true,
      event: { type: 'io.codever.gateway.v1', content: { gateway: {} } },
    } })

    expect(statuses).toEqual([
      { kind: 'sync_error', message: 'temporary outage' },
      { kind: 'session_error', message: 'token expired' },
    ])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ event: { type: 'io.codever.gateway.v1' } })
  })

  it('accepts successful sync activity as a transport status', async () => {
    const client = new NativeMatrixClient()
    const statuses: unknown[] = []
    client.subscribeStatus(status => statuses.push(status))
    await client.restore({ homeserver: 'https://example.test', userId: '@user:test', deviceId: 'PHONE' }, 'matrix-primary')

    tauri.listener?.({ payload: { connectionId: activeConnectionId(), kind: 'sync_healthy', message: 'Matrix sync is active' } })

    expect(statuses).toEqual([{ kind: 'sync_healthy', message: 'Matrix sync is active' }])
  })

  it('drops undefined and malformed native payloads without poisoning the event backlog', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const client = new NativeMatrixClient()
    await client.restore({ homeserver: 'https://matrix.test', userId: '@codever:test', deviceId: 'PHONE' }, 'matrix-primary')

    tauri.listener?.({ payload: undefined })
    tauri.listener?.({ payload: { connectionId: activeConnectionId(), roomId: '!control:test' } })
    const replayed: unknown[] = []
    client.subscribe(event => replayed.push(event))

    expect(replayed).toEqual([])
    expect(error).toHaveBeenCalledOnce()
    error.mockRestore()
  })

  it('drops late status and timeline events emitted by a retired native connection', async () => {
    const client = new NativeMatrixClient()
    const statuses: unknown[] = []
    const events: unknown[] = []
    client.subscribeStatus(status => statuses.push(status))
    client.subscribe(event => events.push(event))
    const session = { homeserver: 'https://matrix.test', userId: '@codever:test', deviceId: 'PHONE' }

    await client.restore(session, 'matrix-primary')
    const firstInitialize = invokeCalls().find(call => call[0] === 'matrix_initialize')
    const firstConnectionId = firstInitialize?.[1].connectionId
    expect(firstConnectionId).toEqual(expect.any(String))

    await client.close()
    await client.restore(session, 'matrix-primary')
    const initializeCalls = invokeCalls().filter(call => call[0] === 'matrix_initialize')
    const secondConnectionId = initializeCalls.at(-1)?.[1].connectionId
    expect(secondConnectionId).toEqual(expect.any(String))
    expect(secondConnectionId).not.toBe(firstConnectionId)

    tauri.listener?.({ payload: {
      connectionId: firstConnectionId, kind: 'session_error',
      message: "[403 / M_FORBIDDEN] refresh token isn't valid anymore",
    } })
    tauri.listener?.({ payload: {
      connectionId: firstConnectionId,
      roomId: '!control:test', encrypted: true, verifiedDevice: true,
      event: { type: 'io.codever.gateway.v1', content: { gateway: {} } },
    } })
    tauri.listener?.({ payload: {
      connectionId: secondConnectionId, kind: 'sync_healthy', message: 'Matrix sync is active',
    } })

    expect(statuses).toEqual([{ kind: 'sync_healthy', message: 'Matrix sync is active' }])
    expect(events).toEqual([])
  })
})

function activeConnectionId(): string {
  const calls = invokeCalls().filter(call => call[0] === 'matrix_initialize')
  const value = calls.at(-1)?.[1].connectionId
  if (typeof value !== 'string') throw new Error('matrix_initialize did not receive a connectionId')
  return value
}

function invokeCalls(): Array<[string, Record<string, unknown>]> {
  return tauri.invoke.mock.calls as unknown as Array<[string, Record<string, unknown>]>
}
