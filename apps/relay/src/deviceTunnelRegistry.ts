import { randomUUID } from 'node:crypto'
import { PROTOCOL_VERSION, type ClientDeviceTunnelFrame } from '@codever/protocol'
import type WebSocket from 'ws'

export type DeviceTunnelCloseCode = Extract<
    ClientDeviceTunnelFrame,
    { type: 'relay.device-tunnel.closed' }
>['payload']['code']

interface DeviceTunnel {
    tunnelId: string
    gatewayId: string
    socket: WebSocket
}

export class DeviceTunnelRegistry {
    private readonly tunnels = new Map<string, DeviceTunnel>()

    open(gatewayId: string, socket: WebSocket): string {
        const tunnelId = randomUUID()
        this.tunnels.set(tunnelId, { tunnelId, gatewayId, socket })
        return tunnelId
    }

    owns(tunnelId: string, gatewayId: string, socket: WebSocket): boolean {
        const tunnel = this.tunnels.get(tunnelId)
        return tunnel?.gatewayId === gatewayId && tunnel.socket === socket
    }

    send(gatewayId: string, tunnelId: string, opaquePayload: string): boolean {
        const tunnel = this.tunnels.get(tunnelId)
        if (!tunnel || tunnel.gatewayId !== gatewayId || tunnel.socket.readyState !== tunnel.socket.OPEN) return false
        const frame: ClientDeviceTunnelFrame = {
            version: PROTOCOL_VERSION,
            type: 'relay.device-tunnel.data',
            messageId: randomUUID(),
            payload: { tunnelId, opaquePayload },
        }
        tunnel.socket.send(JSON.stringify(frame))
        return true
    }

    close(tunnelId: string, code: DeviceTunnelCloseCode, reason?: string): boolean {
        const tunnel = this.tunnels.get(tunnelId)
        if (!tunnel) return false
        this.tunnels.delete(tunnelId)
        if (tunnel.socket.readyState === tunnel.socket.OPEN) {
            const frame: ClientDeviceTunnelFrame = {
                version: PROTOCOL_VERSION,
                type: 'relay.device-tunnel.closed',
                messageId: randomUUID(),
                payload: { tunnelId, code, ...(reason ? { reason } : {}) },
            }
            tunnel.socket.send(JSON.stringify(frame))
            tunnel.socket.close(code === 'normal' ? 1000 : 1011, reason ?? code)
        }
        return true
    }

    closeGateway(gatewayId: string, code: DeviceTunnelCloseCode, reason?: string): void {
        for (const tunnel of [...this.tunnels.values()]) {
            if (tunnel.gatewayId === gatewayId) this.close(tunnel.tunnelId, code, reason)
        }
    }

    removeSocket(socket: WebSocket): string[] {
        const removed: string[] = []
        for (const tunnel of [...this.tunnels.values()]) {
            if (tunnel.socket !== socket) continue
            this.tunnels.delete(tunnel.tunnelId)
            removed.push(tunnel.tunnelId)
        }
        return removed
    }
}
