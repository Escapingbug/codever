import {
  PROTOCOL_VERSION,
  parseRelayClientAuthAcceptedPayload,
  parseRelayClientSecureHandshakeFrame,
  parseRelayClientCredentialRegistrationFrame,
  parseSecureDataFrame,
  type RelayClientSecureHandshakeFrame,
  type RelayClientCredentialRegistrationFrame,
  type SecureDataFrame,
} from '@codever/protocol'
import {
  finishOpaqueCredentialClientLogin,
  finishOpaqueCredentialRegistration,
  finishOpaquePairingClient,
  generateOpaqueCredentialSecret,
  SessionCipher,
  startOpaqueCredentialLogin,
  startOpaqueCredentialRegistration,
  startOpaquePairingClient,
} from '@codever/secure-channel'
import type { ClientRelayCredential } from './relayCredentialStore'

export class RelaySecureHandshake {
  private state: 'idle' | 'waiting-response' | 'waiting-accepted' | 'provisioning' | 'ready' = 'idle'
  private clientLoginState?: string
  private handshakeId?: string
  private sessionKey?: string
  private relayId?: string
  private relayStaticPublicKey?: string
  private cipher?: SessionCipher
  private registration?: { secret: string; clientRegistrationState: string }

  constructor(private readonly options: {
    relayProfileId: string
    credentialId: string
    pairingCode?: string
    credential?: ClientRelayCredential
    saveCredential: (credential: ClientRelayCredential) => Promise<void>
    createMessageId?: () => string
  }) {
    if (!options.pairingCode && !options.credential) throw new Error('A Relay pairing code or credential is required')
    if (options.credential && (options.credential.relayProfileId !== options.relayProfileId
      || options.credential.credentialId !== options.credentialId)) throw new Error('Relay credential identity mismatch')
  }

  get ready(): boolean { return this.state === 'ready' }

  async handle(value: unknown): Promise<RelayClientSecureHandshakeFrame | SecureDataFrame | undefined> {
    if (value && typeof value === 'object' && 'type' in value && value.type === 'secure.data') {
      return this.handleSecureData(value)
    }
    return this.handleHandshake(value)
  }

  async start(): Promise<RelayClientSecureHandshakeFrame> {
    if (this.state !== 'idle') throw new Error('Relay secure handshake already started')
    let mode: 'pairing' | 'credential'
    let subjectId: string
    let startLoginRequest: string
    if (this.options.credential) {
      const started = await startOpaqueCredentialLogin(this.options.credential.secret)
      this.clientLoginState = started.clientLoginState
      this.relayId = this.options.credential.relayId
      mode = 'credential'
      subjectId = this.options.credentialId
      startLoginRequest = started.startLoginRequest
    } else {
      const started = await startOpaquePairingClient(this.options.pairingCode!)
      this.clientLoginState = started.clientLoginState
      mode = 'pairing'
      subjectId = started.pairingId
      startLoginRequest = started.startLoginRequest
    }
    this.state = 'waiting-response'
    return {
      version: PROTOCOL_VERSION,
      type: 'client.relay-auth.start',
      messageId: this.messageId(),
      payload: { mode, credentialId: this.options.credentialId, subjectId, startLoginRequest },
    }
  }

  async handleHandshake(value: unknown): Promise<RelayClientSecureHandshakeFrame | SecureDataFrame | undefined> {
    const frame = parseRelayClientSecureHandshakeFrame(value)
    if (frame.type === 'relay.client-auth.rejected') throw new Error(`Relay authentication rejected: ${frame.payload.message}`)
    if (this.state === 'waiting-response') {
      if (frame.type !== 'relay.client-auth.response') throw new Error('Expected Relay authentication response')
      this.relayId = frame.payload.relayId
      this.handshakeId = frame.payload.handshakeId
      let finishLoginRequest: string
      if (this.options.credential) {
        if (this.options.credential.relayId !== this.relayId) throw new Error('Relay identity changed')
        const finished = await finishOpaqueCredentialClientLogin({
          secret: this.options.credential.secret,
          subjectId: this.options.credentialId,
          serverId: this.relayId!,
          clientLoginState: this.clientLoginState!,
          loginResponse: frame.payload.loginResponse,
          expectedServerStaticPublicKey: this.options.credential.relayStaticPublicKey,
        })
        finishLoginRequest = finished.finishLoginRequest
        this.sessionKey = finished.sessionKey
        this.relayStaticPublicKey = this.options.credential.relayStaticPublicKey
      } else {
        const finished = finishOpaquePairingClient({
          domain: 'relay-client',
          code: this.options.pairingCode!,
          serverId: this.relayId,
          clientLoginState: this.clientLoginState!,
          loginResponse: frame.payload.loginResponse,
        })
        finishLoginRequest = finished.finishLoginRequest
        this.sessionKey = finished.sessionKey
        this.relayStaticPublicKey = finished.serverStaticPublicKey
      }
      this.state = 'waiting-accepted'
      return {
        version: PROTOCOL_VERSION,
        type: 'client.relay-auth.finish',
        messageId: this.messageId(),
        payload: { handshakeId: frame.payload.handshakeId, finishLoginRequest },
      }
    }
    if (this.state !== 'waiting-accepted' || frame.type !== 'relay.client-auth.accepted'
      || frame.payload.handshakeId !== this.handshakeId) throw new Error('Unexpected Relay authentication acceptance')
    this.cipher = await SessionCipher.create({
      sessionKey: this.sessionKey!, role: 'initiator', channelId: frame.payload.envelope.channelId,
    })
    const accepted = parseRelayClientAuthAcceptedPayload(await this.cipher.decrypt(frame.payload.envelope))
    if (accepted.relayId !== this.relayId || accepted.credentialId !== this.options.credentialId) {
      throw new Error('Relay accepted another client identity')
    }
    if (!accepted.provisioningRequired) {
      this.state = 'ready'
      return undefined
    }
    const secret = generateOpaqueCredentialSecret()
    const registration = await startOpaqueCredentialRegistration(secret)
    this.registration = { secret, clientRegistrationState: registration.clientRegistrationState }
    this.state = 'provisioning'
    return this.encrypt({
      version: PROTOCOL_VERSION,
      type: 'client.credential.registration.start',
      messageId: this.messageId(),
      payload: { credentialId: this.options.credentialId, registrationRequest: registration.registrationRequest },
    } satisfies RelayClientCredentialRegistrationFrame)
  }

  async handleSecureData(value: unknown): Promise<SecureDataFrame | undefined> {
    if (this.state !== 'provisioning') throw new Error('Relay credential provisioning is not active')
    const plaintext = await this.decrypt(value)
    const frame = parseRelayClientCredentialRegistrationFrame(plaintext)
    if (frame.type === 'relay.client-credential.registration.response') {
      if (frame.payload.credentialId !== this.options.credentialId) throw new Error('Relay credential response identity mismatch')
      const finished = await finishOpaqueCredentialRegistration({
        secret: this.registration!.secret,
        subjectId: this.options.credentialId,
        serverId: this.relayId!,
        clientRegistrationState: this.registration!.clientRegistrationState,
        registrationResponse: frame.payload.registrationResponse,
        expectedServerStaticPublicKey: this.relayStaticPublicKey,
      })
      return this.encrypt({
        version: PROTOCOL_VERSION,
        type: 'client.credential.registration.commit',
        messageId: this.messageId(),
        payload: { credentialId: this.options.credentialId, registrationRecord: finished.registrationRecord },
      } satisfies RelayClientCredentialRegistrationFrame)
    }
    if (frame.type !== 'relay.client-credential.registration.accepted'
      || frame.payload.credentialId !== this.options.credentialId) throw new Error('Unexpected Relay credential response')
    await this.options.saveCredential({
      version: 1,
      relayProfileId: this.options.relayProfileId,
      relayId: this.relayId!,
      credentialId: this.options.credentialId,
      secret: this.registration!.secret,
      relayStaticPublicKey: this.relayStaticPublicKey!,
      createdAt: frame.payload.registeredAt,
    })
    this.registration = undefined
    this.state = 'ready'
    return undefined
  }

  async encrypt(value: unknown): Promise<SecureDataFrame> {
    if (!this.cipher) throw new Error('Relay secure cipher is unavailable')
    return { version: PROTOCOL_VERSION, type: 'secure.data', messageId: this.messageId(), envelope: await this.cipher.encrypt(value) }
  }

  async decrypt(value: unknown): Promise<unknown> {
    if (!this.cipher) throw new Error('Relay secure cipher is unavailable')
    return this.cipher.decrypt(parseSecureDataFrame(value).envelope)
  }

  private messageId(): string { return this.options.createMessageId?.() ?? globalThis.crypto.randomUUID() }
}
