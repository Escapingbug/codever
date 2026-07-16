import { CLIENT_EVENT_PROTOCOL, parseSessionEventEnvelope, type SessionEventEnvelope } from '@codever/protocol'

export type SocketConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'closed'

export interface SessionEventSocketOptions {
  baseUrl: string
  sessionId: string
  accessToken?: string
  after?: number
  webSocketFactory?: (url: string, protocols: string[]) => WebSocket
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  random?: () => number
  onEvent: (event: SessionEventEnvelope) => void
  onStateChange?: (state: SocketConnectionState) => void
  onError?: (error: Error) => void
}

export class SessionEventSocket {
  private socket?: WebSocket
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private reconnectAttempt = 0
  private stopped = false
  private cursor: number
  private readonly seenEventIds = new Set<string>()
  private readonly webSocketFactory: (url: string, protocols: string[]) => WebSocket
  private readonly schedule: NonNullable<SessionEventSocketOptions['schedule']>
  private readonly random: () => number

  constructor(private readonly options: SessionEventSocketOptions) {
    this.cursor = options.after ?? 0
    this.webSocketFactory = options.webSocketFactory ?? ((url, protocols) => new WebSocket(url, protocols))
    this.schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay))
    this.random = options.random ?? Math.random
  }

  connect(): void {
    if (this.socket || this.stopped) return
    this.setState(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting')

    try {
      const socket = this.webSocketFactory(this.buildUrl(), this.buildProtocols())
      this.socket = socket
      socket.addEventListener('open', () => {
        if (socket !== this.socket) return
        this.reconnectAttempt = 0
        this.setState('connected')
      })
      socket.addEventListener('message', (message) => this.handleMessage(message.data))
      socket.addEventListener('error', () => this.options.onError?.(new Error('Live event connection failed')))
      socket.addEventListener('close', () => {
        if (socket !== this.socket) return
        this.socket = undefined
        if (this.stopped) {
          this.setState('closed')
          return
        }
        this.setState('offline')
        this.reconnect()
      })
    } catch (error) {
      this.socket = undefined
      this.options.onError?.(error instanceof Error ? error : new Error('Live event connection failed'))
      this.setState('offline')
      this.reconnect()
    }
  }

  close(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    const socket = this.socket
    this.socket = undefined
    socket?.close()
    this.setState('closed')
  }

  getCursor(): number {
    return this.cursor
  }

  private handleMessage(raw: unknown): void {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw
      const candidate = isSessionEventFrame(parsed) ? parsed.event : parsed
      const envelope = parseSessionEventEnvelope(candidate)
      if (envelope.sessionId !== this.options.sessionId) return
      if (envelope.seq <= this.cursor || this.seenEventIds.has(envelope.eventId)) return
      this.cursor = envelope.seq
      this.seenEventIds.add(envelope.eventId)
      this.options.onEvent(envelope)
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error('Invalid live event'))
    }
  }

  private reconnect(): void {
    this.reconnectAttempt += 1
    const base = Math.min(30_000, 750 * (2 ** (this.reconnectAttempt - 1)))
    const delay = Math.round(base * (0.8 + this.random() * 0.4))
    this.setState('reconnecting')
    this.reconnectTimer = this.schedule(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, delay)
  }

  private buildUrl(): string {
    const fallbackOrigin = typeof globalThis.location === 'undefined' ? 'http://localhost' : globalThis.location.origin
    const url = new URL(this.options.baseUrl, fallbackOrigin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/sessions/${encodeURIComponent(this.options.sessionId)}/events/ws`
    url.search = new URLSearchParams({ after: String(this.cursor) }).toString()
    return url.toString()
  }

  private buildProtocols(): string[] {
    const protocols = [CLIENT_EVENT_PROTOCOL]
    if (this.options.accessToken) protocols.push(`codever.bearer.${this.options.accessToken}`)
    return protocols
  }

  private setState(state: SocketConnectionState): void {
    this.options.onStateChange?.(state)
  }
}

function isSessionEventFrame(value: unknown): value is { type: 'session.event'; event: unknown } {
  return Boolean(value && typeof value === 'object' && (value as Record<string, unknown>).type === 'session.event')
}
