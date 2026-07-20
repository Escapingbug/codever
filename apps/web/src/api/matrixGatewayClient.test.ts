import type { Gateway } from '@codever/protocol'
import { describe, expect, it } from 'vitest'
import { MatrixGatewayClient, type MatrixTransportPort } from './matrixGatewayClient'
import {
  MATRIX_DISCOVERY_EVENT,
  MATRIX_GATEWAY_EVENT,
  type MatrixTransportEvent,
} from './nativeMatrixClient'

class DelayedDiscoveryTransport implements MatrixTransportPort {
  private subscriber?: (event: MatrixTransportEvent) => void
  verified = false

  subscribe(subscriber: (event: MatrixTransportEvent) => void): () => void {
    this.subscriber = subscriber
    return () => { this.subscriber = undefined }
  }

  signExecution(): Promise<string> { return Promise.resolve('token') }

  async send(input: { eventType: string }): Promise<string> {
    if (input.eventType === MATRIX_DISCOVERY_EVENT) {
      const verified = this.verified
      setTimeout(() => this.announce(verified), 150)
    }
    return '$event'
  }

  private announce(verifiedDevice: boolean): void {
    const gateway: Gateway = {
      id: 'gateway-1', workspaceId: 'workspace-1', name: 'Windows Computer',
      platform: 'windows', version: '0.1.0', status: 'online',
      lastSeenAt: '2026-07-20T03:00:00.000Z',
      capabilities: {
        protocolVersions: [1], providers: ['codex'], features: [],
        metadata: { matrixDeviceId: 'GATEWAYDEVICE' },
      },
    }
    this.subscriber?.({
      roomId: '!control:example.test', encrypted: true, verifiedDevice,
      senderDevice: 'GATEWAYDEVICE',
      event: { type: MATRIX_GATEWAY_EVENT, content: { gateway } },
    })
  }
}

describe('MatrixGatewayClient discovery synchronization', () => {
  it('waits for a post-request announcement instead of returning a stale setup candidate', async () => {
    const transport = new DelayedDiscoveryTransport()
    const client = new MatrixGatewayClient({
      transport,
      session: { homeserver: 'https://example.test', userId: '@codever:example.test', deviceId: 'CLIENTDEVICE' },
      controlRoomId: '!control:example.test', executionAccount: 'account', executionKeyId: 'key',
    })

    const candidate = await client.listGateways()
    expect(candidate[0]?.capabilities.metadata?.matrixVerified).toBe(false)

    transport.verified = true
    const verified = await client.listGateways()
    expect(verified[0]?.capabilities.metadata?.matrixVerified).toBe(true)
  })
})
