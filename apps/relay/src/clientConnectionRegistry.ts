import type WebSocket from 'ws'

export interface ClientConnection {
    clientId: string
    sessionId: string
    socket: WebSocket
}

export class ClientConnectionRegistry {
    private readonly connections = new Map<string, ClientConnection>()

    replace(connection: ClientConnection): ClientConnection | undefined {
        const previous = this.connections.get(connection.clientId)
        this.connections.set(connection.clientId, connection)
        if (previous && previous.socket !== connection.socket) {
            previous.socket.close(4001, 'Replaced by a newer Client connection')
        }
        return previous
    }

    removeIfCurrent(clientId: string, sessionId: string, socket: WebSocket): boolean {
        const current = this.connections.get(clientId)
        if (current?.sessionId !== sessionId || current.socket !== socket) return false
        this.connections.delete(clientId)
        return true
    }

    get(clientId: string): ClientConnection | undefined { return this.connections.get(clientId) }
}
