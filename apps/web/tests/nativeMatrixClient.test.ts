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
    tauri.listener?.({ payload: { kind: 'sync_error', message: 'temporary outage' } })
    tauri.listener?.({ payload: { kind: 'session_error', message: 'token expired' } })
    tauri.listener?.({ payload: {
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

  it('drops undefined and malformed native payloads without poisoning the event backlog', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const client = new NativeMatrixClient()
    await client.restore({ homeserver: 'https://matrix.test', userId: '@codever:test', deviceId: 'PHONE' }, 'matrix-primary')

    tauri.listener?.({ payload: undefined })
    tauri.listener?.({ payload: { roomId: '!control:test' } })
    const replayed: unknown[] = []
    client.subscribe(event => replayed.push(event))

    expect(replayed).toEqual([])
    expect(error).toHaveBeenCalledTimes(2)
    error.mockRestore()
  })
})
