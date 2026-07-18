import { randomUUID } from 'node:crypto'
import {
    PROTOCOL_VERSION,
    parseRelayClientSecureHandshakeFrame,
    type RelayClientSecureHandshakeFrame,
} from '@codever/protocol'
import { SessionCipher } from '@codever/secure-channel'
import type WebSocket from 'ws'
import type { SecureClientAuthenticator } from './secureClientAuth'

export class ClientSecureSession {
    private state: 'waiting-start' | 'waiting-finish' | 'ready' | 'closed' = 'waiting-start'
    private clientId?: string
    private handshakeId?: string
    private cipher?: SessionCipher
    private incoming = Promise.resolve()
    private outgoing = Promise.resolve()

    constructor(private readonly options: {
        socket: WebSocket
        authenticator: SecureClientAuthenticator
        logError: (error: unknown) => void
    }) {}

    receive(value: unknown): void {
        this.incoming = this.incoming.then(() => this.process(value)).catch(error => {
            this.options.logError(error)
            if (!this.cipher && this.options.socket.readyState === this.options.socket.OPEN) {
                this.sendPlain({
                    version: PROTOCOL_VERSION,
                    type: 'relay.client-auth.rejected',
                    messageId: randomUUID(),
                    payload: { code: 'authentication_failed', message: 'Secure Client authentication failed' },
                } satisfies RelayClientSecureHandshakeFrame)
            }
            this.options.socket.close(1008, 'Secure Client protocol error')
        })
    }

    disconnected(): void {
        if (this.state === 'closed') return
        this.state = 'closed'
        this.cipher = undefined
    }

    private async process(value: unknown): Promise<void> {
        if (this.state === 'closed') throw new Error('Client secure session is closed')
        if (this.state === 'waiting-start' || this.state === 'waiting-finish') {
            return this.processHandshake(parseRelayClientSecureHandshakeFrame(value))
        }
        throw new Error('Relay pairing socket accepts no application messages')
    }

    private async processHandshake(frame: RelayClientSecureHandshakeFrame): Promise<void> {
        if (this.state === 'waiting-start') {
            if (frame.type !== 'client.relay-auth.start') throw new Error('Secure authentication must start with client.relay-auth.start')
            this.clientId = frame.payload.credentialId
            const started = await this.options.authenticator.begin({
                clientId: frame.payload.credentialId,
                subjectId: frame.payload.subjectId,
                startLoginRequest: frame.payload.startLoginRequest,
                natsPublicKey: frame.payload.natsPublicKey,
            })
            this.handshakeId = started.handshakeId
            this.state = 'waiting-finish'
            this.sendPlain({
                version: PROTOCOL_VERSION,
                type: 'relay.client-auth.response',
                messageId: randomUUID(),
                payload: { relayId: this.options.authenticator.relayId, ...started },
            } satisfies RelayClientSecureHandshakeFrame)
            return
        }
        if (this.state !== 'waiting-finish' || frame.type !== 'client.relay-auth.finish'
            || frame.payload.handshakeId !== this.handshakeId) {
            throw new Error('Secure Client authentication finish does not match the active handshake')
        }
        const finished = await this.options.authenticator.finish(frame.payload)
        if (finished.clientId !== this.clientId) throw new Error('Authenticated Client identity changed')
        const channelId = randomUUID()
        this.cipher = await SessionCipher.create({ sessionKey: finished.sessionKey, role: 'responder', channelId })
        this.state = 'ready'
        this.sendPlain({
            version: PROTOCOL_VERSION,
            type: 'relay.client-auth.accepted',
            messageId: randomUUID(),
            payload: {
                handshakeId: frame.payload.handshakeId,
                envelope: await this.cipher.encrypt({
                    relayId: this.options.authenticator.relayId,
                    credentialId: this.clientId,
                    acceptedAt: new Date().toISOString(),
                    natsUserJwt: finished.natsUserJwt,
                    natsWebSocketUrl: finished.natsWebSocketUrl,
                }),
            },
        } satisfies RelayClientSecureHandshakeFrame)
    }

    private sendPlain(value: unknown): void { void this.queueSend(async () => value) }

    private queueSend(create: () => Promise<unknown>): Promise<void> {
        const result = this.outgoing.then(async () => {
            const value = await create()
            if (this.options.socket.readyState === this.options.socket.OPEN) this.options.socket.send(JSON.stringify(value))
        })
        this.outgoing = result.catch(error => {
            this.options.logError(error)
            this.options.socket.close(1011, 'Failed to encrypt or send Client frame')
        })
        return result
    }
}
