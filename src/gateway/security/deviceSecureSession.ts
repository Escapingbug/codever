import { randomUUID } from 'node:crypto'
import {
    PROTOCOL_VERSION,
    parseClientGatewayRequestFrame,
    parseDeviceBindingFrame,
    parseDeviceHpkeDataFrame,
    parseDeviceKeyProvisioningFrame,
    parseDeviceSecureHandshakeFrame,
    parseSecureDataFrame,
    type ClientGatewayEventFrame,
    type ClientGatewayRequestFrame,
    type ClientGatewayResponseFrame,
    type DeviceHpkeDataFrame,
    type DeviceSecureHandshakeFrame,
    type SecureDataFrame,
} from '@codever/protocol'
import { HpkeMessageCipher, SessionCipher } from '@codever/secure-channel'
import type { DeviceAuthenticator } from './deviceAuthenticator'

const RESPONSE_CACHE_LIMIT = 2_048

export interface DeviceSecureSessionOptions {
    gatewayId: string
    authenticator: DeviceAuthenticator
    send: (opaquePayload: string) => void | Promise<void>
    handleRequest: (
        request: ClientGatewayRequestFrame,
        credentialId: string,
    ) => ClientGatewayResponseFrame | Promise<ClientGatewayResponseFrame>
    createMessageId?: () => string
    now?: () => number
}

export class DeviceSecureSession {
    private state: 'waiting-start' | 'waiting-finish' | 'provisioning' | 'waiting-bind' | 'ready' | 'closed' = 'waiting-start'
    private handshakeId?: string
    private credentialId?: string
    private provisioningCipher?: SessionCipher
    private applicationCipher?: HpkeMessageCipher
    private incoming = Promise.resolve()
    private bindingReplay?: { messageId: string; output: string }
    private readonly responseCache = new Map<string, string>()

    constructor(private readonly options: DeviceSecureSessionOptions) {
        if (!options.gatewayId.trim()) throw new Error('gatewayId is required')
    }

    get ready(): boolean { return this.state === 'ready' }
    get authenticatedCredentialId(): string | undefined { return this.ready ? this.credentialId : undefined }

    receive(opaquePayload: string): Promise<void> {
        this.incoming = this.incoming.then(() => this.process(decodeOpaquePayload(opaquePayload)))
        return this.incoming
    }

    async sendEvent(event: ClientGatewayEventFrame): Promise<void> {
        if (!this.ready || !this.credentialId) throw new Error('Device secure session is not ready')
        await this.options.authenticator.authorize(this.credentialId)
        await this.sendApplication(event)
    }

    close(): void {
        this.state = 'closed'
        this.handshakeId = undefined
        this.credentialId = undefined
        this.provisioningCipher = undefined
        this.applicationCipher = undefined
        this.responseCache.clear()
        this.bindingReplay = undefined
    }

    private async process(value: unknown): Promise<void> {
        if (this.state === 'closed') throw new Error('Device secure session is closed')
        if (this.state === 'waiting-start' && isFrameType(value, 'device.hpke-data')) return this.processBinding(value)
        if (this.state === 'waiting-start' || this.state === 'waiting-finish') return this.processPairing(value)
        if (this.state === 'provisioning') return this.processProvisioning(value)
        if (this.state === 'waiting-bind') return this.processBinding(value)
        if (this.state === 'ready') return this.processApplication(value)
    }

    private async processPairing(value: unknown): Promise<void> {
        const frame = parseDeviceSecureHandshakeFrame(value)
        if (this.state === 'waiting-start') {
            if (frame.type !== 'client.secure-auth.start') throw new Error('Device pairing must start with client.secure-auth.start')
            const started = this.options.authenticator.begin({
                credentialId: frame.payload.credentialId,
                pairingId: frame.payload.pairingId,
                startLoginRequest: frame.payload.startLoginRequest,
            })
            this.handshakeId = started.handshakeId
            this.credentialId = frame.payload.credentialId
            this.state = 'waiting-finish'
            return this.sendHandshake({
                version: PROTOCOL_VERSION,
                type: 'gateway.secure-auth.response',
                messageId: this.messageId(),
                payload: {
                    gatewayId: this.options.gatewayId,
                    handshakeId: started.handshakeId,
                    loginResponse: started.loginResponse,
                    expiresAt: started.expiresAt,
                    attemptsRemaining: started.attemptsRemaining,
                },
            })
        }
        if (frame.type !== 'client.secure-auth.finish' || frame.payload.handshakeId !== this.handshakeId) {
            throw new Error('Device pairing finish does not match the active handshake')
        }
        const finished = this.options.authenticator.finish(frame.payload)
        if (finished.credentialId !== this.credentialId) throw new Error('Paired device identity changed')
        this.provisioningCipher = await SessionCipher.create({
            sessionKey: finished.sessionKey,
            role: 'responder',
            channelId: this.messageId(),
        })
        this.state = 'provisioning'
        await this.sendHandshake({
            version: PROTOCOL_VERSION,
            type: 'gateway.secure-auth.accepted',
            messageId: this.messageId(),
            payload: {
                handshakeId: frame.payload.handshakeId,
                envelope: await this.provisioningCipher.encrypt({
                    gatewayId: this.options.gatewayId,
                    credentialId: this.credentialId,
                    acceptedAt: new Date(this.now()).toISOString(),
                    gatewayHpkePublicKey: this.options.authenticator.hpkeKeyPair.publicKey,
                    gatewayHpkeKeyId: this.options.authenticator.hpkeKeyPair.keyId,
                }),
            },
        })
    }

    private async processProvisioning(value: unknown): Promise<void> {
        const encrypted = parseSecureDataFrame(value)
        const frame = parseDeviceKeyProvisioningFrame(await this.provisioningCipher!.decrypt(encrypted.envelope))
        if (frame.type !== 'device.key.register' || frame.payload.deviceId !== this.credentialId) {
            throw new Error('Invalid device key registration')
        }
        const credential = await this.options.authenticator.register(
            this.credentialId, frame.payload.deviceHpkeKeyId, frame.payload.deviceHpkePublicKey,
        )
        await this.initializeApplicationCipher(credential.hpkeKeyId, credential.hpkePublicKey)
        await this.sendTemporary({
            version: PROTOCOL_VERSION,
            type: 'gateway.key.registered',
            messageId: this.messageId(),
            payload: {
                deviceId: credential.credentialId,
                gatewayHpkePublicKey: this.options.authenticator.hpkeKeyPair.publicKey,
                gatewayHpkeKeyId: this.options.authenticator.hpkeKeyPair.keyId,
                registeredAt: credential.createdAt,
            },
        })
        this.state = 'waiting-bind'
    }

    private async processBinding(value: unknown): Promise<void> {
        const encrypted = parseDeviceHpkeDataFrame(value)
        if (encrypted.messageId !== encrypted.envelope.messageId) throw new Error('Device HPKE message ID mismatch')
        if (this.bindingReplay?.messageId === encrypted.messageId) {
            await this.options.send(this.bindingReplay.output)
            return
        }
        if (!this.credentialId) {
            this.credentialId = encrypted.envelope.senderId
            const credential = await this.options.authenticator.authorize(this.credentialId)
            await this.initializeApplicationCipher(credential.hpkeKeyId, credential.hpkePublicKey)
        }
        await this.options.authenticator.authorize(this.credentialId)
        const frame = parseDeviceBindingFrame(await this.applicationCipher!.decrypt(encrypted.envelope))
        if (frame.type !== 'device.bind' || frame.payload.gatewayId !== this.options.gatewayId
            || frame.payload.credentialId !== this.credentialId) throw new Error('Invalid device binding')
        const output = await this.createApplicationOutput({
            version: PROTOCOL_VERSION,
            type: 'gateway.bound',
            messageId: this.messageId(),
            payload: {
                gatewayId: this.options.gatewayId,
                credentialId: this.credentialId,
                boundAt: new Date(this.now()).toISOString(),
            },
        })
        this.bindingReplay = { messageId: encrypted.messageId, output }
        this.state = 'ready'
        this.provisioningCipher = undefined
        await this.options.send(output)
    }

    private async processApplication(value: unknown): Promise<void> {
        const encrypted = parseDeviceHpkeDataFrame(value)
        if (encrypted.messageId !== encrypted.envelope.messageId) throw new Error('Device HPKE message ID mismatch')
        if (this.bindingReplay?.messageId === encrypted.messageId) {
            await this.options.send(this.bindingReplay.output)
            return
        }
        const cached = this.responseCache.get(encrypted.messageId)
        if (cached) {
            await this.options.send(cached)
            return
        }
        await this.options.authenticator.authorize(this.credentialId!)
        const request = parseClientGatewayRequestFrame(await this.applicationCipher!.decrypt(encrypted.envelope))
        const response = await this.options.handleRequest(request, this.credentialId!)
        if (response.requestId !== request.requestId) throw new Error('Device response requestId mismatch')
        const output = await this.createApplicationOutput(response)
        this.cacheResponse(encrypted.messageId, output)
        await this.options.send(output)
    }

    private async sendTemporary(value: unknown): Promise<void> {
        const frame: SecureDataFrame = {
            version: PROTOCOL_VERSION,
            type: 'secure.data',
            messageId: this.messageId(),
            envelope: await this.provisioningCipher!.encrypt(value),
        }
        await this.options.send(encodeOpaquePayload(frame))
    }

    private async sendApplication(value: unknown): Promise<void> {
        await this.options.send(await this.createApplicationOutput(value))
    }

    private async createApplicationOutput(value: unknown): Promise<string> {
        const messageId = this.messageId()
        const frame: DeviceHpkeDataFrame = {
            version: PROTOCOL_VERSION,
            type: 'device.hpke-data',
            messageId,
            envelope: await this.applicationCipher!.encrypt(value, { messageId }),
        }
        return encodeOpaquePayload(frame)
    }

    private async initializeApplicationCipher(deviceHpkeKeyId: string, deviceHpkePublicKey: string): Promise<void> {
        this.applicationCipher = await HpkeMessageCipher.create({
            localId: this.options.gatewayId,
            remoteId: this.credentialId!,
            localKeyPair: this.options.authenticator.hpkeKeyPair,
            remoteKey: { keyId: deviceHpkeKeyId, publicKey: deviceHpkePublicKey },
            now: () => this.now(),
        })
    }

    private cacheResponse(messageId: string, output: string): void {
        this.responseCache.set(messageId, output)
        if (this.responseCache.size > RESPONSE_CACHE_LIMIT) {
            const oldest = this.responseCache.keys().next().value as string | undefined
            if (oldest) this.responseCache.delete(oldest)
        }
    }

    private async sendHandshake(frame: DeviceSecureHandshakeFrame): Promise<void> {
        await this.options.send(encodeOpaquePayload(frame))
    }

    private messageId(): string { return this.options.createMessageId?.() ?? randomUUID() }
    private now(): number { return this.options.now?.() ?? Date.now() }
}

export function encodeOpaquePayload(value: unknown): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

export function decodeOpaquePayload(value: string): unknown {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 262_144) throw new Error('Invalid opaque payload encoding')
    try {
        return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    } catch (error) {
        throw new Error('Opaque payload is not valid JSON', { cause: error })
    }
}

function isFrameType(value: unknown, type: string): boolean {
    return !!value && typeof value === 'object' && !Array.isArray(value)
        && 'type' in value && (value as { type?: unknown }).type === type
}
