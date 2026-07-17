import { randomUUID } from 'node:crypto'
import { PROTOCOL_VERSION, type RelayDeviceTunnelFrame } from '@codever/protocol'

export type DeviceTunnelCloseCode = Extract<
    RelayDeviceTunnelFrame,
    { type: 'relay.device-tunnel.closed' }
>['payload']['code']

interface DeviceTunnel {
    tunnelId: string
    gatewayId: string
    ownerId: string
    send: (frame: RelayDeviceTunnelFrame) => void | Promise<void>
}

export interface RemovedDeviceTunnel {
    tunnelId: string
    gatewayId: string
}

export class DeviceTunnelRegistry {
    private readonly tunnels = new Map<string, DeviceTunnel>()

    open(gatewayId: string, ownerId: string, send: DeviceTunnel['send']): string {
        const tunnelId = randomUUID()
        this.tunnels.set(tunnelId, { tunnelId, gatewayId, ownerId, send })
        return tunnelId
    }

    gatewayForOwner(tunnelId: string, ownerId: string): string | undefined {
        const tunnel = this.tunnels.get(tunnelId)
        return tunnel?.ownerId === ownerId ? tunnel.gatewayId : undefined
    }

    send(gatewayId: string, tunnelId: string, opaquePayload: string): boolean {
        const tunnel = this.tunnels.get(tunnelId)
        if (!tunnel || tunnel.gatewayId !== gatewayId) return false
        void Promise.resolve(tunnel.send({
            version: PROTOCOL_VERSION,
            type: 'relay.device-tunnel.data',
            messageId: randomUUID(),
            payload: { tunnelId, opaquePayload },
        })).catch(() => undefined)
        return true
    }

    close(tunnelId: string, code: DeviceTunnelCloseCode, reason?: string): boolean {
        const tunnel = this.tunnels.get(tunnelId)
        if (!tunnel) return false
        this.tunnels.delete(tunnelId)
        void Promise.resolve(tunnel.send({
            version: PROTOCOL_VERSION,
            type: 'relay.device-tunnel.closed',
            messageId: randomUUID(),
            payload: { tunnelId, code, ...(reason ? { reason } : {}) },
        })).catch(() => undefined)
        return true
    }

    closeFromGateway(gatewayId: string, tunnelId: string, code: DeviceTunnelCloseCode, reason?: string): boolean {
        const tunnel = this.tunnels.get(tunnelId)
        return tunnel?.gatewayId === gatewayId && this.close(tunnelId, code, reason)
    }

    closeGateway(gatewayId: string, code: DeviceTunnelCloseCode, reason?: string): void {
        for (const tunnel of [...this.tunnels.values()]) {
            if (tunnel.gatewayId === gatewayId) this.close(tunnel.tunnelId, code, reason)
        }
    }

    removeOwner(ownerId: string): RemovedDeviceTunnel[] {
        const removed: RemovedDeviceTunnel[] = []
        for (const tunnel of [...this.tunnels.values()]) {
            if (tunnel.ownerId !== ownerId) continue
            this.tunnels.delete(tunnel.tunnelId)
            removed.push({ tunnelId: tunnel.tunnelId, gatewayId: tunnel.gatewayId })
        }
        return removed
    }
}
