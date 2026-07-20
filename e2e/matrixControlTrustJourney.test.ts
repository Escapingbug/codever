import type { Gateway } from '@codever/protocol'
import { describe, expect, it, vi } from 'vitest'
import { MatrixGatewayClient } from '../apps/web/src/api/matrixGatewayClient'
import type { AuthorizedRequestProcessor } from '../src/gateway/authorizedRequestProcessor'
import { MatrixGatewayWorker } from '../src/gateway/matrix/matrixGatewayWorker'
import { completedInventory, MatrixControlHarness } from './support/matrixControlHarness'

const gateway: Gateway = {
    id: 'gateway-e2e',
    workspaceId: 'default',
    name: 'Windows Computer',
    platform: 'windows',
    version: 'e2e',
    status: 'online',
    lastSeenAt: '2026-07-20T08:00:00.000Z',
    capabilities: {
        protocolVersions: [1],
        providers: ['codex'],
        features: [],
        metadata: { matrixDeviceId: 'GATEWAY-RETAINED' },
    },
}

describe('C02 Matrix control trust and delivery lifecycle', () => {
    it.each([
        { clientTrustsGateway: false, gatewayTrustsClient: false, bilateral: false },
        { clientTrustsGateway: true, gatewayTrustsClient: false, bilateral: false },
        { clientTrustsGateway: false, gatewayTrustsClient: true, bilateral: false },
        { clientTrustsGateway: true, gatewayTrustsClient: true, bilateral: true },
    ])('keeps directional trust independent: $clientTrustsGateway/$gatewayTrustsClient', async ({ bilateral, ...trust }) => {
        const fixture = createFixture(trust)
        const discovered = await fixture.client.listGateways()

        expect(discovered).toHaveLength(1)
        expect(discovered[0]?.capabilities.metadata).toMatchObject({
            matrixVerified: bilateral,
            gatewayDeviceVerified: trust.clientTrustsGateway,
            clientDeviceVerified: trust.gatewayTrustsClient,
        })
        expect(fixture.process).not.toHaveBeenCalled()
        await fixture.close()
    })

    it('blocks an untrusted client command locally after discovery', async () => {
        const fixture = createFixture({ clientTrustsGateway: true, gatewayTrustsClient: false })
        await fixture.client.listGateways()

        await expect(fixture.client.request('gateway-e2e', { kind: 'inventory.get' }))
            .rejects.toThrow('not verified by the Gateway')
        expect(fixture.process).not.toHaveBeenCalled()
        expect(fixture.harness.traffic.filter(event => event.eventType === 'io.codever.command.v1')).toHaveLength(0)
        await fixture.close()
    })

    it('survives delayed duplicate Matrix delivery once trust is bilateral', async () => {
        const fixture = createFixture({ clientTrustsGateway: true, gatewayTrustsClient: true })
        await fixture.client.listGateways()
        fixture.harness.gatewayToClient = { delayMs: 10, duplicate: true }

        await expect(fixture.client.request('gateway-e2e', { kind: 'inventory.get' }))
            .resolves.toMatchObject({ status: 'completed' })
        expect(fixture.process).toHaveBeenCalledTimes(1)
        await fixture.close()
    })

    it('recovers on a fresh request after Matrix drops a command before Gateway delivery', async () => {
        const fixture = createFixture({ clientTrustsGateway: true, gatewayTrustsClient: true })
        await fixture.client.listGateways()
        fixture.harness.clientToGateway = { drop: true }

        await expect(fixture.client.request('gateway-e2e', { kind: 'inventory.get' }))
            .rejects.toThrow('Gateway response timed out')
        expect(fixture.process).not.toHaveBeenCalled()

        fixture.harness.clientToGateway = {}
        await expect(fixture.client.request('gateway-e2e', { kind: 'inventory.get' }))
            .resolves.toMatchObject({ status: 'completed' })
        expect(fixture.process).toHaveBeenCalledTimes(1)
        await fixture.close()
    })
})

function createFixture(trust: { clientTrustsGateway: boolean; gatewayTrustsClient: boolean }) {
    const harness = new MatrixControlHarness(trust)
    const process = vi.fn(async (content: unknown) => {
        const requestId = (content as { request: { requestId: string } }).request.requestId
        return completedInventory(requestId)
    })
    const worker = new MatrixGatewayWorker({
        gatewayId: gateway.id,
        controlRoomId: '!control:e2e',
        transport: harness.gateway,
        processor: { process } as unknown as AuthorizedRequestProcessor,
        currentGateway: () => gateway,
    })
    void worker.start()
    const client = new MatrixGatewayClient({
        transport: harness.client,
        session: {
            homeserver: 'https://matrix.e2e',
            userId: '@codever:matrix.e2e',
            deviceId: harness.clientDeviceId,
        },
        controlRoomId: '!control:e2e',
        executionAccount: 'e2e-account',
        executionKeyId: 'e2e-key',
        timeoutMs: 100,
    })
    client.start()
    return {
        harness,
        worker,
        client,
        process,
        close: async () => { client.close(); await worker.stop() },
    }
}
