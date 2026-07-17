import { randomUUID } from 'node:crypto'
import {
    PROTOCOL_VERSION,
    parseClientRelaySecureDataPayload,
    parseRelayClientSecureHandshakeFrame,
    parseRelayClientCredentialRegistrationFrame,
    parseSecureDataFrame,
    type GatewayFrame,
    type RelayClientSecureHandshakeFrame,
    type RelayDeviceTunnelFrame,
    type SecureDataFrame,
} from '@codever/protocol'
import { SessionCipher } from '@codever/secure-channel'
import type WebSocket from 'ws'
import type { ClientConnectionRegistry } from './clientConnectionRegistry'
import type { GatewayConnectionRegistry } from './connectionRegistry'
import type { DeviceTunnelRegistry } from './deviceTunnelRegistry'
import type { RelayRepositories } from './server'
import type { SecureClientAuthenticator } from './secureClientAuth'

export class ClientSecureSession {
    readonly sessionId = randomUUID()
    private state: 'waiting-start' | 'waiting-finish' | 'provisioning' | 'ready' | 'closed' = 'waiting-start'
    private clientId?: string
    private handshakeId?: string
    private cipher?: SessionCipher
    private registrationStarted = false
    private incoming = Promise.resolve()
    private outgoing = Promise.resolve()

    constructor(private readonly options: {
        socket: WebSocket
        authenticator: SecureClientAuthenticator
        repositories: RelayRepositories
        clients: ClientConnectionRegistry
        gateways: GatewayConnectionRegistry
        tunnels: DeviceTunnelRegistry
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
        if (this.clientId) this.options.clients.removeIfCurrent(this.clientId, this.sessionId, this.options.socket)
        for (const tunnel of this.options.tunnels.removeOwner(this.sessionId)) {
            const connection = this.options.gateways.get(tunnel.gatewayId)
            if (!connection?.ready) continue
            this.options.gateways.send(tunnel.gatewayId, gatewayTunnelFrame(
                'device.tunnel.close', tunnel.gatewayId, connection.connectionEpoch,
                { tunnelId: tunnel.tunnelId, code: 'normal', reason: 'Client connection closed' },
            ))
        }
        this.cipher = undefined
    }

    private async process(value: unknown): Promise<void> {
        if (this.state === 'closed') throw new Error('Client secure session is closed')
        if (!this.cipher) return this.processHandshake(parseRelayClientSecureHandshakeFrame(value))
        const plaintext = await this.cipher.decrypt(parseSecureDataFrame(value).envelope)
        if (this.state === 'provisioning') return this.processProvisioning(plaintext)
        if (this.state !== 'ready') throw new Error('Client secure session is not ready')
        const frame = parseClientRelaySecureDataPayload(plaintext)
        if (frame.type === 'client.relay.gateways.request') {
            await this.sendEncrypted({
                version: PROTOCOL_VERSION,
                type: 'relay.client.gateways.response',
                requestId: frame.requestId,
                gateways: await this.options.repositories.gateways.list(),
            })
            return
        }
        if (frame.type === 'device.tunnel.open') return this.openTunnel(frame.payload.gatewayId)
        if (frame.type !== 'device.tunnel.data' && frame.type !== 'device.tunnel.close') {
            throw new Error(`Unexpected Client secure frame: ${frame.type}`)
        }
        const tunnel = this.findOwnedTunnel(frame.payload.tunnelId)
        if (frame.type === 'device.tunnel.data') {
            if (!this.options.gateways.send(tunnel.gatewayId, gatewayTunnelFrame(
                'device.tunnel.data', tunnel.gatewayId, tunnel.connectionEpoch,
                { tunnelId: frame.payload.tunnelId, opaquePayload: frame.payload.opaquePayload },
            ))) this.options.tunnels.close(frame.payload.tunnelId, 'gateway_offline', 'Gateway connection was lost')
            return
        }
        this.options.gateways.send(tunnel.gatewayId, gatewayTunnelFrame(
            'device.tunnel.close', tunnel.gatewayId, tunnel.connectionEpoch,
            { tunnelId: frame.payload.tunnelId, code: 'normal', ...(frame.payload.reason ? { reason: frame.payload.reason } : {}) },
        ))
        this.options.tunnels.close(frame.payload.tunnelId, 'normal', frame.payload.reason)
    }

    private async processHandshake(frame: RelayClientSecureHandshakeFrame): Promise<void> {
        if (this.state === 'waiting-start') {
            if (frame.type !== 'client.relay-auth.start') throw new Error('Secure authentication must start with client.relay-auth.start')
            this.clientId = frame.payload.credentialId
            const started = await this.options.authenticator.begin({
                mode: frame.payload.mode,
                clientId: frame.payload.credentialId,
                subjectId: frame.payload.subjectId,
                startLoginRequest: frame.payload.startLoginRequest,
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
        this.state = finished.credentialProvisioningRequired ? 'provisioning' : 'ready'
        this.options.clients.replace({ clientId: this.clientId!, sessionId: this.sessionId, socket: this.options.socket })
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
                    provisioningRequired: finished.credentialProvisioningRequired,
                }),
            },
        } satisfies RelayClientSecureHandshakeFrame)
    }

    private async processProvisioning(value: unknown): Promise<void> {
        const frame = parseRelayClientCredentialRegistrationFrame(value)
        if (frame.type === 'client.credential.registration.start') {
            if (this.registrationStarted || frame.payload.credentialId !== this.clientId) {
                throw new Error('Invalid Client credential registration start')
            }
            this.registrationStarted = true
            const response = await this.options.authenticator.createCredentialRegistrationResponse(
                this.clientId!, frame.payload.registrationRequest,
            )
            await this.sendEncrypted({
                version: PROTOCOL_VERSION,
                type: 'relay.client-credential.registration.response',
                messageId: randomUUID(),
                payload: { credentialId: this.clientId!, ...response },
            })
            return
        }
        if (frame.type !== 'client.credential.registration.commit' || !this.registrationStarted
            || frame.payload.credentialId !== this.clientId) {
            throw new Error('Invalid Client credential registration commit')
        }
        await this.options.authenticator.commitCredential(this.clientId!, frame.payload.registrationRecord)
        await this.sendEncrypted({
            version: PROTOCOL_VERSION,
            type: 'relay.client-credential.registration.accepted',
            messageId: randomUUID(),
            payload: { credentialId: this.clientId!, registeredAt: new Date().toISOString() },
        })
        this.registrationStarted = false
        this.state = 'ready'
    }

    private async openTunnel(gatewayId: string): Promise<void> {
        const gateway = await this.options.repositories.gateways.get(gatewayId)
        const connection = this.options.gateways.get(gatewayId)
        if (!gateway || !connection?.ready) throw new Error('Gateway is unknown or offline')
        const tunnelId = this.options.tunnels.open(gatewayId, this.sessionId, frame => this.sendEncrypted(frame))
        const openedAt = new Date().toISOString()
        if (!this.options.gateways.send(gatewayId, gatewayTunnelFrame(
            'device.tunnel.open', gatewayId, connection.connectionEpoch, { tunnelId, openedAt },
        ))) {
            this.options.tunnels.close(tunnelId, 'gateway_offline', 'Gateway connection was lost')
            return
        }
        await this.sendEncrypted({
            version: PROTOCOL_VERSION,
            type: 'relay.device-tunnel.opened',
            messageId: randomUUID(),
            payload: { gatewayId, tunnelId, openedAt },
        } satisfies RelayDeviceTunnelFrame)
    }

    private findOwnedTunnel(tunnelId: string): { gatewayId: string; connectionEpoch: string } {
        const gatewayId = this.options.tunnels.gatewayForOwner(tunnelId, this.sessionId)
        if (!gatewayId) throw new Error('Device tunnel ID mismatch')
        const connection = this.options.gateways.get(gatewayId)
        if (!connection?.ready) throw new Error('Gateway is offline')
        return { gatewayId, connectionEpoch: connection.connectionEpoch }
    }

    private sendEncrypted(value: unknown): Promise<void> {
        const cipher = this.cipher
        if (!cipher) return Promise.reject(new Error('Client secure channel is not established'))
        return this.queueSend(async () => ({
            version: PROTOCOL_VERSION,
            type: 'secure.data',
            messageId: randomUUID(),
            envelope: await cipher.encrypt(value),
        } satisfies SecureDataFrame))
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

function gatewayTunnelFrame<T extends 'device.tunnel.open' | 'device.tunnel.data' | 'device.tunnel.close'>(
    type: T,
    gatewayId: string,
    connectionEpoch: string,
    payload: Extract<GatewayFrame, { type: T }>['payload'],
): Extract<GatewayFrame, { type: T }> {
    return { version: PROTOCOL_VERSION, type, messageId: randomUUID(), gatewayId, connectionEpoch, payload } as Extract<GatewayFrame, { type: T }>
}
