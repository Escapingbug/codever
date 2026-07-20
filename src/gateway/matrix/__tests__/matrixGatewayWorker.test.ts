import type { ClientGatewayResponseFrame } from '@codever/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { AuthorizedRequestProcessor } from '../../authorizedRequestProcessor'
import {
    MatrixGatewayWorker, MATRIX_AUTHORIZATION_EVENT, MATRIX_COMMAND_EVENT, MATRIX_DISCOVERY_EVENT,
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
            event: { type: MATRIX_DISCOVERY_EVENT, content: discoveryContent() },
        })
        await vi.waitFor(() => expect(transport.sent).toHaveLength(2))
        expect(transport.sent.map(value => value.eventType)).toEqual([MATRIX_GATEWAY_EVENT, MATRIX_INVENTORY_EVENT])
        expect(transport.sent[0].content).toMatchObject({
            recipientDeviceId: 'PHONE', clientDeviceVerified: true, discoveryRequestId: 'discover-1',
        })
        expect(process).not.toHaveBeenCalled()
    })

    it('reveals only Gateway identity to encrypted unverified discovery', async () => {
        const transport = new FakeTransport()
        const worker = new MatrixGatewayWorker({
            gatewayId: 'gateway-1', controlRoomId: '!control:test', transport,
            processor: { process: vi.fn() } as unknown as AuthorizedRequestProcessor,
            currentGateway: () => ({
                id: 'gateway-1', workspaceId: 'default', name: 'Computer', platform: 'windows',
                version: '0.1.0', status: 'online', capabilities: { protocolVersions: [1], providers: ['codex'], features: [] },
            }),
            currentInventory: async () => ({ generatedAt: '2026-07-19T05:00:00.000Z', revision: 4, projects: [], sessions: [] }),
        })
        await worker.start()
        transport.emit({
            roomId: '!control:test', encrypted: true, verifiedDevice: false, senderDevice: 'PHONE',
            event: { type: MATRIX_DISCOVERY_EVENT, content: discoveryContent() },
        })
        await vi.waitFor(() => expect(transport.sent).toHaveLength(1))
        expect(transport.sent[0].eventType).toBe(MATRIX_GATEWAY_EVENT)
        expect(transport.sent[0].content).toMatchObject({ gateway: { capabilities: { providers: [], features: [] } } })
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
        negotiate(transport)
        transport.emit(commandEvent(true, true))
        await vi.waitFor(() => expect(transport.sent).toHaveLength(1))

        expect(process).toHaveBeenCalledTimes(1)
        expect(transport.sent[0]).toMatchObject({
            roomId: '!project:test', eventType: MATRIX_RESPONSE_EVENT,
            transactionId: 'command-1-response',
            content: { gatewayId: 'gateway-1', response },
        })
    })

    it('binds an execution root only to the verified Matrix sender device', async () => {
        const transport = new FakeTransport()
        const trustVerifiedDeviceRoot = vi.fn(async () => undefined)
        const worker = new MatrixGatewayWorker({
            gatewayId: 'gateway-1', controlRoomId: '!control:test', transport,
            processor: { process: vi.fn() } as unknown as AuthorizedRequestProcessor,
            trustVerifiedDeviceRoot,
        })
        await worker.start()
        negotiate(transport)
        transport.emit(authorizationEvent('PHONE', 'PHONE'))
        await vi.waitFor(() => expect(trustVerifiedDeviceRoot).toHaveBeenCalledTimes(1))
        expect(trustVerifiedDeviceRoot).toHaveBeenCalledWith('PHONE', expect.objectContaining({ kid: 'client-key' }), 'Codever PHONE')
    })

    it('rejects execution roots that claim a different owner than the verified Matrix device', async () => {
        const transport = new FakeTransport()
        const trustVerifiedDeviceRoot = vi.fn(async () => undefined)
        const onError = vi.fn()
        const worker = new MatrixGatewayWorker({
            gatewayId: 'gateway-1', controlRoomId: '!control:test', transport,
            processor: { process: vi.fn() } as unknown as AuthorizedRequestProcessor,
            trustVerifiedDeviceRoot, onError,
        })
        await worker.start()
        negotiate(transport)
        transport.emit(authorizationEvent('PHONE', 'ATTACKER'))
        await vi.waitFor(() => expect(onError).toHaveBeenCalled())
        expect(trustVerifiedDeviceRoot).not.toHaveBeenCalled()
    })

    it('rejects unencrypted Matrix commands before COSE processing', async () => {
        const transport = new FakeTransport()
        const process = vi.fn()
        const onError = vi.fn()
        const worker = new MatrixGatewayWorker({
            gatewayId: 'gateway-1', controlRoomId: '!control:test', transport,
            processor: { process } as unknown as AuthorizedRequestProcessor, onError,
        })
        await worker.start()
        transport.emit(commandEvent(false, true))
        await vi.waitFor(() => expect(onError).toHaveBeenCalled())
        expect(process).not.toHaveBeenCalled()
        expect(transport.sent).toHaveLength(0)
    })

    it('answers an encrypted unverified command with an immediate setup failure', async () => {
        const transport = new FakeTransport()
        const process = vi.fn()
        const worker = new MatrixGatewayWorker({
            gatewayId: 'gateway-1', controlRoomId: '!control:test', transport,
            processor: { process } as unknown as AuthorizedRequestProcessor,
        })
        await worker.start()
        transport.emit(commandEvent(true, false))
        await vi.waitFor(() => expect(transport.sent).toHaveLength(1))
        expect(process).not.toHaveBeenCalled()
        expect(transport.sent[0]).toMatchObject({
            eventType: MATRIX_RESPONSE_EVENT,
            content: { response: {
                requestId: 'request-1', status: 'failed',
                error: { code: 'matrix_device_verification_required', retryable: false },
            } },
        })
    })

    it('rejects a verified legacy client that did not negotiate a compatible control version', async () => {
        const transport = new FakeTransport()
        const process = vi.fn()
        const worker = new MatrixGatewayWorker({
            gatewayId: 'gateway-1', controlRoomId: '!control:test', transport,
            processor: { process } as unknown as AuthorizedRequestProcessor,
        })
        await worker.start()
        negotiate(transport, false)
        transport.emit(commandEvent(true, true))
        await vi.waitFor(() => expect(transport.sent).toHaveLength(1))
        expect(process).not.toHaveBeenCalled()
        expect(transport.sent[0].content).toMatchObject({ response: {
            status: 'failed', error: { code: 'matrix_control_protocol_unsupported', retryable: false },
        } })
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

function discoveryContent(compatible = true) {
    return {
        version: 1,
        requestId: 'discover-1',
        ...(compatible ? { matrixControl: { minVersion: 2, maxVersion: 2 } } : {}),
    }
}

function negotiate(transport: FakeTransport, compatible = true): void {
    transport.emit({
        roomId: '!control:test', encrypted: true, verifiedDevice: true, senderDevice: 'PHONE',
        event: { type: MATRIX_DISCOVERY_EVENT, content: discoveryContent(compatible) },
    })
}

function authorizationEvent(senderDevice: string, ownerId: string): NativeMatrixEvent {
    return {
        roomId: '!control:test', encrypted: true, verifiedDevice: true, senderDevice,
        event: {
            type: MATRIX_AUTHORIZATION_EVENT,
            content: {
                version: 1, type: 'execution.root.request', requestId: 'approval-1', gatewayId: 'gateway-1',
                ownerId, label: `Codever ${ownerId}`,
                publicKey: {
                    kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', kid: 'client-key', x: 'x', y: 'y',
                },
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
