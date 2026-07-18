import {
    PROTOCOL_VERSION, parseGatewaySecureHandshakeFrame, parseRelaySecureAuthAcceptedPayload,
    type GatewaySecureHandshakeFrame,
} from '@codever/protocol'
import { finishOpaquePairingClient, SessionCipher, startOpaquePairingClient } from '@codever/secure-channel'
import { nkeys } from '@nats-io/transport-node'
import type { GatewaySecureCredential } from './secureCredentialStore'

export class SecureGatewayHandshake {
    private state: 'idle' | 'waiting-response' | 'waiting-accepted' | 'ready' = 'idle'
    private clientLoginState?: string
    private sessionKey?: string
    private relayId?: string
    private handshakeId?: string
    private natsSeed?: string

    constructor(private readonly options: {
        gatewayId: string
        pairingCode: string
        createMessageId: () => string
        saveCredential: (credential: GatewaySecureCredential) => Promise<void>
    }) {}

    get ready(): boolean { return this.state === 'ready' }

    async start(): Promise<GatewaySecureHandshakeFrame> {
        if (this.state !== 'idle') throw new Error('Secure Gateway handshake already started')
        const pairing = await startOpaquePairingClient(this.options.pairingCode)
        this.clientLoginState = pairing.clientLoginState
        const key = nkeys.createUser()
        const natsPublicKey = key.getPublicKey()
        this.natsSeed = new TextDecoder().decode(key.getSeed())
        key.clear()
        this.state = 'waiting-response'
        return {
            version: PROTOCOL_VERSION, type: 'gateway.secure-auth.start', messageId: this.options.createMessageId(),
            payload: {
                gatewayId: this.options.gatewayId, mode: 'pairing', subjectId: pairing.pairingId,
                startLoginRequest: pairing.startLoginRequest, natsPublicKey,
            },
        }
    }

    async handleHandshake(value: unknown): Promise<GatewaySecureHandshakeFrame | undefined> {
        const frame = parseGatewaySecureHandshakeFrame(value)
        if (frame.type === 'relay.secure-auth.rejected') throw new Error(`Secure Relay authentication rejected: ${frame.payload.message}`)
        if (this.state === 'waiting-response') {
            if (frame.type !== 'relay.secure-auth.response') throw new Error('Expected secure authentication response')
            this.relayId = frame.payload.relayId
            this.handshakeId = frame.payload.handshakeId
            const finished = finishOpaquePairingClient({
                domain: 'relay-gateway', code: this.options.pairingCode, serverId: this.relayId,
                clientLoginState: this.clientLoginState!, loginResponse: frame.payload.loginResponse,
            })
            this.sessionKey = finished.sessionKey
            this.state = 'waiting-accepted'
            return {
                version: PROTOCOL_VERSION, type: 'gateway.secure-auth.finish', messageId: this.options.createMessageId(),
                payload: { handshakeId: frame.payload.handshakeId, finishLoginRequest: finished.finishLoginRequest },
            }
        }
        if (this.state !== 'waiting-accepted' || frame.type !== 'relay.secure-auth.accepted'
            || frame.payload.handshakeId !== this.handshakeId) throw new Error('Unexpected secure authentication acceptance')
        const cipher = await SessionCipher.create({
            sessionKey: this.sessionKey!, role: 'initiator', channelId: frame.payload.envelope.channelId,
        })
        const accepted = parseRelaySecureAuthAcceptedPayload(await cipher.decrypt(frame.payload.envelope))
        if (accepted.gatewayId !== this.options.gatewayId) throw new Error('Relay accepted another Gateway identity')
        await this.options.saveCredential({
            version: 3,
            gatewayId: this.options.gatewayId,
            relayId: this.relayId!,
            createdAt: accepted.acceptedAt,
            natsSeed: this.natsSeed!,
            natsUserJwt: accepted.natsUserJwt,
            natsUrl: accepted.natsUrl,
        })
        this.state = 'ready'
        return undefined
    }
}
