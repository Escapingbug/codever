import {
  PROTOCOL_VERSION, parseRelayClientAuthAcceptedPayload, parseRelayClientSecureHandshakeFrame,
  type RelayClientSecureHandshakeFrame,
} from '@codever/protocol'
import { finishOpaquePairingClient, SessionCipher, startOpaquePairingClient } from '@codever/secure-channel'
import { nkeys } from '@nats-io/nats-core'
import type { ClientRelayCredential } from './relayCredentialStore'

export class RelaySecureHandshake {
  private state: 'idle' | 'waiting-response' | 'waiting-accepted' | 'ready' = 'idle'
  private clientLoginState?: string
  private handshakeId?: string
  private sessionKey?: string
  private relayId?: string
  private natsSeed?: string

  constructor(private readonly options: {
    relayProfileId: string
    credentialId: string
    pairingCode: string
    saveCredential: (credential: ClientRelayCredential) => Promise<void>
    createMessageId?: () => string
  }) {}

  get ready(): boolean { return this.state === 'ready' }

  async start(): Promise<RelayClientSecureHandshakeFrame> {
    if (this.state !== 'idle') throw new Error('Relay secure handshake already started')
    const pairing = await startOpaquePairingClient(this.options.pairingCode)
    this.clientLoginState = pairing.clientLoginState
    const key = nkeys.createUser()
    const natsPublicKey = key.getPublicKey()
    this.natsSeed = new TextDecoder().decode(key.getSeed())
    key.clear()
    this.state = 'waiting-response'
    return {
      version: PROTOCOL_VERSION,
      type: 'client.relay-auth.start',
      messageId: this.messageId(),
      payload: {
        mode: 'pairing', credentialId: this.options.credentialId, subjectId: pairing.pairingId,
        startLoginRequest: pairing.startLoginRequest, natsPublicKey,
      },
    }
  }

  async handle(value: unknown): Promise<RelayClientSecureHandshakeFrame | undefined> {
    const frame = parseRelayClientSecureHandshakeFrame(value)
    if (frame.type === 'relay.client-auth.rejected') throw new Error(`Relay authentication rejected: ${frame.payload.message}`)
    if (this.state === 'waiting-response') {
      if (frame.type !== 'relay.client-auth.response') throw new Error('Expected Relay authentication response')
      this.relayId = frame.payload.relayId
      this.handshakeId = frame.payload.handshakeId
      const finished = finishOpaquePairingClient({
        domain: 'relay-client', code: this.options.pairingCode, serverId: this.relayId,
        clientLoginState: this.clientLoginState!, loginResponse: frame.payload.loginResponse,
      })
      this.sessionKey = finished.sessionKey
      this.state = 'waiting-accepted'
      return {
        version: PROTOCOL_VERSION, type: 'client.relay-auth.finish', messageId: this.messageId(),
        payload: { handshakeId: frame.payload.handshakeId, finishLoginRequest: finished.finishLoginRequest },
      }
    }
    if (this.state !== 'waiting-accepted' || frame.type !== 'relay.client-auth.accepted'
      || frame.payload.handshakeId !== this.handshakeId) throw new Error('Unexpected Relay authentication acceptance')
    const cipher = await SessionCipher.create({
      sessionKey: this.sessionKey!, role: 'initiator', channelId: frame.payload.envelope.channelId,
    })
    const accepted = parseRelayClientAuthAcceptedPayload(await cipher.decrypt(frame.payload.envelope))
    if (accepted.relayId !== this.relayId || accepted.credentialId !== this.options.credentialId) {
      throw new Error('Relay accepted another client identity')
    }
    await this.options.saveCredential({
      version: 3,
      relayProfileId: this.options.relayProfileId,
      relayId: accepted.relayId,
      credentialId: accepted.credentialId,
      createdAt: accepted.acceptedAt,
      natsSeed: this.natsSeed!,
      natsUserJwt: accepted.natsUserJwt,
      natsWebSocketUrl: accepted.natsWebSocketUrl,
    })
    this.state = 'ready'
    return undefined
  }

  private messageId(): string { return this.options.createMessageId?.() ?? crypto.randomUUID() }
}
