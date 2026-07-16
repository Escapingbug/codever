import type { GatewayFrame } from '@codever/protocol'
import type WebSocket from 'ws'

export interface GatewayConnection {
    gatewayId: string
    connectionEpoch: string
    socket: WebSocket
    ready: boolean
}

export class GatewayConnectionRegistry {
    private readonly connections = new Map<string, GatewayConnection>()

    replace(connection: Omit<GatewayConnection, 'ready'> & { ready?: boolean }): GatewayConnection | undefined {
        const previous = this.connections.get(connection.gatewayId)
        this.connections.set(connection.gatewayId, { ...connection, ready: connection.ready ?? false })
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
        current.socket.send(JSON.stringify(frame))
        return true
    }
}
