import type { ClientGatewayResponseFrame } from '@codever/protocol'
import type { MatrixTransportEvent } from '../../apps/web/src/api/nativeMatrixClient'
import type { MatrixTransportPort } from '../../apps/web/src/api/matrixGatewayClient'
import type {
    MatrixSendInput,
    MatrixTransport,
    NativeMatrixEvent,
} from '../../src/gateway/matrix/nativeMatrixTransport'

export interface MatrixControlTrust {
    clientTrustsGateway: boolean
    gatewayTrustsClient: boolean
}

export interface MatrixDeliveryFault {
    delayMs?: number
    drop?: boolean
    duplicate?: boolean
}

export interface MatrixTrafficRecord {
    direction: 'client-to-gateway' | 'gateway-to-client'
    eventType: string
    transactionId: string
    content: unknown
}

/**
 * In-memory Matrix room used by protocol E2E tests.
 *
 * Trust is deliberately directional: Matrix verification is local state, so a
 * newly installed client can trust a retained Gateway while the Gateway still
 * rejects that new client device. Delivery faults model the properties that the
 * real Matrix timeline exposes to Codever: delay, loss before sync, and replay.
 */
export class MatrixControlHarness {
    readonly traffic: MatrixTrafficRecord[] = []
    readonly client: MatrixTransportPort
    readonly gateway: MatrixTransport
    trust: MatrixControlTrust
    clientToGateway: MatrixDeliveryFault = {}
    gatewayToClient: MatrixDeliveryFault = {}

    private clientSubscriber?: (event: MatrixTransportEvent) => void
    private gatewaySubscriber?: (event: NativeMatrixEvent) => void

    constructor(
        trust: MatrixControlTrust,
        readonly clientDeviceId = 'CLIENT-NEW',
        readonly gatewayDeviceId = 'GATEWAY-RETAINED',
    ) {
        this.trust = { ...trust }
        this.client = {
            subscribe: subscriber => {
                this.clientSubscriber = subscriber
                return () => { if (this.clientSubscriber === subscriber) this.clientSubscriber = undefined }
            },
            signExecution: async () => 'e2e-cose-token',
            send: async input => {
                this.traffic.push({ direction: 'client-to-gateway', ...input })
                this.deliver(this.clientToGateway, () => this.gatewaySubscriber?.({
                    roomId: input.roomId,
                    encrypted: true,
                    verifiedDevice: this.trust.gatewayTrustsClient,
                    senderDevice: this.clientDeviceId,
                    event: { type: input.eventType, content: input.content },
                }))
                return `$client-${this.traffic.length}`
            },
        }
        this.gateway = {
            initialize: async () => undefined,
            close: async () => undefined,
            onEvent: subscriber => {
                this.gatewaySubscriber = subscriber
                return () => { if (this.gatewaySubscriber === subscriber) this.gatewaySubscriber = undefined }
            },
            send: async input => {
                this.traffic.push({ direction: 'gateway-to-client', ...input })
                this.deliver(this.gatewayToClient, () => this.clientSubscriber?.({
                    roomId: input.roomId,
                    encrypted: true,
                    verifiedDevice: this.trust.clientTrustsGateway,
                    senderDevice: this.gatewayDeviceId,
                    event: { type: input.eventType, content: input.content },
                }))
                return `$gateway-${this.traffic.length}`
            },
        }
    }

    responses(): ClientGatewayResponseFrame[] {
        return this.traffic
            .filter(record => record.direction === 'gateway-to-client' && record.eventType === 'io.codever.response.v1')
            .flatMap(record => {
                const content = record.content as { response?: ClientGatewayResponseFrame }
                return content.response ? [content.response] : []
            })
    }

    private deliver(fault: MatrixDeliveryFault, delivery: () => void): void {
        if (fault.drop) return
        const run = () => {
            delivery()
            if (fault.duplicate) delivery()
        }
        if ((fault.delayMs ?? 0) > 0) setTimeout(run, fault.delayMs)
        else queueMicrotask(run)
    }
}

export function completedInventory(requestId: string): ClientGatewayResponseFrame {
    return {
        version: 1,
        type: 'gateway.client.response',
        requestId,
        status: 'completed',
        completedAt: '2026-07-20T08:00:00.000Z',
        payload: {
            generatedAt: '2026-07-20T08:00:00.000Z',
            revision: 1,
            projects: [],
            sessions: [],
        },
    }
}
