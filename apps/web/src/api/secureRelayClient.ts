import {
  PROTOCOL_VERSION,
  parseRelayClientGatewaysResponseFrame,
  parseRelayDeviceTunnelFrame,
  type ClientDeviceTunnelRequestFrame,
  type ClientGatewayEventFrame,
  type ClientGatewayRequestPayload,
  type ClientGatewayResponseFrame,
  type Gateway,
  type RelayDeviceTunnelFrame,
} from '@codever/protocol'
import type { DeviceSecureHandshake } from '../security/deviceSecureHandshake'
import type { RelaySecureHandshake } from '../security/relaySecureHandshake'

export class SecureRelayClient {
  private socket?: WebSocket
  private connectState?: Deferred<void>
  private incoming = Promise.resolve()
  private readonly gatewayListRequests = new Map<string, Deferred<Gateway[]>>()
  private readonly openingGateways = new Map<string, GatewaySecureConnection>()
  private readonly tunnels = new Map<string, GatewaySecureConnection>()

  constructor(private readonly options: {
    baseUrl: string
    handshake: RelaySecureHandshake
    webSocketFactory?: (url: string) => WebSocket
    onError?: (error: Error) => void
  }) {}

  connect(): Promise<void> {
    if (this.options.handshake.ready && this.socket?.readyState === 1) return Promise.resolve()
    if (this.connectState) return this.connectState.promise
    this.connectState = deferred<void>()
    try {
      const socket = (this.options.webSocketFactory ?? (url => new WebSocket(url)))(this.url())
      this.socket = socket
      socket.addEventListener('open', () => {
        void this.options.handshake.start().then(frame => this.sendRaw(frame)).catch(error => this.fail(asError(error)))
      })
      socket.addEventListener('message', event => {
        this.incoming = this.incoming.then(() => this.handleMessage(event.data)).catch(error => this.fail(asError(error)))
      })
      socket.addEventListener('error', () => this.fail(new Error('Secure Relay connection failed')))
      socket.addEventListener('close', event => this.fail(new Error(`Secure Relay connection closed (${event.code})`)))
    } catch (error) {
      this.fail(asError(error))
    }
    return this.connectState.promise
  }

  async listGateways(): Promise<Gateway[]> {
    await this.connect()
    const requestId = id()
    const waiting = deferred<Gateway[]>()
    this.gatewayListRequests.set(requestId, waiting)
    await this.sendSecure({ version: PROTOCOL_VERSION, type: 'client.relay.gateways.request', requestId })
    return waiting.promise
  }

  async openGateway(gatewayId: string, handshake: DeviceSecureHandshake, onEvent?: (event: ClientGatewayEventFrame) => void): Promise<GatewaySecureConnection> {
    await this.connect()
    if (this.openingGateways.has(gatewayId)) throw new Error(`Gateway ${gatewayId} is already opening`)
    const connection = new GatewaySecureConnection(gatewayId, handshake, frame => this.sendSecure(frame), onEvent)
    this.openingGateways.set(gatewayId, connection)
    await this.sendSecure({
      version: PROTOCOL_VERSION,
      type: 'device.tunnel.open',
      messageId: id(),
      payload: { gatewayId },
    } satisfies ClientDeviceTunnelRequestFrame)
    try {
      await connection.connected
      return connection
    } finally {
      this.openingGateways.delete(gatewayId)
    }
  }

  close(): void {
    this.socket?.close(1000, 'Client closed')
    this.socket = undefined
    this.fail(new Error('Secure Relay client closed'))
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
    const plaintext = await this.options.handshake.decrypt(value)
    if (plaintext && typeof plaintext === 'object' && 'type' in plaintext
      && plaintext.type === 'relay.client.gateways.response') {
      const response = parseRelayClientGatewaysResponseFrame(plaintext)
      const waiting = this.gatewayListRequests.get(response.requestId)
      if (waiting) {
        this.gatewayListRequests.delete(response.requestId)
        waiting.resolve(response.gateways)
      }
      return
    }
    const tunnel = parseRelayDeviceTunnelFrame(plaintext)
    await this.handleTunnel(tunnel)
  }

  private async handleTunnel(frame: RelayDeviceTunnelFrame): Promise<void> {
    if (frame.type === 'relay.device-tunnel.opened') {
      const connection = this.openingGateways.get(frame.payload.gatewayId)
      if (!connection) throw new Error(`Unexpected tunnel for Gateway ${frame.payload.gatewayId}`)
      this.tunnels.set(frame.payload.tunnelId, connection)
      await connection.open(frame.payload.tunnelId)
      return
    }
    const connection = this.tunnels.get(frame.payload.tunnelId)
    if (!connection) throw new Error(`Unknown device tunnel ${frame.payload.tunnelId}`)
    if (frame.type === 'relay.device-tunnel.closed') {
      this.tunnels.delete(frame.payload.tunnelId)
      connection.fail(new Error(frame.payload.reason ?? frame.payload.code))
      return
    }
    await connection.receive(frame.payload.opaquePayload)
  }

  private async sendSecure(value: unknown): Promise<void> { this.sendRaw(await this.options.handshake.encrypt(value)) }

  private sendRaw(value: unknown): void {
    if (this.socket?.readyState !== 1) throw new Error('Secure Relay socket is not open')
    this.socket.send(JSON.stringify(value))
  }

  private fail(error: Error): void {
    this.options.onError?.(error)
    this.connectState?.reject(error)
    this.connectState = undefined
    for (const waiting of this.gatewayListRequests.values()) waiting.reject(error)
    this.gatewayListRequests.clear()
    for (const connection of new Set([...this.openingGateways.values(), ...this.tunnels.values()])) connection.fail(error)
    this.openingGateways.clear()
    this.tunnels.clear()
  }

  private url(): string {
    const url = new URL(this.options.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = `${url.pathname.replace(/\/$/, '')}/v2/client/connect`
    url.search = ''
    return url.toString()
  }
}

export class GatewaySecureConnection {
  private tunnelId?: string
  private readonly connectState = deferred<void>()
  private readonly requests = new Map<string, Deferred<ClientGatewayResponseFrame>>()

  constructor(
    readonly gatewayId: string,
    private readonly handshake: DeviceSecureHandshake,
    private readonly sendOuter: (frame: ClientDeviceTunnelRequestFrame) => Promise<void>,
    private readonly onEvent?: (event: ClientGatewayEventFrame) => void,
  ) {}

  get connected(): Promise<void> { return this.connectState.promise }

  async open(tunnelId: string): Promise<void> {
    this.tunnelId = tunnelId
    await this.sendData(await this.handshake.start())
  }

  async receive(opaquePayload: string): Promise<void> {
    if (!this.handshake.ready) {
      const output = await this.handshake.handle(opaquePayload)
      if (output) await this.sendData(output)
      if (this.handshake.ready) this.connectState.resolve(undefined)
      return
    }
    const frame = await this.handshake.decryptFrame(opaquePayload)
    if (frame.type === 'gateway.client.event') {
      this.onEvent?.(frame)
      return
    }
    if (frame.type !== 'gateway.client.response') throw new Error('Unexpected Gateway client frame')
    const waiting = this.requests.get(frame.requestId)
    if (!waiting) return
    this.requests.delete(frame.requestId)
    waiting.resolve(frame)
  }

  async request(payload: ClientGatewayRequestPayload, idempotencyKey = id()): Promise<ClientGatewayResponseFrame> {
    await this.connected
    const requestId = id()
    const waiting = deferred<ClientGatewayResponseFrame>()
    this.requests.set(requestId, waiting)
    try {
      await this.sendData(await this.handshake.encryptRequest({
        version: PROTOCOL_VERSION,
        type: 'client.gateway.request',
        requestId,
        idempotencyKey,
        payload,
      }))
    } catch (error) {
      this.requests.delete(requestId)
      throw error
    }
    return waiting.promise
  }

  fail(error: Error): void {
    this.connectState.reject(error)
    for (const request of this.requests.values()) request.reject(error)
    this.requests.clear()
  }

  private sendData(opaquePayload: string): Promise<void> {
    if (!this.tunnelId) throw new Error('Gateway tunnel is not open')
    return this.sendOuter({
      version: PROTOCOL_VERSION,
      type: 'device.tunnel.data',
      messageId: id(),
      payload: { tunnelId: this.tunnelId, opaquePayload },
    })
  }
}

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
function id(): string { return globalThis.crypto.randomUUID() }
function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)) }
