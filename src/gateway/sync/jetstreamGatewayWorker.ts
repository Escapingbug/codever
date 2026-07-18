import { randomUUID } from 'node:crypto'
import {
    CODEVER_STREAMS,
    clientEventsSubject,
    clientInventorySubject,
    clientResponsesSubject,
    gatewayCommandsSubject,
    gatewayConsumerName,
    gatewayPresenceSubject,
    parseClientGatewayRequestFrame,
    parseDurableCommandEnvelope,
    toStandardConversationEvent,
    type ClientGatewayRequestFrame,
    type ClientGatewayResponseFrame,
    type DurableEventEnvelope,
    type DurableInventoryEnvelope,
    type DurableResponseEnvelope,
    type InventorySnapshot,
    type Gateway,
    type GatewayPresenceEnvelope,
    type SessionEventEnvelope,
} from '@codever/protocol'
import { HpkeMessageCipher, type HpkeEnvelope } from '@codever/secure-channel'
import {
    jetstream,
    type ConsumerMessages,
    type JetStreamClient,
    type JsMsg,
} from '@nats-io/jetstream'
import type { NatsConnection } from '@nats-io/transport-node'
import type { GatewayRequestLedger } from '../requestLedger'
import type { DeviceCredentialRecord, DeviceCredentialRepository } from '../security'

const WORKING_INTERVAL_MS = 10_000
const RESPONSE_TTL_MS = 31 * 24 * 60 * 60_000
const EVENT_TTL_MS = 365 * 24 * 60 * 60_000
const MAX_CONCURRENT_COMMANDS = 16

export interface GatewayJetStreamWorkerOptions {
    connection: NatsConnection
    gatewayId: string
    credentials: DeviceCredentialRepository
    requestLedger: GatewayRequestLedger
    handleRequest: (request: ClientGatewayRequestFrame, credentialId: string) => Promise<ClientGatewayResponseFrame>
    onError?: (error: Error) => void
    now?: () => number
    messageId?: () => string
}

/** Durable replacement for the connection-scoped device tunnel. */
export class GatewayJetStreamWorker {
    private readonly js: JetStreamClient
    private messages?: ConsumerMessages
    private loop?: Promise<void>
    private stopping = false
    private readonly ciphers = new Map<string, { keyId: string; cipher: HpkeMessageCipher }>()

    constructor(private readonly options: GatewayJetStreamWorkerOptions) {
        this.js = jetstream(options.connection)
    }

    async start(): Promise<void> {
        if (this.loop) return
        this.stopping = false
        const name = gatewayConsumerName(this.options.gatewayId)
        const consumer = await this.js.consumers.get(CODEVER_STREAMS.commands, name)
        this.messages = await consumer.consume({ max_messages: MAX_CONCURRENT_COMMANDS })
        this.loop = consumeConcurrently(this.messages, MAX_CONCURRENT_COMMANDS, message => this.process(message))
        void this.loop.catch(error => {
            if (!this.stopping) this.report(error)
        })
    }

    async stop(): Promise<void> {
        this.stopping = true
        await this.messages?.close()
        await this.loop?.catch(() => undefined)
        this.messages = undefined
        this.loop = undefined
    }

    async publishEvent(envelope: SessionEventEnvelope): Promise<void> {
        const payload = toStandardConversationEvent(envelope)
        await this.publishToEnabledClients(async (credential, cipher) => {
            const messageId = this.messageId()
            const outer: DurableEventEnvelope = {
                version: 1,
                kind: 'codever.event',
                messageId,
                gatewayId: this.options.gatewayId,
                credentialId: credential.credentialId,
                projectId: safeRouteId(envelope.projectId, 'projectId'),
                contextId: safeRouteId(envelope.sessionId, 'contextId'),
                eventId: envelope.eventId,
                ...(envelope.event.meta?.turnId ? { taskId: envelope.event.meta.turnId } : {}),
                createdAt: envelope.timestamp,
                opaquePayload: JSON.stringify(await cipher.encrypt(payload, { messageId, ttlMs: EVENT_TTL_MS })),
            }
            await this.js.publish(clientEventsSubject(credential.credentialId), encode(outer), {
                msgID: `${credential.credentialId}:${envelope.eventId}`,
            })
        })
    }

    async publishInventory(inventory: InventorySnapshot): Promise<void> {
        await this.publishToEnabledClients(async (credential, cipher) => {
            const messageId = this.messageId()
            const outer: DurableInventoryEnvelope = {
                version: 1,
                kind: 'codever.inventory',
                messageId,
                gatewayId: this.options.gatewayId,
                credentialId: credential.credentialId,
                revision: inventory.revision,
                createdAt: inventory.generatedAt,
                opaquePayload: JSON.stringify(await cipher.encrypt(inventory, { messageId, ttlMs: EVENT_TTL_MS })),
            }
            await this.js.publish(
                clientInventorySubject(credential.credentialId, this.options.gatewayId),
                encode(outer),
                { msgID: `${credential.credentialId}:${this.options.gatewayId}:inventory:${inventory.revision}` },
            )
        })
    }

    async publishPresence(gateway: Gateway): Promise<void> {
        if (gateway.id !== this.options.gatewayId) throw new Error('Gateway presence identity mismatch')
        const envelope: GatewayPresenceEnvelope = {
            version: 1,
            kind: 'codever.gateway.presence',
            messageId: this.messageId(),
            gateway,
        }
        await this.js.publish(gatewayPresenceSubject(this.options.gatewayId), encode(envelope), {
            msgID: `${this.options.gatewayId}:presence:${gateway.lastSeenAt}`,
        })
    }

    private async process(message: JsMsg): Promise<void> {
        let heartbeat: ReturnType<typeof setInterval> | undefined
        try {
            const outer = parseDurableCommandEnvelope(message.json())
            if (outer.gatewayId !== this.options.gatewayId
                || message.subject !== gatewayCommandsSubject(this.options.gatewayId)) {
                message.term('Command route does not match this Gateway')
                return
            }
            if (outer.expiresAt && Date.parse(outer.expiresAt) <= this.now()) {
                message.term('Command expired before Gateway processing')
                return
            }
            const credential = await this.options.credentials.get(outer.credentialId)
            if (!credential?.enabled) {
                message.term('Device credential is unknown or revoked')
                return
            }
            const cipher = await this.cipherFor(credential)
            const request = parseClientGatewayRequestFrame(await cipher.decrypt(parseEncrypted(outer.opaquePayload)))
            if (request.idempotencyKey !== outer.commandId) {
                message.term('Encrypted command identity does not match its route')
                return
            }
            heartbeat = setInterval(() => message.working(), WORKING_INTERVAL_MS)
            heartbeat.unref?.()
            const response = requestUsesDurableLedger(request)
                ? await this.options.requestLedger.execute(
                    request,
                    credential.credentialId,
                    () => this.options.handleRequest(request, credential.credentialId),
                )
                : await this.options.handleRequest(request, credential.credentialId)
            await this.publishResponse(outer.commandId, credential, cipher, response)
            if (!await message.ackAck()) throw new Error('JetStream did not confirm the Gateway command acknowledgement')
        } catch (error) {
            this.report(error)
            message.nak(1_000)
        } finally {
            if (heartbeat) clearInterval(heartbeat)
        }
    }

    private async publishResponse(
        commandId: string,
        credential: DeviceCredentialRecord,
        cipher: HpkeMessageCipher,
        response: ClientGatewayResponseFrame,
    ): Promise<void> {
        const messageId = this.messageId()
        const outer: DurableResponseEnvelope = {
            version: 1,
            kind: 'codever.response',
            messageId,
            commandId,
            gatewayId: this.options.gatewayId,
            credentialId: credential.credentialId,
            createdAt: new Date(this.now()).toISOString(),
            opaquePayload: JSON.stringify(await cipher.encrypt(response, { messageId, ttlMs: RESPONSE_TTL_MS })),
        }
        await this.js.publish(clientResponsesSubject(credential.credentialId), encode(outer), {
            msgID: `${credential.credentialId}:${commandId}:response`,
        })
    }

    private async publishToEnabledClients(
        publish: (credential: DeviceCredentialRecord, cipher: HpkeMessageCipher) => Promise<void>,
    ): Promise<void> {
        const credentials = (await this.options.credentials.list()).filter(value => value.enabled)
        const results = await Promise.allSettled(credentials.map(async credential =>
            publish(credential, await this.cipherFor(credential))))
        const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (rejected) throw rejected.reason
    }

    private async cipherFor(credential: DeviceCredentialRecord): Promise<HpkeMessageCipher> {
        const cached = this.ciphers.get(credential.credentialId)
        if (cached?.keyId === credential.hpkeKeyId) return cached.cipher
        const cipher = await HpkeMessageCipher.create({
            localId: this.options.gatewayId,
            remoteId: credential.credentialId,
            localKeyPair: this.options.credentials.hpkeKeyPair,
            remoteKey: { keyId: credential.hpkeKeyId, publicKey: credential.hpkePublicKey },
            now: () => this.now(),
        })
        this.ciphers.set(credential.credentialId, { keyId: credential.hpkeKeyId, cipher })
        return cipher
    }

    private report(value: unknown): void {
        this.options.onError?.(value instanceof Error ? value : new Error(String(value)))
    }

    private now(): number { return this.options.now?.() ?? Date.now() }
    private messageId(): string { return this.options.messageId?.() ?? randomUUID() }
}

export async function consumeConcurrently<T>(
    source: AsyncIterable<T>,
    limit: number,
    process: (value: T) => Promise<void>,
): Promise<void> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Concurrent consumer limit must be positive')
    const active = new Set<Promise<void>>()
    for await (const value of source) {
        const task = Promise.resolve().then(() => process(value))
        active.add(task)
        void task.finally(() => active.delete(task)).catch(() => undefined)
        if (active.size >= limit) await Promise.race(active)
    }
    await Promise.all(active)
}

export function requestUsesDurableLedger(request: ClientGatewayRequestFrame): boolean {
    return request.payload.kind !== 'inventory.get'
        && request.payload.kind !== 'events.list'
        && request.payload.kind !== 'provider.sessions.list'
        && request.payload.kind !== 'attachment.list'
        && request.payload.kind !== 'attachment.download'
}

function parseEncrypted(value: string): HpkeEnvelope {
    try {
        return JSON.parse(value) as HpkeEnvelope
    } catch (error) {
        throw new Error('Durable command payload is not a valid HPKE envelope', { cause: error })
    }
}

function encode(value: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(value))
}

function safeRouteId(value: string, label: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label} is not safe for durable routing`)
    return value
}
