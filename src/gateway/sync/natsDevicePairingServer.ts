import { randomUUID } from 'node:crypto'
import {
    PROTOCOL_VERSION,
    clientPairingResponsesSubject,
    gatewayPairingRequestsSubject,
    parseDurablePairingRequestEnvelope,
    type DurablePairingResponseEnvelope,
} from '@codever/protocol'
import type { NatsConnection, Subscription } from '@nats-io/transport-node'
import { DeviceSecureSession, type DeviceAuthenticator } from '../security'

const PAIRING_TRANSPORT_TTL_MS = 3 * 60_000

interface PairingSession {
    credentialId: string
    session: DeviceSecureSession
    responses: Map<string, DurablePairingResponseEnvelope>
    incoming: Promise<void>
    expiresAtMs: number
    setSend(send: (opaquePayload: string) => Promise<void>): void
}

/** A retryable NATS carrier for the existing OPAQUE + HPKE device provisioning state machine. */
export class NatsDevicePairingServer {
    private subscription?: Subscription
    private loop?: Promise<void>
    private stopping = false
    private readonly sessions = new Map<string, PairingSession>()

    constructor(private readonly options: {
        connection: NatsConnection
        gatewayId: string
        authenticator: DeviceAuthenticator
        now?: () => number
        messageId?: () => string
        onError?: (error: Error) => void
    }) {}

    start(): void {
        if (this.loop) return
        this.stopping = false
        this.subscription = this.options.connection.subscribe(gatewayPairingRequestsSubject(this.options.gatewayId))
        this.loop = this.consume(this.subscription)
        void this.loop.catch(error => { if (!this.stopping) this.report(error) })
    }

    async stop(): Promise<void> {
        this.stopping = true
        this.subscription?.unsubscribe()
        await this.loop?.catch(() => undefined)
        for (const state of this.sessions.values()) state.session.close()
        this.sessions.clear()
        this.subscription = undefined
        this.loop = undefined
    }

    private async consume(subscription: Subscription): Promise<void> {
        for await (const message of subscription) {
            if (this.stopping) return
            try {
                const request = parseDurablePairingRequestEnvelope(JSON.parse(new TextDecoder().decode(message.data)))
                if (request.gatewayId !== this.options.gatewayId
                    || message.subject !== gatewayPairingRequestsSubject(this.options.gatewayId)) {
                    throw new Error('Pairing request route does not match this Gateway')
                }
                if (this.now() - Date.parse(request.createdAt) > PAIRING_TRANSPORT_TTL_MS) return
                this.prune()
                const state = this.sessions.get(request.pairingSessionId) ?? this.createSession(
                    request.pairingSessionId, request.credentialId,
                )
                if (state.credentialId !== request.credentialId) throw new Error('Pairing session identity changed')
                const cached = state.responses.get(request.messageId)
                if (cached) {
                    this.publish(cached)
                    continue
                }
                state.incoming = state.incoming.then(async () => {
                    const replay = state.responses.get(request.messageId)
                    if (replay) return this.publish(replay)
                    let sent = false
                    const send = async (opaquePayload: string): Promise<void> => {
                        if (sent) throw new Error('Pairing step produced multiple responses')
                        sent = true
                        const response: DurablePairingResponseEnvelope = {
                            version: PROTOCOL_VERSION,
                            kind: 'codever.pairing.response',
                            messageId: this.messageId(),
                            inReplyTo: request.messageId,
                            pairingSessionId: request.pairingSessionId,
                            gatewayId: this.options.gatewayId,
                            credentialId: request.credentialId,
                            createdAt: new Date(this.now()).toISOString(),
                            opaquePayload,
                        }
                        state.responses.set(request.messageId, response)
                        this.publish(response)
                    }
                    state.setSend(send)
                    await state.session.receive(request.opaquePayload)
                    if (!sent) throw new Error('Pairing step did not produce a response')
                })
                void state.incoming.catch(error => this.report(error))
            } catch (error) {
                this.report(error)
            }
        }
    }

    private createSession(pairingSessionId: string, credentialId: string): PairingSession {
        let sendCurrent: (opaquePayload: string) => Promise<void> = async () => {
            throw new Error('Pairing response transport is not active')
        }
        const session = new DeviceSecureSession({
            gatewayId: this.options.gatewayId,
            authenticator: this.options.authenticator,
            send: value => sendCurrent(value),
            handleRequest: async () => { throw new Error('Application requests are not accepted on the pairing transport') },
        })
        const state: PairingSession = {
            credentialId,
            session,
            responses: new Map(),
            incoming: Promise.resolve(),
            expiresAtMs: this.now() + PAIRING_TRANSPORT_TTL_MS,
            setSend: value => { sendCurrent = value },
        }
        this.sessions.set(pairingSessionId, state)
        return state
    }

    private publish(response: DurablePairingResponseEnvelope): void {
        this.options.connection.publish(
            clientPairingResponsesSubject(response.credentialId),
            new TextEncoder().encode(JSON.stringify(response)),
        )
    }

    private prune(): void {
        const now = this.now()
        for (const [id, state] of this.sessions) {
            if (state.expiresAtMs > now) continue
            state.session.close()
            this.sessions.delete(id)
        }
    }

    private report(value: unknown): void {
        this.options.onError?.(value instanceof Error ? value : new Error(String(value)))
    }
    private now(): number { return this.options.now?.() ?? Date.now() }
    private messageId(): string { return this.options.messageId?.() ?? randomUUID() }
}
