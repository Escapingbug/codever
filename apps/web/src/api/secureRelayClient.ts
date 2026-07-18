import type { RelaySecureHandshake } from '../security/relaySecureHandshake'

export class SecureRelayClient {
  private socket?: WebSocket
  private connectState?: Deferred<void>
  private failure?: Error
  private incoming = Promise.resolve()

  constructor(private readonly options: {
    baseUrl: string
    handshake: RelaySecureHandshake
    webSocketFactory?: (url: string) => WebSocket
    onError?: (error: Error) => void
    connectTimeoutMs?: number
    handshakeTimeoutMs?: number
    requestTimeoutMs?: number
  }) {}

  connect(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.options.handshake.ready && this.socket?.readyState === 1) return Promise.resolve()
    if (this.connectState) return this.connectState.promise
    this.connectState = deferred<void>()
    try {
      const endpoint = this.url()
      const socket = (this.options.webSocketFactory ?? (url => new WebSocket(url)))(endpoint)
      this.socket = socket
      let handshakeTimer: ReturnType<typeof setTimeout> | undefined
      const connectTimer = setTimeout(
        () => this.fail(new Error('Secure Relay connection timed out before the server accepted the socket')),
        this.connectTimeoutMs,
      )
      const clearTimers = () => {
        clearTimeout(connectTimer)
        if (handshakeTimer) clearTimeout(handshakeTimer)
      }
      this.connectState.promise.then(clearTimers, clearTimers)
      socket.addEventListener('open', () => {
        clearTimeout(connectTimer)
        handshakeTimer = setTimeout(
          () => this.fail(new Error('Secure Relay pairing timed out while creating or verifying credentials')),
          this.handshakeTimeoutMs,
        )
        void this.options.handshake.start().then(frame => this.sendRaw(frame)).catch(error => this.fail(asError(error)))
      })
      socket.addEventListener('message', event => {
        this.incoming = this.incoming.then(() => this.handleMessage(event.data)).catch(error => this.fail(asError(error)))
      })
      socket.addEventListener('error', () => this.fail(new Error(
        `Could not reach Relay at ${new URL(endpoint).host}. The pairing code was not checked. Verify the domain and Advanced port.`,
      )))
      socket.addEventListener('close', event => this.fail(new Error(event.code === 1008
        ? (this.options.handshake.ready
            ? 'Relay rejected the authenticated secure session because of a protocol error.'
            : 'Relay rejected this pairing attempt. Generate a fresh Relay client code and try again within three minutes.')
        : `Secure Relay connection closed (${event.code})`)))
    } catch (error) {
      this.fail(asError(error))
    }
    return this.connectState.promise
  }

  close(notify = true): void {
    this.socket?.close(1000, 'Client closed')
    this.socket = undefined
    const error = new Error('Secure Relay client closed')
    if (notify) {
      this.fail(error)
      return
    }
    this.failure = error
    this.connectState?.reject(error)
    this.connectState = undefined
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const value = typeof raw === 'string' ? JSON.parse(raw) as unknown : JSON.parse(await (raw as Blob).text()) as unknown
    if (!this.options.handshake.ready) {
      const output = await this.options.handshake.handle(value)
      if (output) this.sendRaw(output)
      if (this.options.handshake.ready) {
        this.connectState?.resolve(undefined)
        this.connectState = undefined
      }
      return
    }
    throw new Error('Relay pairing socket sent data after provisioning completed')
  }

  private sendRaw(value: unknown): void {
    if (this.socket?.readyState !== 1) throw new Error('Secure Relay socket is not open')
    this.socket.send(JSON.stringify(value))
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    const socket = this.socket
    this.socket = undefined
    if (socket?.readyState === 0 || socket?.readyState === 1) socket.close(4001, 'Secure session failed')
    this.options.onError?.(error)
    this.connectState?.reject(error)
    this.connectState = undefined
  }

  private get connectTimeoutMs(): number { return this.options.connectTimeoutMs ?? this.options.requestTimeoutMs ?? 30_000 }
  private get handshakeTimeoutMs(): number { return this.options.handshakeTimeoutMs ?? 120_000 }

  private url(): string {
    const url = new URL(this.options.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = `${url.pathname.replace(/\/$/, '')}/v2/client/connect`
    url.search = ''
    return url.toString()
  }
}

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}
function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)) }
