import {
    PROTOCOL_VERSION,
    parseGatewaySecureHandshakeFrame,
    parseRelaySecureAuthAcceptedPayload,
    parseSecureControlFrame,
    parseSecureDataFrame,
    type GatewaySecureHandshakeFrame,
    type RelaySecureAuthAcceptedPayload,
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
import type { GatewaySecureCredential } from './secureCredentialStore'

export type SecureGatewayHandshakeOutput = GatewaySecureHandshakeFrame | SecureDataFrame

export class SecureGatewayHandshake {
    private pairingCode?: string
    private credential?: GatewaySecureCredential
    private clientLoginState?: string
    private sessionKey?: string
    private relayId?: string
    private relayStaticPublicKey?: string
    private handshakeId?: string
    private cipherValue?: SessionCipher
    private acceptedValue?: RelaySecureAuthAcceptedPayload
    private registration?: { secret: string; clientRegistrationState: string }
    private state: 'idle' | 'waiting-response' | 'waiting-accepted' | 'provisioning' | 'ready' = 'idle'

    constructor(private readonly options: {
        gatewayId: string
        pairingCode?: string
        credential?: GatewaySecureCredential
        createMessageId: () => string
        saveCredential: (credential: GatewaySecureCredential) => Promise<void>
    }) {
        if (!options.pairingCode && !options.credential) throw new Error('A pairing code or secure Relay credential is required')
        this.pairingCode = options.pairingCode
        this.credential = options.credential
    }

    get ready(): boolean { return this.state === 'ready' }
    get cipher(): SessionCipher | undefined { return this.cipherValue }
    get accepted(): RelaySecureAuthAcceptedPayload | undefined { return this.acceptedValue }

    async start(): Promise<GatewaySecureHandshakeFrame> {
        if (this.state !== 'idle') throw new Error('Secure Gateway handshake already started')
        let subjectId: string
        let startLoginRequest: string
        let mode: 'pairing' | 'credential'
        if (this.credential) {
            const started = await startOpaqueCredentialLogin(this.credential.secret)
            this.clientLoginState = started.clientLoginState
            startLoginRequest = started.startLoginRequest
            subjectId = this.options.gatewayId
            mode = 'credential'
        } else {
            const started = await startOpaquePairingClient(this.pairingCode!)
            this.clientLoginState = started.clientLoginState
            startLoginRequest = started.startLoginRequest
            subjectId = started.pairingId
            mode = 'pairing'
        }
        this.state = 'waiting-response'
        return {
            version: PROTOCOL_VERSION,
            type: 'gateway.secure-auth.start',
            messageId: this.options.createMessageId(),
            payload: { gatewayId: this.options.gatewayId, mode, subjectId, startLoginRequest },
        }
    }

    async handleHandshake(value: unknown): Promise<SecureGatewayHandshakeOutput | undefined> {
        const frame = parseGatewaySecureHandshakeFrame(value)
        if (frame.type === 'relay.secure-auth.rejected') throw new Error(`Secure Relay authentication rejected: ${frame.payload.message}`)
        if (this.state === 'waiting-response') {
            if (frame.type !== 'relay.secure-auth.response') throw new Error('Expected secure authentication response')
            this.relayId = frame.payload.relayId
            this.handshakeId = frame.payload.handshakeId
            let finishLoginRequest: string
            if (this.credential) {
                if (this.credential.relayId !== this.relayId) throw new Error('Relay identity changed')
                const finished = await finishOpaqueCredentialClientLogin({
                    secret: this.credential.secret,
                    subjectId: this.options.gatewayId,
                    serverId: this.relayId,
                    clientLoginState: this.clientLoginState!,
                    loginResponse: frame.payload.loginResponse,
                    expectedServerStaticPublicKey: this.credential.relayStaticPublicKey,
                })
                finishLoginRequest = finished.finishLoginRequest
                this.sessionKey = finished.sessionKey
                this.relayStaticPublicKey = this.credential.relayStaticPublicKey
            } else {
                const finished = finishOpaquePairingClient({
                    code: this.pairingCode!,
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
                type: 'gateway.secure-auth.finish',
                messageId: this.options.createMessageId(),
                payload: { handshakeId: frame.payload.handshakeId, finishLoginRequest },
            }
        }
        if (this.state !== 'waiting-accepted' || frame.type !== 'relay.secure-auth.accepted') {
            throw new Error('Unexpected secure authentication frame')
        }
        if (frame.payload.handshakeId !== this.handshakeId) throw new Error('Secure authentication handshake ID changed')
        this.cipherValue = await SessionCipher.create({
            sessionKey: this.sessionKey!, role: 'initiator', channelId: frame.payload.envelope.channelId,
        })
        this.acceptedValue = parseRelaySecureAuthAcceptedPayload(await this.cipherValue.decrypt(frame.payload.envelope))
        if (this.acceptedValue.gatewayId !== this.options.gatewayId) throw new Error('Relay accepted another Gateway identity')
        if (!this.acceptedValue.credentialProvisioningRequired) {
            this.state = 'ready'
            return undefined
        }
        const secret = generateOpaqueCredentialSecret()
        const registration = await startOpaqueCredentialRegistration(secret)
        this.registration = { secret, clientRegistrationState: registration.clientRegistrationState }
        this.state = 'provisioning'
        return this.encryptControl({
            version: PROTOCOL_VERSION,
            type: 'gateway.credential.registration.start',
            messageId: this.options.createMessageId(),
            payload: { gatewayId: this.options.gatewayId, registrationRequest: registration.registrationRequest },
        })
    }

    async handleSecureData(value: unknown): Promise<SecureDataFrame | undefined> {
        if (this.state !== 'provisioning' || !this.cipherValue || !this.registration) throw new Error('Credential provisioning is not active')
        const wire = parseSecureDataFrame(value)
        const control = parseSecureControlFrame(await this.cipherValue.decrypt(wire.envelope))
        if (control.type === 'relay.credential.registration.response') {
            if (control.payload.gatewayId !== this.options.gatewayId) throw new Error('Credential response belongs to another Gateway')
            const finished = await finishOpaqueCredentialRegistration({
                secret: this.registration.secret,
                subjectId: this.options.gatewayId,
                serverId: this.relayId!,
                clientRegistrationState: this.registration.clientRegistrationState,
                registrationResponse: control.payload.registrationResponse,
                expectedServerStaticPublicKey: this.relayStaticPublicKey,
            })
            return this.encryptControl({
                version: PROTOCOL_VERSION,
                type: 'gateway.credential.registration.commit',
                messageId: this.options.createMessageId(),
                payload: { gatewayId: this.options.gatewayId, registrationRecord: finished.registrationRecord },
            })
        }
        if (control.type !== 'relay.credential.registration.accepted' || control.payload.gatewayId !== this.options.gatewayId) {
            throw new Error('Unexpected credential provisioning response')
        }
        const credential: GatewaySecureCredential = {
            version: 1,
            gatewayId: this.options.gatewayId,
            relayId: this.relayId!,
            relayStaticPublicKey: this.relayStaticPublicKey!,
            secret: this.registration.secret,
            createdAt: control.payload.registeredAt,
        }
        await this.options.saveCredential(credential)
        this.credential = credential
        this.pairingCode = undefined
        this.registration = undefined
        this.state = 'ready'
        return undefined
    }

    async encryptApplication(value: unknown): Promise<SecureDataFrame> {
        if (!this.ready || !this.cipherValue) throw new Error('Secure Gateway channel is not ready')
        return {
            version: PROTOCOL_VERSION,
            type: 'secure.data',
            messageId: this.options.createMessageId(),
            envelope: await this.cipherValue.encrypt(value),
        }
    }

    async decryptApplication(value: unknown): Promise<unknown> {
        if (!this.ready || !this.cipherValue) throw new Error('Secure Gateway channel is not ready')
        return this.cipherValue.decrypt(parseSecureDataFrame(value).envelope)
    }

    private async encryptControl(value: unknown): Promise<SecureDataFrame> {
        return {
            version: PROTOCOL_VERSION,
            type: 'secure.data',
            messageId: this.options.createMessageId(),
            envelope: await this.cipherValue!.encrypt(value),
        }
    }
}
