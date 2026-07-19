import type { ClientGatewayResponseFrame } from '@codever/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { AuthorizedRequestProcessor } from '../../authorizedRequestProcessor'
import {
    MatrixGatewayWorker, MATRIX_COMMAND_EVENT, MATRIX_DISCOVERY_EVENT,
    MATRIX_GATEWAY_EVENT, MATRIX_INVENTORY_EVENT, MATRIX_RESPONSE_EVENT,
} from '../matrixGatewayWorker'
import type { MatrixSendInput, MatrixTransport, NativeMatrixEvent } from '../nativeMatrixTransport'

describe('MatrixGatewayWorker', () => {
    it('answers verified encrypted discovery without invoking execution authorization', async () => {
        const transport = new FakeTransport()
        const process = vi.fn()
        const worker = new MatrixGatewayWorker({
            gatewayId: 'gateway-1', controlRoomId: '!control:test', transport,
            processor: { process } as unknown as AuthorizedRequestProcessor,
            currentGateway: () => ({
                id: 'gateway-1', workspaceId: 'default', name: 'Computer', platform: 'windows',
                version: '0.1.0', status: 'online', capabilities: { protocolVersions: [1], providers: [], features: [] },
            }),
            currentInventory: async () => ({
                generatedAt: '2026-07-19T05:00:00.000Z', revision: 4, projects: [], sessions: [],
            }),
        })
        await worker.start()
        transport.emit({
            roomId: '!control:test', encrypted: true, verifiedDevice: true, senderDevice: 'PHONE',
            event: { type: MATRIX_DISCOVERY_EVENT, content: { version: 1, requestId: 'discover-1' } },
        })
        await vi.waitFor(() => expect(transport.sent).toHaveLength(2))
        expect(transport.sent.map(value => value.eventType)).toEqual([MATRIX_GATEWAY_EVENT, MATRIX_INVENTORY_EVENT])
        expect(process).not.toHaveBeenCalled()
    })

    it('passes verified encrypted commands through authorization and publishes a stable response', async () => {
        const transport = new FakeTransport()
        const response = completed()
        const process = vi.fn(async () => response)
        const worker = new MatrixGatewayWorker({
            gatewayId: 'gateway-1', controlRoomId: '!control:test', transport,
            processor: { process } as unknown as AuthorizedRequestProcessor,
        })
        await worker.start()
        transport.emit(commandEvent(true, true))
        await vi.waitFor(() => expect(transport.sent).toHaveLength(1))

        expect(process).toHaveBeenCalledTimes(1)
        expect(transport.sent[0]).toMatchObject({
            roomId: '!project:test', eventType: MATRIX_RESPONSE_EVENT,
            transactionId: 'command-1-response',
            content: { gatewayId: 'gateway-1', response },
        })
    })

    it.each([
        ['unencrypted', false, true],
        ['unverified', true, false],
    ])('rejects %s Matrix commands before COSE processing', async (_name, encrypted, verifiedDevice) => {
        const transport = new FakeTransport()
        const process = vi.fn()
        const onError = vi.fn()
        const worker = new MatrixGatewayWorker({
            gatewayId: 'gateway-1', controlRoomId: '!control:test', transport,
            processor: { process } as unknown as AuthorizedRequestProcessor, onError,
        })
        await worker.start()
        transport.emit(commandEvent(encrypted, verifiedDevice))
        await vi.waitFor(() => expect(onError).toHaveBeenCalled())
        expect(process).not.toHaveBeenCalled()
        expect(transport.sent).toHaveLength(0)
    })
})

class FakeTransport implements MatrixTransport {
    readonly sent: MatrixSendInput[] = []
    private listener?: (event: NativeMatrixEvent) => void
    async initialize(): Promise<void> {}
    async send(input: MatrixSendInput): Promise<string> { this.sent.push(input); return '$event' }
    onEvent(listener: (event: NativeMatrixEvent) => void): () => void {
        this.listener = listener
        return () => { this.listener = undefined }
    }
    async close(): Promise<void> {}
    emit(event: NativeMatrixEvent): void { this.listener?.(event) }
}

function commandEvent(encrypted: boolean, verifiedDevice: boolean): NativeMatrixEvent {
    return {
        roomId: '!project:test', encrypted, verifiedDevice, senderDevice: 'PHONE',
        event: {
            type: MATRIX_COMMAND_EVENT,
            content: {
                version: 1, type: 'client.gateway.authorized-request',
                request: {
                    version: 1, type: 'client.gateway.request', requestId: 'request-1',
                    idempotencyKey: 'command-1', payload: { kind: 'inventory.get' },
                },
                authorization: { format: 'cose-sign1-cwt', token: 'token' },
            },
        },
    }
}

function completed(): ClientGatewayResponseFrame {
    return {
        version: 1, type: 'gateway.client.response', requestId: 'request-1', status: 'completed',
        completedAt: '2026-07-19T05:00:00.000Z',
        payload: { generatedAt: '2026-07-19T05:00:00.000Z', revision: 1, projects: [], sessions: [] },
    }
}
