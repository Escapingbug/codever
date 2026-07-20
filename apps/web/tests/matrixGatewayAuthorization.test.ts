import type { Gateway } from '@codever/protocol'
import { describe, expect, it } from 'vitest'
import { MatrixGatewayClient, type MatrixTransportPort } from '../src/api/matrixGatewayClient'
import {
  MATRIX_AUTHORIZATION_EVENT, MATRIX_COMMAND_EVENT, MATRIX_DISCOVERY_EVENT,
  MATRIX_GATEWAY_EVENT, MATRIX_RESPONSE_EVENT, type MatrixTransportEvent,
} from '../src/api/nativeMatrixClient'

class ApprovalTransport implements MatrixTransportPort {
  private subscriber?: (event: MatrixTransportEvent) => void
  readonly sent: Array<{ eventType: string; content: unknown }> = []

  subscribe(subscriber: (event: MatrixTransportEvent) => void): () => void {
    this.subscriber = subscriber
    return () => { this.subscriber = undefined }
  }

  signExecution(): Promise<string> { return Promise.resolve('old-client-token') }

  async send(input: { eventType: string; content: unknown }): Promise<string> {
    this.sent.push(input)
    if (input.eventType === MATRIX_DISCOVERY_EVENT) {
      const requestId = (input.content as { requestId: string }).requestId
      setTimeout(() => this.announce(requestId), 0)
    } else if (input.eventType === MATRIX_COMMAND_EVENT) {
      const request = (input.content as { request: { requestId: string } }).request
      queueMicrotask(() => this.emit({
        roomId: '!control:test', encrypted: true, verifiedDevice: true, senderDevice: 'GATEWAYDEVICE',
        event: { type: MATRIX_RESPONSE_EVENT, content: {
          gatewayId: 'gateway-1', response: {
            version: 1, type: 'gateway.client.response', requestId: request.requestId,
            status: 'completed', completedAt: '2026-07-20T03:00:00.000Z',
            payload: {
              commandId: 'approval', status: 'completed',
              acceptedAt: '2026-07-20T03:00:00.000Z', completedAt: '2026-07-20T03:00:00.000Z',
            },
          },
        } },
      }))
    }
    return '$event'
  }

  emit(event: MatrixTransportEvent): void { this.subscriber?.(event) }

  private announce(discoveryRequestId: string): void {
    const gateway: Gateway = {
      id: 'gateway-1', workspaceId: 'workspace-1', name: 'Computer', platform: 'windows',
      version: '0.1.0', status: 'online', lastSeenAt: '2026-07-20T03:00:00.000Z',
      capabilities: { protocolVersions: [1], providers: [], features: ['client-mediated-device-trust'],
        metadata: { matrixDeviceId: 'GATEWAYDEVICE' } },
    }
    this.emit({
      roomId: '!control:test', encrypted: true, verifiedDevice: true, senderDevice: 'GATEWAYDEVICE',
      event: { type: MATRIX_GATEWAY_EVENT, content: {
        gateway, recipientDeviceId: 'OLDCLIENT', clientDeviceVerified: true,
        matrixControlCompatible: true, matrixControl: { minVersion: 2, maxVersion: 2 }, discoveryRequestId,
      } },
    })
  }
}

describe('delegated client authorization', () => {
  it('binds the approved execution root to the SAS-verified Matrix device', async () => {
    const transport = new ApprovalTransport()
    const client = new MatrixGatewayClient({
      transport,
      session: { homeserver: 'https://matrix.test', userId: '@codever:test', deviceId: 'OLDCLIENT' },
      controlRoomId: '!control:test', executionAccount: 'old-account', executionKeyId: 'old-key',
    })
    await client.listGateways()
    let approvals: Parameters<typeof client.approveExecutionRoot>[0][] = []
    client.subscribeExecutionApprovals(value => { approvals = value })
    transport.emit({
      roomId: '!control:test', encrypted: true, verifiedDevice: true, senderDevice: 'NEWCLIENT',
      event: { type: MATRIX_AUTHORIZATION_EVENT, content: {
        version: 1, type: 'execution.root.request', requestId: 'approval-1', gatewayId: 'gateway-1',
        ownerId: 'NEWCLIENT', label: 'New phone',
        publicKey: { kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', kid: 'new-key', x: 'x', y: 'y' },
      } },
    })

    await client.approveExecutionRoot(approvals[0])

    expect(transport.sent.find(item => item.eventType === MATRIX_COMMAND_EVENT)?.content).toMatchObject({
      request: { payload: { kind: 'execution.root.trust', ownerId: 'NEWCLIENT', matrixDeviceId: 'NEWCLIENT' } },
    })
  })

  it('rejects an approval request whose owner differs from the verified sender', async () => {
    const transport = new ApprovalTransport()
    const securityErrors: string[] = []
    const client = new MatrixGatewayClient({
      transport,
      session: { homeserver: 'https://matrix.test', userId: '@codever:test', deviceId: 'OLDCLIENT' },
      controlRoomId: '!control:test', executionAccount: 'old-account', executionKeyId: 'old-key',
      onSecurityError: message => securityErrors.push(message),
    })
    const snapshots: Parameters<typeof client.approveExecutionRoot>[0][][] = []
    client.start()
    client.subscribeExecutionApprovals(value => snapshots.push(value))
    transport.emit({
      roomId: '!control:test', encrypted: true, verifiedDevice: true, senderDevice: 'NEWCLIENT',
      event: { type: MATRIX_AUTHORIZATION_EVENT, content: {
        version: 1, type: 'execution.root.request', requestId: 'approval-evil', gatewayId: 'gateway-1',
        ownerId: 'OTHERCLIENT', label: 'Wrong owner',
        publicKey: { kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', kid: 'evil-key', x: 'x', y: 'y' },
      } },
    })

    expect(snapshots.at(-1)).toEqual([])
    expect(securityErrors.at(-1)).toContain('owner must match')
  })
})
