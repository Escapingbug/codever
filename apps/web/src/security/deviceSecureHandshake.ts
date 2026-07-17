import {
  PROTOCOL_VERSION,
  parseDeviceCredentialFrame,
  parseClientGatewayFrame,
  parseDeviceSecureHandshakeFrame,
  parseGatewaySecureAuthAcceptedPayload,
  parseSecureDataFrame,
  type ClientGatewayRequestFrame,
  type ClientGatewayResponseFrame,
  type ClientGatewayFrame,
  type DeviceCredentialFrame,
  type DeviceSecureHandshakeFrame,
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
import type { ClientDeviceCredential } from './deviceCredentialStore'

export class DeviceSecureHandshake {
  private state: 'idle' | 'waiting-response' | 'waiting-accepted' | 'provisioning' | 'ready' = 'idle'
  private clientLoginState?: string
  private handshakeId?: string
  private sessionKey?: string
  private gatewayStaticPublicKey?: string
  private cipher?: SessionCipher
  private registration?: { secret: string; clientRegistrationState: string }

  constructor(private readonly options: {
    relayProfileId: string
    gatewayId: string
    credentialId: string
    pairingCode?: string
    credential?: ClientDeviceCredential
    saveCredential: (credential: ClientDeviceCredential) => Promise<void>
    createMessageId?: () => string
  }) {
    if (!options.pairingCode && !options.credential) throw new Error('A pairing code or device credential is required')
    if (options.credential && (options.credential.gatewayId !== options.gatewayId
      || options.credential.credentialId !== options.credentialId
      || options.credential.relayProfileId !== options.relayProfileId)) {
      throw new Error('Device credential identity mismatch')
    }
  }

  get ready(): boolean { return this.state === 'ready' }

  async start(): Promise<string> {
    if (this.state !== 'idle') throw new Error('Device secure handshake already started')
    let subjectId: string
    let startLoginRequest: string
    let mode: 'pairing' | 'credential'
    if (this.options.credential) {
      const started = await startOpaqueCredentialLogin(this.options.credential.secret)
      this.clientLoginState = started.clientLoginState
      startLoginRequest = started.startLoginRequest
      subjectId = this.options.credentialId
      mode = 'credential'
    } else {
      const started = await startOpaquePairingClient(this.options.pairingCode!)
      this.clientLoginState = started.clientLoginState
      startLoginRequest = started.startLoginRequest
      subjectId = started.pairingId
      mode = 'pairing'
    }
    this.state = 'waiting-response'
    return encodeOpaquePayload({
      version: PROTOCOL_VERSION,
      type: 'client.secure-auth.start',
      messageId: this.messageId(),
      payload: { mode, credentialId: this.options.credentialId, subjectId, startLoginRequest },
    } satisfies DeviceSecureHandshakeFrame)
  }

  async handle(opaquePayload: string): Promise<string | undefined> {
    const value = decodeOpaquePayload(opaquePayload)
    if (this.state === 'waiting-response' || this.state === 'waiting-accepted') {
      return this.handleHandshake(parseDeviceSecureHandshakeFrame(value))
    }
    if (this.state !== 'provisioning') throw new Error('Unexpected secure device payload')
    const plaintext = await this.cipher!.decrypt(parseSecureDataFrame(value).envelope)
    return this.handleProvisioning(parseDeviceCredentialFrame(plaintext))
  }

  async encryptRequest(request: ClientGatewayRequestFrame): Promise<string> {
    if (!this.ready || !this.cipher) throw new Error('Device secure channel is not ready')
    return this.encrypt(request)
  }

  async decryptResponse(opaquePayload: string): Promise<ClientGatewayResponseFrame> {
    if (!this.ready || !this.cipher) throw new Error('Device secure channel is not ready')
    return (await this.cipher.decrypt(parseSecureDataFrame(decodeOpaquePayload(opaquePayload)).envelope)) as ClientGatewayResponseFrame
  }

  async decryptFrame(opaquePayload: string): Promise<ClientGatewayFrame> {
    if (!this.ready || !this.cipher) throw new Error('Device secure channel is not ready')
    return parseClientGatewayFrame(
      await this.cipher.decrypt(parseSecureDataFrame(decodeOpaquePayload(opaquePayload)).envelope),
    )
  }

  private async handleHandshake(frame: DeviceSecureHandshakeFrame): Promise<string | undefined> {
    if (frame.type === 'gateway.secure-auth.rejected') throw new Error(`Gateway authentication rejected: ${frame.payload.message}`)
    if (this.state === 'waiting-response') {
      if (frame.type !== 'gateway.secure-auth.response' || frame.payload.gatewayId !== this.options.gatewayId) {
        throw new Error('Unexpected Gateway authentication response')
      }
      this.handshakeId = frame.payload.handshakeId
      let finishLoginRequest: string
      if (this.options.credential) {
        const finished = await finishOpaqueCredentialClientLogin({
          secret: this.options.credential.secret,
          subjectId: this.options.credentialId,
          serverId: this.options.gatewayId,
          clientLoginState: this.clientLoginState!,
          loginResponse: frame.payload.loginResponse,
          expectedServerStaticPublicKey: this.options.credential.gatewayStaticPublicKey,
        })
        finishLoginRequest = finished.finishLoginRequest
        this.sessionKey = finished.sessionKey
        this.gatewayStaticPublicKey = this.options.credential.gatewayStaticPublicKey
      } else {
        const finished = finishOpaquePairingClient({
          code: this.options.pairingCode!,
          serverId: this.options.gatewayId,
          clientLoginState: this.clientLoginState!,
          loginResponse: frame.payload.loginResponse,
        })
        finishLoginRequest = finished.finishLoginRequest
        this.sessionKey = finished.sessionKey
        this.gatewayStaticPublicKey = finished.serverStaticPublicKey
      }
      this.state = 'waiting-accepted'
      return encodeOpaquePayload({
        version: PROTOCOL_VERSION,
        type: 'client.secure-auth.finish',
        messageId: this.messageId(),
        payload: { handshakeId: frame.payload.handshakeId, finishLoginRequest },
      } satisfies DeviceSecureHandshakeFrame)
    }
    if (frame.type !== 'gateway.secure-auth.accepted' || frame.payload.handshakeId !== this.handshakeId) {
      throw new Error('Unexpected Gateway authentication acceptance')
    }
    this.cipher = await SessionCipher.create({
      sessionKey: this.sessionKey!, role: 'initiator', channelId: frame.payload.envelope.channelId,
    })
    const accepted = parseGatewaySecureAuthAcceptedPayload(await this.cipher.decrypt(frame.payload.envelope))
    if (accepted.gatewayId !== this.options.gatewayId || accepted.credentialId !== this.options.credentialId) {
      throw new Error('Gateway accepted another device identity')
    }
    if (!accepted.credentialProvisioningRequired) {
      this.state = 'ready'
      return undefined
    }
    const secret = generateOpaqueCredentialSecret()
    const registration = await startOpaqueCredentialRegistration(secret)
    this.registration = { secret, clientRegistrationState: registration.clientRegistrationState }
    this.state = 'provisioning'
    return this.encrypt({
      version: PROTOCOL_VERSION,
      type: 'device.credential.registration.start',
      messageId: this.messageId(),
      payload: { deviceId: this.options.credentialId, registrationRequest: registration.registrationRequest },
    } satisfies DeviceCredentialFrame)
  }

  private async handleProvisioning(frame: DeviceCredentialFrame): Promise<string | undefined> {
    if (frame.type === 'device.credential.registration.response') {
      if (frame.payload.deviceId !== this.options.credentialId) throw new Error('Credential response belongs to another device')
      const finished = await finishOpaqueCredentialRegistration({
        secret: this.registration!.secret,
        subjectId: this.options.credentialId,
        serverId: this.options.gatewayId,
        clientRegistrationState: this.registration!.clientRegistrationState,
        registrationResponse: frame.payload.registrationResponse,
        expectedServerStaticPublicKey: this.gatewayStaticPublicKey,
      })
      return this.encrypt({
        version: PROTOCOL_VERSION,
        type: 'device.credential.registration.commit',
        messageId: this.messageId(),
        payload: { deviceId: this.options.credentialId, registrationRecord: finished.registrationRecord },
      } satisfies DeviceCredentialFrame)
    }
    if (frame.type !== 'device.credential.registration.accepted' || frame.payload.deviceId !== this.options.credentialId) {
      throw new Error('Unexpected device credential registration response')
    }
    await this.options.saveCredential({
      version: 1,
      relayProfileId: this.options.relayProfileId,
      gatewayId: this.options.gatewayId,
      credentialId: this.options.credentialId,
      secret: this.registration!.secret,
      gatewayStaticPublicKey: this.gatewayStaticPublicKey!,
      createdAt: frame.payload.registeredAt,
    })
    this.registration = undefined
    this.state = 'ready'
    return undefined
  }

  private async encrypt(value: unknown): Promise<string> {
    const frame: SecureDataFrame = {
      version: PROTOCOL_VERSION,
      type: 'secure.data',
      messageId: this.messageId(),
      envelope: await this.cipher!.encrypt(value),
    }
    return encodeOpaquePayload(frame)
  }

  private messageId(): string { return this.options.createMessageId?.() ?? globalThis.crypto.randomUUID() }
}

function encodeOpaquePayload(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)))
}

function decodeOpaquePayload(value: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))) as unknown
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid opaque payload')
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}
