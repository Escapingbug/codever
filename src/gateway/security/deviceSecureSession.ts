import { randomUUID } from 'node:crypto'
import {
    PROTOCOL_VERSION,
    parseClientGatewayRequestFrame,
    parseDeviceCredentialFrame,
    parseDeviceSecureHandshakeFrame,
    parseSecureDataFrame,
    type ClientGatewayEventFrame,
    type ClientGatewayRequestFrame,
    type ClientGatewayResponseFrame,
    type DeviceCredentialFrame,
    type DeviceSecureHandshakeFrame,
    type SecureDataFrame,
} from '@codever/protocol'
import { SessionCipher } from '@codever/secure-channel'
import type { DeviceAuthenticator } from './deviceAuthenticator'

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
    private state: 'waiting-start' | 'waiting-finish' | 'provisioning' | 'ready' | 'closed' = 'waiting-start'
    private handshakeId?: string
    private credentialId?: string
    private cipher?: SessionCipher
    private registrationStarted = false
    private incoming = Promise.resolve()

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
        if (!this.ready) throw new Error('Device secure session is not ready')
        await this.sendEncrypted(event)
    }

    close(): void {
        this.state = 'closed'
        this.handshakeId = undefined
        this.credentialId = undefined
        this.cipher = undefined
    }

    private async process(value: unknown): Promise<void> {
        if (this.state === 'closed') throw new Error('Device secure session is closed')
        if (!this.cipher) return this.processHandshake(value)
        const encrypted = parseSecureDataFrame(value)
        const plaintext = await this.cipher.decrypt(encrypted.envelope)
        if (this.state === 'provisioning') return this.processProvisioning(plaintext)
        if (this.state !== 'ready') throw new Error('Device secure session is not ready for application data')
        const request = parseClientGatewayRequestFrame(plaintext)
        const response = await this.options.handleRequest(request, this.credentialId!)
        if (response.requestId !== request.requestId) throw new Error('Device response requestId mismatch')
        await this.sendEncrypted(response)
    }

    private async processHandshake(value: unknown): Promise<void> {
        const frame = parseDeviceSecureHandshakeFrame(value)
        if (this.state === 'waiting-start') {
            if (frame.type !== 'client.secure-auth.start') throw new Error('Device authentication must start with client.secure-auth.start')
            const started = await this.options.authenticator.begin({
                mode: frame.payload.mode,
                credentialId: frame.payload.credentialId,
                subjectId: frame.payload.subjectId,
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
                    ...(started.attemptsRemaining !== undefined ? { attemptsRemaining: started.attemptsRemaining } : {}),
                },
            })
        }
        if (this.state !== 'waiting-finish' || frame.type !== 'client.secure-auth.finish'
            || frame.payload.handshakeId !== this.handshakeId) {
            throw new Error('Device authentication finish does not match the active handshake')
        }
        const finished = await this.options.authenticator.finish(frame.payload)
        if (finished.credentialId !== this.credentialId) throw new Error('Authenticated device credential changed')
        this.cipher = await SessionCipher.create({
            sessionKey: finished.sessionKey,
            role: 'responder',
            channelId: this.messageId(),
        })
        const acceptedPayload = {
            gatewayId: this.options.gatewayId,
            credentialId: finished.credentialId,
            acceptedAt: new Date(this.now()).toISOString(),
            credentialProvisioningRequired: finished.credentialProvisioningRequired,
        }
        this.state = finished.credentialProvisioningRequired ? 'provisioning' : 'ready'
        await this.sendHandshake({
            version: PROTOCOL_VERSION,
            type: 'gateway.secure-auth.accepted',
            messageId: this.messageId(),
            payload: {
                handshakeId: frame.payload.handshakeId,
                envelope: await this.cipher.encrypt(acceptedPayload),
            },
        })
    }

    private async processProvisioning(value: unknown): Promise<void> {
        const frame = parseDeviceCredentialFrame(value)
        if (frame.type === 'device.credential.registration.start') {
            if (this.registrationStarted || frame.payload.deviceId !== this.credentialId) {
                throw new Error('Invalid device credential registration start')
            }
            this.registrationStarted = true
            const response = await this.options.authenticator.createCredentialRegistrationResponse(
                this.credentialId!, frame.payload.registrationRequest,
            )
            return this.sendEncrypted({
                version: PROTOCOL_VERSION,
                type: 'device.credential.registration.response',
                messageId: this.messageId(),
                payload: { deviceId: this.credentialId!, ...response },
            } satisfies DeviceCredentialFrame)
        }
        if (frame.type !== 'device.credential.registration.commit' || !this.registrationStarted
            || frame.payload.deviceId !== this.credentialId) {
            throw new Error('Invalid device credential registration commit')
        }
        const credential = await this.options.authenticator.commitCredential(
            this.credentialId!, frame.payload.registrationRecord,
        )
        await this.sendEncrypted({
            version: PROTOCOL_VERSION,
            type: 'device.credential.registration.accepted',
            messageId: this.messageId(),
            payload: { deviceId: credential.credentialId, registeredAt: credential.createdAt },
        } satisfies DeviceCredentialFrame)
        this.registrationStarted = false
        this.state = 'ready'
    }

    private async sendEncrypted(value: unknown): Promise<void> {
        const frame: SecureDataFrame = {
            version: PROTOCOL_VERSION,
            type: 'secure.data',
            messageId: this.messageId(),
            envelope: await this.cipher!.encrypt(value),
        }
        await this.options.send(encodeOpaquePayload(frame))
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
