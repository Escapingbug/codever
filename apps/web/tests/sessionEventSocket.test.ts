import type { SessionEventEnvelope } from '@codever/protocol'
import { describe, expect, it, vi } from 'vitest'
import { SessionEventSocket } from '../src/api/sessionEventSocket'

type Listener = (event: { data?: unknown }) => void

class FakeWebSocket {
  private listeners = new Map<string, Listener[]>()
  close = vi.fn(() => this.emit('close'))

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener as unknown as Listener)
    this.listeners.set(type, listeners)
  }

  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data })
  }
}

const event = (seq: number): SessionEventEnvelope => ({
  schemaVersion: 1,
  gatewayId: 'gateway-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  seq,
  eventId: `event-${seq}`,
  timestamp: '2026-07-16T08:00:00.000Z',
  event: { kind: 'status', level: 'info', message: `event ${seq}` },
})

describe('SessionEventSocket', () => {
  it('resumes from a cursor and ignores duplicate or stale events', () => {
    const socket = new FakeWebSocket()
    const received = vi.fn()
    const factory = vi.fn((_url: string, _protocols: string[]) => socket as unknown as WebSocket)
    const client = new SessionEventSocket({
      baseUrl: 'https://relay.example.test', sessionId: 'session-1', after: 4,
      webSocketFactory: factory, onEvent: received,
    })

    client.connect()
    socket.emit('open')
    socket.emit('message', JSON.stringify({ type: 'session.event', event: event(5) }))
    socket.emit('message', JSON.stringify(event(5)))
    socket.emit('message', JSON.stringify(event(3)))

    expect(factory).toHaveBeenCalledWith(
      'wss://relay.example.test/v1/sessions/session-1/events/ws?after=4',
      ['codever.events.v1'],
    )
    expect(received).toHaveBeenCalledTimes(1)
    expect(client.getCursor()).toBe(5)
  })

  it('reconnects with the latest cursor', () => {
    const sockets = [new FakeWebSocket(), new FakeWebSocket()]
    const factory = vi.fn(() => sockets.shift()! as unknown as WebSocket)
    let retry: (() => void) | undefined
    const schedule = vi.fn((callback: () => void) => {
      retry = callback
      return 1 as unknown as ReturnType<typeof setTimeout>
    })
    const states: string[] = []
    const client = new SessionEventSocket({
      baseUrl: 'http://localhost:4000/api', sessionId: 'session-1', after: 0,
      webSocketFactory: factory, schedule, random: () => 0.5,
      onEvent: vi.fn(), onStateChange: (state) => states.push(state),
    })

    client.connect()
    const first = factory.mock.results[0]!.value as unknown as FakeWebSocket
    first.emit('message', JSON.stringify(event(1)))
    first.emit('close')
    retry?.()

    expect(factory).toHaveBeenLastCalledWith(
      'ws://localhost:4000/api/v1/sessions/session-1/events/ws?after=1',
      ['codever.events.v1'],
    )
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 750)
    expect(states).toContain('reconnecting')
  })

  it('passes the bearer token as a WebSocket subprotocol and never in the URL', () => {
    const socket = new FakeWebSocket()
    const factory = vi.fn((_url: string, _protocols: string[]) => socket as unknown as WebSocket)
    const client = new SessionEventSocket({
      baseUrl: 'https://relay.example.test', sessionId: 'session-1', accessToken: 'secret-token',
      webSocketFactory: factory, onEvent: vi.fn(),
    })

    client.connect()

    expect(factory).toHaveBeenCalledWith(
      'wss://relay.example.test/v1/sessions/session-1/events/ws?after=0',
      ['codever.events.v1', 'codever.bearer.secret-token'],
    )
    expect(factory.mock.calls[0]?.[0]).not.toContain('secret-token')
  })
})
