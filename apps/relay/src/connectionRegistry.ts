import type { GatewayFrame } from '@codever/protocol'
import type WebSocket from 'ws'

export interface GatewayConnection {
    gatewayId: string
    connectionEpoch: string
    socket: WebSocket
    ready: boolean
    encode?: (frame: GatewayFrame) => Promise<string>
    outgoing: Promise<void>
}

export class GatewayConnectionRegistry {
    private readonly connections = new Map<string, GatewayConnection>()

    replace(connection: Omit<GatewayConnection, 'ready' | 'outgoing'> & { ready?: boolean }): GatewayConnection | undefined {
        const previous = this.connections.get(connection.gatewayId)
        this.connections.set(connection.gatewayId, { ...connection, ready: connection.ready ?? false, outgoing: Promise.resolve() })
        if (previous && previous.socket !== connection.socket) {
            previous.socket.close(4001, 'Replaced by a newer gateway connection')
        }
        return previous
    }

    get(gatewayId: string): GatewayConnection | undefined {
        return this.connections.get(gatewayId)
    }

    markReady(gatewayId: string, connectionEpoch: string, socket: WebSocket): boolean {
        const current = this.connections.get(gatewayId)
        if (!current || !this.isCurrent(gatewayId, connectionEpoch, socket)) return false
        current.ready = true
        return true
    }

    isCurrent(gatewayId: string, connectionEpoch: string, socket?: WebSocket): boolean {
        const current = this.connections.get(gatewayId)
        return current?.connectionEpoch === connectionEpoch && (!socket || current.socket === socket)
    }

    removeIfCurrent(gatewayId: string, connectionEpoch: string, socket: WebSocket): boolean {
        if (!this.isCurrent(gatewayId, connectionEpoch, socket)) return false
        this.connections.delete(gatewayId)
        return true
    }

    send(gatewayId: string, frame: GatewayFrame): boolean {
        const current = this.connections.get(gatewayId)
        if (!current || !current.ready || current.socket.readyState !== current.socket.OPEN) return false
        if (frame.connectionEpoch !== current.connectionEpoch) return false
        current.outgoing = current.outgoing.then(async () => {
            const payload = current.encode ? await current.encode(frame) : JSON.stringify(frame)
            if (this.isCurrent(gatewayId, current.connectionEpoch, current.socket)
                && current.socket.readyState === current.socket.OPEN) {
                current.socket.send(payload)
            }
        }).catch(() => current.socket.close(1011, 'Failed to encrypt or send Gateway frame'))
        return true
    }
}
