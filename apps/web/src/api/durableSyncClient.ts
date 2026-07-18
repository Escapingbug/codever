import {
  CODEVER_STREAMS,
  InventorySnapshotSchema,
  PROTOCOL_VERSION,
  clientConsumerName,
  gatewayCommandsSubject,
  parseClientGatewayResponseFrame,
  parseDurableCommandEnvelope,
  parseDurableEventEnvelope,
  parseDurableInventoryEnvelope,
  parseDurableResponseEnvelope,
  parseGatewayPresenceEnvelope,
  parseSessionEventEnvelope,
  type ClientGatewayRequestPayload,
  type ClientGatewayResponseFrame,
  type DurableCommandEnvelope,
  type InventorySnapshot,
  type Gateway,
  type SessionEventEnvelope,
  type StandardConversationEvent,
} from '@codever/protocol'
import { HpkeMessageCipher, type HpkeEnvelope } from '@codever/secure-channel'
import { jetstream, type ConsumerMessages, type JsMsg } from '@nats-io/jetstream'
import {
  jwtAuthenticator,
  wsconnect,
  type NatsConnection,
} from '@nats-io/nats-core'
import type { ClientDeviceCredential, ClientDeviceCredentialStore } from '../security/deviceCredentialStore'
import type { ClientRelayCredential } from '../security/relayCredentialStore'
import type { DurableSessionEventStore } from './sessionEventStore'
import { DurableEventReplayBuffer } from './durableEventReplay'

const COMMAND_TTL_MS = 7 * 24 * 60 * 60_000

class RetryableDurableMessageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RetryableDurableMessageError'
  }
}

export interface DurableSyncClientOptions {
  connection: NatsConnection
  relayCredential: ClientRelayCredential
  deviceCredentials: ClientDeviceCredentialStore
  onEvent: (event: SessionEventEnvelope, standard: StandardConversationEvent) => void | Promise<void>
  onEvents?: (events: Array<{ event: SessionEventEnvelope; standard: StandardConversationEvent }>) => void | Promise<void>
  onInventory: (gatewayId: string, inventory: InventorySnapshot) => void | Promise<void>
  onGateway: (gateway: Gateway) => void | Promise<void>
  responseStore?: DurableResponseStore
  eventStore?: DurableSessionEventStore
  onError?: (error: Error) => void
  now?: () => number
}

export interface DurableResponseStore {
  get(gatewayId: string, commandId: string): Promise<ClientGatewayResponseFrame | undefined>
  put(gatewayId: string, commandId: string, response: ClientGatewayResponseFrame): Promise<void>
}

export async function connectDurableNats(credential: ClientRelayCredential): Promise<NatsConnection> {
  return wsconnect({
    servers: [credential.natsWebSocketUrl],
    name: `codever-client-${credential.credentialId}`,
    authenticator: jwtAuthenticator(credential.natsUserJwt, new TextEncoder().encode(credential.natsSeed)),
    maxReconnectAttempts: -1,
  })
}

/** Client-side durable cursor owner. A disconnect no longer invalidates a request or event stream. */
export class DurableSyncClient {
  private readonly js
  private readonly pending = new Map<string, Deferred<ClientGatewayResponseFrame>>()
  private readonly ciphers = new Map<string, Promise<HpkeMessageCipher>>()
  private readonly consumers: ConsumerMessages[] = []
  private loops: Promise<void>[] = []
  private stopping = false
  private readonly eventReplay = new DurableEventReplayBuffer<{
    codever: SessionEventEnvelope
    standard: StandardConversationEvent
  }>()

  constructor(private readonly options: DurableSyncClientOptions) {
    this.js = jetstream(options.connection)
  }

  async start(): Promise<void> {
    if (this.loops.length) return
    this.stopping = false
    const clientId = this.options.relayCredential.credentialId
    const specs = [
      { stream: CODEVER_STREAMS.responses, channel: 'responses' as const, handler: (msg: JsMsg) => this.response(msg) },
      { stream: CODEVER_STREAMS.events, channel: 'events' as const, handler: (msg: JsMsg) => this.event(msg) },
      { stream: CODEVER_STREAMS.inventory, channel: 'inventory' as const, handler: (msg: JsMsg) => this.inventory(msg) },
      { stream: CODEVER_STREAMS.presence, channel: 'presence' as const, handler: (msg: JsMsg) => this.presence(msg) },
    ]
    for (const spec of specs) {
      const consumer = await this.js.consumers.get(spec.stream, clientConsumerName(clientId, spec.channel))
      const messages = await consumer.consume({ max_messages: 128 })
      this.consumers.push(messages)
      const loop = this.consume(messages, spec.handler)
      this.loops.push(loop)
      void loop.catch(error => { if (!this.stopping) this.report(error) })
    }
  }

  async close(): Promise<void> {
    this.stopping = true
    await Promise.all(this.consumers.map(consumer => consumer.close()))
    await Promise.all(this.loops.map(loop => loop.catch(() => undefined)))
    this.consumers.length = 0
    this.loops = []
    const error = new Error('Durable synchronization client closed')
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  beginEventReplay(): void {
    this.eventReplay.begin()
  }

  async request(
    gatewayId: string,
    payload: ClientGatewayRequestPayload,
    idempotencyKey = crypto.randomUUID(),
    timeoutMs = 30_000,
  ): Promise<ClientGatewayResponseFrame> {
    const cached = await this.options.responseStore?.get(gatewayId, idempotencyKey)
    if (cached) return cached
    const credential = await this.deviceCredential(gatewayId)
    const cipher = await this.cipher(gatewayId, credential)
    const requestId = crypto.randomUUID()
    const messageId = crypto.randomUUID()
    const expiresAt = commandExpiry(payload)
    const encrypted = await cipher.encrypt({
      version: PROTOCOL_VERSION,
      type: 'client.gateway.request',
      requestId,
      idempotencyKey,
      payload,
    }, {
      messageId,
      ttlMs: expiresAt ? Math.max(1, Date.parse(expiresAt) - this.now()) : COMMAND_TTL_MS,
    })
    const command: DurableCommandEnvelope = parseDurableCommandEnvelope({
      version: PROTOCOL_VERSION,
      kind: 'codever.command',
      messageId,
      commandId: idempotencyKey,
      gatewayId,
      credentialId: credential.credentialId,
      createdAt: new Date(this.now()).toISOString(),
      ...(expiresAt ? { expiresAt } : {}),
      opaquePayload: JSON.stringify(encrypted),
    })
    const waiting = deferred<ClientGatewayResponseFrame>()
    this.pending.set(idempotencyKey, waiting)
    try {
      const raced = await this.options.responseStore?.get(gatewayId, idempotencyKey)
      if (raced) return raced
      await this.js.publish(gatewayCommandsSubject(gatewayId), encode(command), {
        msgID: `${credential.credentialId}:${gatewayId}:${idempotencyKey}`,
      })
      return await withTimeout(waiting.promise, timeoutMs, 'Gateway command is still pending')
    } finally {
      if (this.pending.get(idempotencyKey) === waiting) this.pending.delete(idempotencyKey)
    }
  }

  private async consume(messages: ConsumerMessages, handler: (message: JsMsg) => Promise<void>): Promise<void> {
    for await (const message of messages) {
      if (this.stopping) return
      try {
        await handler(message)
        if (!await message.ackAck()) throw new Error('JetStream did not confirm the Client acknowledgement')
      } catch (error) {
        this.report(error)
        if (error instanceof RetryableDurableMessageError) message.nak(1_000)
        else message.term(error instanceof Error ? error.message : 'Invalid durable Client message')
      }
    }
  }

  private async response(message: JsMsg): Promise<void> {
    const outer = parseDurableResponseEnvelope(message.json())
    this.assertClient(outer.credentialId)
    const credential = await this.deviceCredential(outer.gatewayId)
    const cipher = await this.cipher(outer.gatewayId, credential)
    const response = parseClientGatewayResponseFrame(await cipher.decrypt(parseEncrypted(outer.opaquePayload)))
    await this.options.responseStore?.put(outer.gatewayId, outer.commandId, response)
    this.pending.get(outer.commandId)?.resolve(response)
  }

  private async event(message: JsMsg): Promise<void> {
    const outer = parseDurableEventEnvelope(message.json())
    this.assertClient(outer.credentialId)
    const credential = await this.deviceCredential(outer.gatewayId)
    const cipher = await this.cipher(outer.gatewayId, credential)
    const value = await cipher.decrypt(parseEncrypted(outer.opaquePayload)) as Partial<StandardConversationEvent>
    const codever = parseSessionEventEnvelope(value.codever)
    try {
      await this.options.eventStore?.merge(codever)
    } catch (error) {
      throw new RetryableDurableMessageError('The durable event could not be committed to the Client cache', {
        cause: error,
      })
    }
    const standard = { ...value, codever } as StandardConversationEvent
    await this.eventReplay.deliver({ codever, standard }, message.info.pending, async buffered => {
      if (this.options.onEvents) {
        await this.options.onEvents(buffered.map(event => ({ event: event.codever, standard: event.standard })))
      } else {
        for (const event of buffered) await this.options.onEvent(event.codever, event.standard)
      }
    })
  }

  private async inventory(message: JsMsg): Promise<void> {
    const outer = parseDurableInventoryEnvelope(message.json())
    this.assertClient(outer.credentialId)
    const credential = await this.deviceCredential(outer.gatewayId)
    const cipher = await this.cipher(outer.gatewayId, credential)
    const inventory = InventorySnapshotSchema.parse(await cipher.decrypt(parseEncrypted(outer.opaquePayload)))
    await this.options.onInventory(outer.gatewayId, inventory)
  }

  private async presence(message: JsMsg): Promise<void> {
    const outer = parseGatewayPresenceEnvelope(message.json())
    await this.options.onGateway(outer.gateway)
  }

  private async deviceCredential(gatewayId: string): Promise<ClientDeviceCredential> {
    const clientId = this.options.relayCredential.credentialId
    const credential = await this.options.deviceCredentials.load(this.options.relayCredential.relayProfileId, gatewayId)
    if (!credential || credential.credentialId !== clientId) throw new Error(`Gateway ${gatewayId} is not paired to this Client identity`)
    return credential
  }

  private cipher(gatewayId: string, credential: ClientDeviceCredential): Promise<HpkeMessageCipher> {
    let cipher = this.ciphers.get(gatewayId)
    if (!cipher) {
      cipher = HpkeMessageCipher.create({
        localId: credential.credentialId,
        remoteId: gatewayId,
        localKeyPair: credential.deviceHpkeKeyPair,
        remoteKey: { keyId: credential.gatewayHpkeKeyId, publicKey: credential.gatewayHpkePublicKey },
        now: () => this.now(),
      })
      this.ciphers.set(gatewayId, cipher)
    }
    return cipher
  }

  private assertClient(credentialId: string): void {
    if (credentialId !== this.options.relayCredential.credentialId) throw new Error('Durable message belongs to another Client')
  }

  private report(value: unknown): void { this.options.onError?.(value instanceof Error ? value : new Error(String(value))) }
  private now(): number { return this.options.now?.() ?? Date.now() }
}

function commandExpiry(payload: ClientGatewayRequestPayload): string | undefined {
  return payload.kind === 'session.message' ? payload.input.expiresAt : undefined
}

function parseEncrypted(value: string): HpkeEnvelope {
  try { return JSON.parse(value) as HpkeEnvelope }
  catch (error) { throw new Error('Durable payload is not a valid HPKE envelope', { cause: error }) }
}

function encode(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(value)) }

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    void promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}
