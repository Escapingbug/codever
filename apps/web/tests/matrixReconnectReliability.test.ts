import type { Gateway } from '@codever/protocol'
import { describe, expect, it, vi } from 'vitest'
import { CodeverApi } from '../src/api/codeverApi'
import {
  MATRIX_DISCOVERY_EVENT, MATRIX_GATEWAY_EVENT, type MatrixTransportEvent,
} from '../src/api/nativeMatrixClient'

describe('Matrix reconnect reliability', () => {
  it('keeps the last verified computer available while rediscovery is offline', async () => {
    vi.useFakeTimers()
    try {
      const native = new DiscoveryNative()
      const api = new CodeverApi(native as never)
      const connection = {
        session: { homeserver: 'https://matrix.test', userId: '@user:matrix.test', deviceId: 'PHONE' },
        controlRoomId: '!control:matrix.test', executionAccount: 'execution-primary', executionKeyId: 'key-1',
      }
      api.connect(connection)
      const firstDiscovery = api.listGateways()
      await vi.advanceTimersByTimeAsync(200)
      expect(await firstDiscovery).toEqual([expect.objectContaining({ id: 'gateway-1' })])

      native.respondToDiscovery = false
      api.connect(connection)
      const offlineDiscovery = api.listGateways()
      await vi.advanceTimersByTimeAsync(8_100)

      expect(await offlineDiscovery).toEqual([expect.objectContaining({ id: 'gateway-1' })])
    } finally {
      vi.useRealTimers()
    }
  })
})

class DiscoveryNative {
  respondToDiscovery = true
  private subscriber?: (event: MatrixTransportEvent) => void

  subscribe(subscriber: (event: MatrixTransportEvent) => void): () => void {
    this.subscriber = subscriber
    return () => { this.subscriber = undefined }
  }
  signExecution(): Promise<string> { return Promise.resolve('token') }
  close(): Promise<void> { return Promise.resolve() }
  async send(input: { eventType: string; content: unknown }): Promise<string> {
    if (input.eventType === MATRIX_DISCOVERY_EVENT && this.respondToDiscovery) {
      const requestId = (input.content as { requestId: string }).requestId
      setTimeout(() => this.announce(requestId), 100)
    }
    return '$event'
  }
  private announce(discoveryRequestId: string): void {
    const gateway: Gateway = {
      id: 'gateway-1', workspaceId: 'default', name: 'Windows Computer', platform: 'windows',
      version: '0.1.0', status: 'online', lastSeenAt: '2026-07-20T09:00:00.000Z',
      capabilities: {
        protocolVersions: [1], providers: ['codex'], features: [],
        metadata: { matrixDeviceId: 'GATEWAY' },
      },
    }
    this.subscriber?.({
      roomId: '!control:matrix.test', encrypted: true, verifiedDevice: true, senderDevice: 'GATEWAY',
      event: { type: MATRIX_GATEWAY_EVENT, content: {
        gateway, recipientDeviceId: 'PHONE', clientDeviceVerified: true,
        matrixControlCompatible: true, matrixControl: { minVersion: 2, maxVersion: 2 }, discoveryRequestId,
      } },
    })
  }
}
