import { describe, expect, it, vi } from 'vitest'
import { MatrixGatewayClient, type MatrixTransportPort } from '../src/api/matrixGatewayClient'
import type { MatrixTransportEvent, SignExecutionInput } from '../src/api/nativeMatrixClient'

class FakeTransport implements MatrixTransportPort {
  listeners = new Set<(event: MatrixTransportEvent) => void>()
  sends: Array<{ roomId: string; eventType: string; transactionId: string; content: unknown }> = []
  signs: SignExecutionInput[] = []
  onSend?: (input: FakeTransport['sends'][number]) => void

  async send(input: FakeTransport['sends'][number]): Promise<string> {
    this.sends.push(input)
    this.onSend?.(input)
    return '$event'
  }
  async signExecution(_account: string, input: SignExecutionInput): Promise<string> {
    this.signs.push(input)
    return 'signed-cose-token'
  }
  subscribe(listener: (event: MatrixTransportEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  emit(type: string, content: unknown, security = { encrypted: true, verifiedDevice: true }): void {
    for (const listener of this.listeners) listener({
      roomId: '!control:test', event: { type, content }, ...security,
    })
  }
  emitRaw(value: unknown): void {
    for (const listener of this.listeners) listener(value as MatrixTransportEvent)
  }
}

function client(transport: FakeTransport, onSecurityError = vi.fn()) {
  return {
    value: new MatrixGatewayClient({
      transport,
      session: { homeserver: 'https://test', userId: '@owner:test', deviceId: 'PHONE' },
      controlRoomId: '!control:test',
      executionAccount: 'execution-root',
      executionKeyId: 'root-key-id',
      timeoutMs: 20,
      onSecurityError,
    }),
    onSecurityError,
  }
}

describe('MatrixGatewayClient', () => {
  it('does not crash when the native transport reports sync or session status', () => {
    const transport = new FakeTransport()
    const { value, onSecurityError } = client(transport)
    value.start()

    expect(() => transport.emitRaw({ kind: 'sync_error', message: 'temporary outage' })).not.toThrow()
    expect(() => transport.emitRaw({ kind: 'session_error', message: 'token refresh failed' })).not.toThrow()
    expect(() => transport.emitRaw(undefined)).not.toThrow()
    expect(onSecurityError).toHaveBeenCalledWith(expect.stringContaining('native Matrix payload'))
  })

  it('shares a public execution key only through verified encrypted approval events', async () => {
    const transport = new FakeTransport()
    const { value, onSecurityError } = client(transport)
    const approvals: Array<Array<{ requestId: string }>> = []
    value.start()
    value.subscribeExecutionApprovals(requests => approvals.push(requests))
    const content = {
      version: 1, type: 'execution.root.request', requestId: 'approval-1', gatewayId: 'gateway-1',
      ownerId: 'TABLET', label: 'Tablet',
      publicKey: { kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', kid: 'tablet-key', x: 'x', y: 'y' },
    }
    transport.emit('io.codever.authorization.v1', content, { encrypted: true, verifiedDevice: false })
    expect(approvals.at(-1)).toEqual([])
    transport.emit('io.codever.authorization.v1', content)
    expect(approvals.at(-1)).toMatchObject([{ requestId: 'approval-1' }])
    expect(onSecurityError).toHaveBeenCalledWith(expect.stringContaining('unverified'))

    await value.requestExecutionApproval({
      gatewayId: 'gateway-1', ownerId: 'PHONE-2', label: 'Phone 2',
      publicKey: { kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', kid: 'phone-2', x: 'x', y: 'y' },
    })
    expect(transport.sends.at(-1)).toMatchObject({
      eventType: 'io.codever.authorization.v1',
      content: { type: 'execution.root.request', gatewayId: 'gateway-1' },
    })
  })

  it('authorizes a later client with an existing COSE root', async () => {
    const transport = new FakeTransport()
    const { value } = client(transport)
    value.start()
    const request = {
      requestId: 'approval-2', gatewayId: 'gateway-1', ownerId: 'PHONE-2', label: 'Phone 2',
      publicKey: { kty: 'EC' as const, crv: 'P-256' as const, alg: 'ES256' as const, use: 'sig' as const, kid: 'phone-2', x: 'x', y: 'y' },
    }
    transport.emit('io.codever.authorization.v1', { version: 1, type: 'execution.root.request', ...request })
    transport.onSend = sent => {
      if (sent.eventType !== 'io.codever.command.v1') return
      const requestId = (sent.content as { request: { requestId: string } }).request.requestId
      transport.emit('io.codever.response.v1', { response: {
        version: 1, type: 'gateway.client.response', requestId, status: 'completed',
        completedAt: new Date().toISOString(),
        payload: { commandId: 'trust-root', status: 'completed', completedAt: new Date().toISOString() },
      } })
    }

    await expect(value.approveExecutionRoot(request)).resolves.toMatchObject({ status: 'completed' })
    expect(transport.signs.at(-1)).toMatchObject({ operation: 'execution.root.trust' })
  })

  it('actively discovers Gateways instead of depending on a presence heartbeat race', async () => {
    const transport = new FakeTransport()
    const { value } = client(transport)
    transport.onSend = sent => {
      if (sent.eventType !== 'io.codever.discovery.v1') return
      transport.emit('io.codever.gateway.v1', { gateway: {
        id: 'gateway-1', workspaceId: 'default', name: 'Windows Computer', platform: 'windows',
        version: '0.1.0', status: 'online', lastSeenAt: new Date().toISOString(),
        capabilities: { protocolVersions: [1], providers: ['codex'], features: [], metadata: { matrixDeviceId: 'GATEWAY' } },
      } })
    }

    await expect(value.listGateways()).resolves.toMatchObject([{ id: 'gateway-1' }])
    expect(transport.sends[0]).toMatchObject({ eventType: 'io.codever.discovery.v1' })
  })

  it('binds a COSE token to the exact request and correlates the encrypted response', async () => {
    const transport = new FakeTransport()
    const { value } = client(transport)
    transport.onSend = sent => {
      const authorized = sent.content as { request: { requestId: string } }
      transport.emit('io.codever.response.v1', {
        gatewayId: 'gateway-1',
        response: {
          version: 1,
          type: 'gateway.client.response',
          requestId: authorized.request.requestId,
          status: 'completed',
          completedAt: new Date().toISOString(),
          payload: { generatedAt: new Date().toISOString(), revision: 1, projects: [], sessions: [] },
        },
      })
    }
    const response = await value.request('gateway-1', { kind: 'inventory.get' })
    expect(response.status).toBe('completed')
    expect(transport.signs[0]).toMatchObject({ gatewayId: 'gateway-1', operation: 'inventory.get', subject: 'PHONE' })
    expect(transport.sends[0].content).toMatchObject({
      type: 'client.gateway.authorized-request',
      authorization: { format: 'cose-sign1-cwt', token: 'signed-cose-token' },
    })
  })

  it('rejects a response from an unverified Matrix device', async () => {
    const transport = new FakeTransport()
    const { value, onSecurityError } = client(transport)
    transport.onSend = sent => {
      const requestId = (sent.content as { request: { requestId: string } }).request.requestId
      transport.emit('io.codever.response.v1', { response: {
        version: 1, type: 'gateway.client.response', requestId, status: 'failed',
        failedAt: new Date().toISOString(), error: { code: 'forged', message: 'forged', retryable: false },
      } }, { encrypted: true, verifiedDevice: false })
    }
    await expect(value.request('gateway-1', { kind: 'inventory.get' })).rejects.toThrow('timed out')
    expect(onSecurityError).toHaveBeenCalledWith(expect.stringContaining('unverified'))
  })

  it('does not regress inventory when Matrix redelivers older history', () => {
    const transport = new FakeTransport()
    const { value } = client(transport)
    value.start()
    const snapshot = (revision: number) => ({
      gatewayId: 'gateway-1',
      inventory: { generatedAt: new Date().toISOString(), revision, projects: [], sessions: [] },
    })
    transport.emit('io.codever.inventory.v1', snapshot(7))
    transport.emit('io.codever.inventory.v1', snapshot(3))
    expect(value.inventory('gateway-1')?.revision).toBe(7)
  })
})
