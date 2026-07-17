import {
  PROTOCOL_VERSION,
  parseClientGatewayFrame,
  parseDeviceBindingFrame,
  parseDeviceHpkeDataFrame,
  parseDeviceKeyProvisioningFrame,
  parseDeviceSecureHandshakeFrame,
  parseGatewaySecureAuthAcceptedPayload,
  parseSecureDataFrame,
  type ClientGatewayFrame,
  type ClientGatewayRequestFrame,
  type ClientGatewayResponseFrame,
  type DeviceHpkeDataFrame,
  type DeviceSecureHandshakeFrame,
  type SecureDataFrame,
} from '@codever/protocol'
import {
  finishOpaquePairingClient,
  generateHpkeKeyPair,
  HpkeMessageCipher,
  SessionCipher,
  startOpaquePairingClient,
  type HpkeKeyPair,
} from '@codever/secure-channel'
import type { ClientDeviceCredential } from './deviceCredentialStore'

export class DeviceSecureHandshake {
  private state: 'idle' | 'waiting-response' | 'waiting-accepted' | 'provisioning' | 'waiting-bind' | 'ready' = 'idle'
  private clientLoginState?: string
  private handshakeId?: string
  private sessionKey?: string
  private provisioningCipher?: SessionCipher
  private applicationCipher?: HpkeMessageCipher
  private deviceKeys?: HpkeKeyPair
  private gatewayKey?: { keyId: string; publicKey: string }
  private pairingCode?: string
  private credential?: ClientDeviceCredential

  constructor(private readonly options: {
    relayProfileId: string
    gatewayId: string
    credentialId: string
    pairingCode?: string
    credential?: ClientDeviceCredential
    saveCredential: (credential: ClientDeviceCredential) => Promise<void>
    createMessageId?: () => string
    now?: () => number
  }) {
    if (!options.pairingCode && !options.credential) throw new Error('A pairing code or device credential is required')
    if (options.credential && (options.credential.gatewayId !== options.gatewayId
      || options.credential.credentialId !== options.credentialId
      || options.credential.relayProfileId !== options.relayProfileId)) {
      throw new Error('Device credential identity mismatch')
    }
    this.pairingCode = options.pairingCode
    this.credential = options.credential
  }

  get ready(): boolean { return this.state === 'ready' }

  async start(): Promise<string> {
    if (this.state !== 'idle') throw new Error('Device secure handshake already started')
    if (this.credential) {
      this.deviceKeys = this.credential.deviceHpkeKeyPair
      this.gatewayKey = {
        keyId: this.credential.gatewayHpkeKeyId,
        publicKey: this.credential.gatewayHpkePublicKey,
      }
      await this.initializeApplicationCipher()
      this.state = 'waiting-bind'
      return this.encryptBinding()
    }
    this.deviceKeys = await generateHpkeKeyPair()
    const started = await startOpaquePairingClient(this.pairingCode!)
    this.clientLoginState = started.clientLoginState
    this.state = 'waiting-response'
    return encodeOpaquePayload({
      version: PROTOCOL_VERSION,
      type: 'client.secure-auth.start',
      messageId: this.messageId(),
      payload: {
        credentialId: this.options.credentialId,
        pairingId: started.pairingId,
        startLoginRequest: started.startLoginRequest,
      },
    } satisfies DeviceSecureHandshakeFrame)
  }

  async handle(opaquePayload: string): Promise<string | undefined> {
    const value = decodeOpaquePayload(opaquePayload)
    if (this.state === 'waiting-response' || this.state === 'waiting-accepted') {
      return this.handlePairing(parseDeviceSecureHandshakeFrame(value))
    }
    if (this.state === 'provisioning') return this.handleProvisioning(value)
    if (this.state === 'waiting-bind') return this.handleBinding(value)
    throw new Error('Unexpected secure device payload')
  }

  async encryptRequest(request: ClientGatewayRequestFrame): Promise<string> {
    if (!this.ready) throw new Error('Device secure channel is not ready')
    return this.encryptApplication(request)
  }

  async decryptResponse(opaquePayload: string): Promise<ClientGatewayResponseFrame> {
    return this.decryptFrame(opaquePayload) as Promise<ClientGatewayResponseFrame>
  }

  async decryptFrame(opaquePayload: string): Promise<ClientGatewayFrame> {
    if (!this.ready || !this.applicationCipher) throw new Error('Device secure channel is not ready')
    const wire = parseDeviceHpkeDataFrame(decodeOpaquePayload(opaquePayload))
    if (wire.messageId !== wire.envelope.messageId) throw new Error('Device HPKE message ID mismatch')
    return parseClientGatewayFrame(await this.applicationCipher.decrypt(wire.envelope))
  }

  private async handlePairing(frame: DeviceSecureHandshakeFrame): Promise<string | undefined> {
    if (frame.type === 'gateway.secure-auth.rejected') throw new Error(`Gateway authentication rejected: ${frame.payload.message}`)
    if (this.state === 'waiting-response') {
      if (frame.type !== 'gateway.secure-auth.response' || frame.payload.gatewayId !== this.options.gatewayId) {
        throw new Error('Unexpected Gateway pairing response')
      }
      this.handshakeId = frame.payload.handshakeId
      const finished = finishOpaquePairingClient({
        domain: 'gateway-device',
        code: this.pairingCode!,
        serverId: this.options.gatewayId,
        clientLoginState: this.clientLoginState!,
        loginResponse: frame.payload.loginResponse,
      })
      this.sessionKey = finished.sessionKey
      this.state = 'waiting-accepted'
      return encodeOpaquePayload({
        version: PROTOCOL_VERSION,
        type: 'client.secure-auth.finish',
        messageId: this.messageId(),
        payload: { handshakeId: frame.payload.handshakeId, finishLoginRequest: finished.finishLoginRequest },
      } satisfies DeviceSecureHandshakeFrame)
    }
    if (frame.type !== 'gateway.secure-auth.accepted' || frame.payload.handshakeId !== this.handshakeId) {
      throw new Error('Unexpected Gateway pairing acceptance')
    }
    this.provisioningCipher = await SessionCipher.create({
      sessionKey: this.sessionKey!, role: 'initiator', channelId: frame.payload.envelope.channelId,
    })
    const accepted = parseGatewaySecureAuthAcceptedPayload(await this.provisioningCipher.decrypt(frame.payload.envelope))
    if (accepted.gatewayId !== this.options.gatewayId || accepted.credentialId !== this.options.credentialId) {
      throw new Error('Gateway accepted another device identity')
    }
    this.gatewayKey = { keyId: accepted.gatewayHpkeKeyId, publicKey: accepted.gatewayHpkePublicKey }
    this.state = 'provisioning'
    return this.encryptTemporary({
      version: PROTOCOL_VERSION,
      type: 'device.key.register',
      messageId: this.messageId(),
      payload: {
        deviceId: this.options.credentialId,
        deviceHpkeKeyId: this.deviceKeys!.keyId,
        deviceHpkePublicKey: this.deviceKeys!.publicKey,
      },
    })
  }

  private async handleProvisioning(value: unknown): Promise<string> {
    const wire = parseSecureDataFrame(value)
    const frame = parseDeviceKeyProvisioningFrame(await this.provisioningCipher!.decrypt(wire.envelope))
    if (frame.type !== 'gateway.key.registered' || frame.payload.deviceId !== this.options.credentialId) {
      throw new Error('Unexpected Gateway key registration response')
    }
    if (frame.payload.gatewayHpkeKeyId !== this.gatewayKey!.keyId
      || frame.payload.gatewayHpkePublicKey !== this.gatewayKey!.publicKey) {
      throw new Error('Gateway changed its HPKE key during pairing')
    }
    this.credential = {
      version: 2,
      relayProfileId: this.options.relayProfileId,
      gatewayId: this.options.gatewayId,
      credentialId: this.options.credentialId,
      deviceHpkeKeyPair: this.deviceKeys!,
      gatewayHpkeKeyId: this.gatewayKey!.keyId,
      gatewayHpkePublicKey: this.gatewayKey!.publicKey,
      createdAt: frame.payload.registeredAt,
    }
    await this.options.saveCredential(this.credential)
    await this.initializeApplicationCipher()
    this.provisioningCipher = undefined
    this.pairingCode = undefined
    this.state = 'waiting-bind'
    return this.encryptBinding()
  }

  private async handleBinding(value: unknown): Promise<undefined> {
    const wire = parseDeviceHpkeDataFrame(value)
    if (wire.messageId !== wire.envelope.messageId) throw new Error('Device HPKE message ID mismatch')
    const frame = parseDeviceBindingFrame(await this.applicationCipher!.decrypt(wire.envelope))
    if (frame.type !== 'gateway.bound' || frame.payload.gatewayId !== this.options.gatewayId
      || frame.payload.credentialId !== this.options.credentialId) throw new Error('Gateway binding identity mismatch')
    this.state = 'ready'
    return undefined
  }

  private async initializeApplicationCipher(): Promise<void> {
    this.applicationCipher = await HpkeMessageCipher.create({
      localId: this.options.credentialId,
      remoteId: this.options.gatewayId,
      localKeyPair: this.deviceKeys!,
      remoteKey: this.gatewayKey!,
      now: () => this.now(),
    })
  }

  private encryptBinding(): Promise<string> {
    return this.encryptApplication({
      version: PROTOCOL_VERSION,
      type: 'device.bind',
      messageId: this.messageId(),
      payload: {
        gatewayId: this.options.gatewayId,
        credentialId: this.options.credentialId,
        boundAt: new Date(this.now()).toISOString(),
      },
    })
  }

  private async encryptTemporary(value: unknown): Promise<string> {
    const frame: SecureDataFrame = {
      version: PROTOCOL_VERSION,
      type: 'secure.data',
      messageId: this.messageId(),
      envelope: await this.provisioningCipher!.encrypt(value),
    }
    return encodeOpaquePayload(frame)
  }

  private async encryptApplication(value: unknown): Promise<string> {
    const messageId = this.messageId()
    const frame: DeviceHpkeDataFrame = {
      version: PROTOCOL_VERSION,
      type: 'device.hpke-data',
      messageId,
      envelope: await this.applicationCipher!.encrypt(value, { messageId }),
    }
    return encodeOpaquePayload(frame)
  }

  private messageId(): string { return this.options.createMessageId?.() ?? globalThis.crypto.randomUUID() }
  private now(): number { return this.options.now?.() ?? Date.now() }
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
