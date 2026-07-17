import type { ClientGatewayRequestFrame, ClientGatewayResponseFrame } from '@codever/protocol'
import { describe, expect, it, vi } from 'vitest'
import { GatewaySecureConnection, SecureRelayClient } from '../src/api/secureRelayClient'
import { RelayApi } from '../src/api/relayApi'
import { MemorySecretStore } from '../src/security/secretStore'

describe('secure connection send ordering', () => {
  it('serializes Relay encryption together with its socket send', async () => {
    const releaseFirst = controlled<void>()
    const encrypted: number[] = []
    const sent: number[] = []
    const handshake = {
      ready: true,
      encrypt: vi.fn(async (value: { order: number }) => {
        encrypted.push(value.order)
        if (value.order === 1) await releaseFirst.promise
        return { order: value.order }
      }),
    }
    const client = new SecureRelayClient({
      baseUrl: 'http://relay.example',
      handshake: handshake as never,
    })
    const socket = {
      readyState: 1,
      send: (value: string) => sent.push((JSON.parse(value) as { order: number }).order),
    }
    ;(client as unknown as { socket: typeof socket }).socket = socket
    const sendSecure = (client as unknown as { sendSecure: (value: unknown) => Promise<void> }).sendSecure.bind(client)

    const first = sendSecure({ order: 1 })
    const second = sendSecure({ order: 2 })
    await Promise.resolve()
    await Promise.resolve()

    expect(encrypted).toEqual([1])
    expect(sent).toEqual([])
    releaseFirst.resolve(undefined)
    await Promise.all([first, second])
    expect(encrypted).toEqual([1, 2])
    expect(sent).toEqual([1, 2])
  })

  it('serializes Gateway encryption together with outer tunnel send', async () => {
    const releaseFirst = controlled<void>()
    const encrypted: string[] = []
    const sent: string[] = []
    const sentTwice = controlled<void>()
    const handshake = {
      encryptRequest: vi.fn(async (frame: ClientGatewayRequestFrame) => {
        encrypted.push(frame.idempotencyKey)
        if (frame.idempotencyKey === 'key-1') await releaseFirst.promise
        return frame.idempotencyKey
      }),
    }
    const connection = new GatewaySecureConnection(
      'gateway-1',
      handshake as never,
      async frame => {
        if (frame.type !== 'device.tunnel.data') throw new Error('Expected tunnel data')
        sent.push(frame.payload.opaquePayload)
        if (sent.length === 2) sentTwice.resolve(undefined)
      },
    )
    const internals = connection as unknown as {
      tunnelId: string
      connectState: { resolve: (value: void) => void }
    }
    internals.tunnelId = 'tunnel-1'
    internals.connectState.resolve(undefined)

    const first = connection.request({ kind: 'inventory.get' }, 'key-1')
    const second = connection.request({ kind: 'inventory.get' }, 'key-2')
    await Promise.resolve()
    await Promise.resolve()

    expect(encrypted).toEqual(['key-1'])
    expect(sent).toEqual([])
    releaseFirst.resolve(undefined)
    await sentTwice.promise
    expect(encrypted).toEqual(['key-1', 'key-2'])
    expect(sent).toEqual(['key-1', 'key-2'])

    connection.fail(new Error('test complete'))
    await Promise.allSettled([first, second])
  })
})

describe('secure request lifecycle', () => {
  it('unwraps the project returned by project.create', async () => {
    const api = new RelayApi({
      baseUrl: 'http://relay.example',
      relayProfileId: 'relay-profile',
      secrets: new MemorySecretStore(),
    })
    const project = {
      id: 'project-1',
      gatewayId: 'gateway-1',
      name: 'Project',
      rootPath: '/workspace',
      canonicalRoot: '/workspace',
    }
    const internals = api as unknown as {
      requestGateway: () => Promise<ClientGatewayResponseFrame>
    }
    internals.requestGateway = async () => ({
      version: 1,
      type: 'gateway.client.response',
      requestId: 'request-1',
      status: 'completed',
      completedAt: new Date().toISOString(),
      payload: { project },
    })

    await expect(api.createProject('gateway-1', {
      name: 'Project',
      rootPath: '/workspace',
    })).resolves.toEqual(project)
  })

  it('times out and removes an unanswered Gateway request', async () => {
    vi.useFakeTimers()
    try {
      const connection = new GatewaySecureConnection(
        'gateway-1',
        { encryptRequest: async () => 'encrypted' } as never,
        async () => undefined,
        undefined,
        25,
      )
      const internals = connection as unknown as {
        tunnelId: string
        connectState: { resolve: (value: void) => void }
        requests: Map<string, unknown>
      }
      internals.tunnelId = 'tunnel-1'
      internals.connectState.resolve(undefined)

      const request = connection.request({ kind: 'inventory.get' }, 'stable-key')
      const rejection = expect(request).rejects.toThrow('Gateway request timed out')
      await vi.advanceTimersByTimeAsync(26)

      await rejection
      expect(internals.requests.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('recreates a connection once for retry-safe plaintext and preserves its idempotency key', async () => {
    const api = new RelayApi({
      baseUrl: 'http://relay.example',
      relayProfileId: 'relay-profile',
      secrets: new MemorySecretStore(),
    })
    const requests: Array<{ connection: number; key: string }> = []
    let connection = 0
    const internals = api as unknown as {
      gateway: () => Promise<{ request: (payload: unknown, key: string) => Promise<ClientGatewayResponseFrame> }>
      requestGateway: (gatewayId: string, payload: { kind: 'inventory.get' }) => Promise<ClientGatewayResponseFrame>
    }
    internals.gateway = async () => {
      const current = ++connection
      return {
        request: async (_payload, key) => {
          requests.push({ connection: current, key })
          if (current === 1) throw new Error('connection lost')
          return completedResponse()
        },
      }
    }

    await internals.requestGateway('gateway-1', { kind: 'inventory.get' })

    expect(requests).toHaveLength(2)
    expect(requests[0]?.connection).toBe(1)
    expect(requests[1]?.connection).toBe(2)
    expect(requests[1]?.key).toBe(requests[0]?.key)
  })

  it('does not retry plaintext that is not explicitly retry-safe', async () => {
    const api = new RelayApi({
      baseUrl: 'http://relay.example',
      relayProfileId: 'relay-profile',
      secrets: new MemorySecretStore(),
    })
    const request = vi.fn(async () => { throw new Error('connection lost') })
    const internals = api as unknown as {
      gateway: () => Promise<{ request: typeof request }>
      requestGateway: (gatewayId: string, payload: { kind: 'project.create'; input: { name: string; rootPath: string } }) => Promise<ClientGatewayResponseFrame>
    }
    internals.gateway = async () => ({ request })

    await expect(internals.requestGateway(
      'gateway-1', { kind: 'project.create', input: { name: 'Project', rootPath: '/workspace' } },
    )).rejects.toThrow('connection lost')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('retries a mutation only when the Gateway advertises durable idempotency', async () => {
    const api = new RelayApi({
      baseUrl: 'http://relay.example',
      relayProfileId: 'relay-profile',
      secrets: new MemorySecretStore(),
    })
    const keys: string[] = []
    let attempts = 0
    const internals = api as unknown as {
      gateway: () => Promise<{ request: (payload: unknown, key: string) => Promise<ClientGatewayResponseFrame> }>
      requestGateway: (gatewayId: string, payload: { kind: 'project.create'; input: { name: string; rootPath: string } }) => Promise<ClientGatewayResponseFrame>
      durableIdempotencyGateways: Set<string>
    }
    internals.durableIdempotencyGateways.add('gateway-1')
    internals.gateway = async () => ({
      request: async (_payload, key) => {
        keys.push(key)
        attempts += 1
        if (attempts === 1) throw new Error('connection lost')
        return completedResponse()
      },
    })

    await internals.requestGateway(
      'gateway-1', { kind: 'project.create', input: { name: 'Project', rootPath: '/workspace' } },
    )
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(keys[0])
  })
})

function completedResponse(): ClientGatewayResponseFrame {
  return {
    version: 1,
    type: 'gateway.client.response',
    requestId: 'request-1',
    status: 'completed',
    completedAt: new Date().toISOString(),
    payload: { generatedAt: new Date().toISOString(), revision: 1, projects: [], sessions: [] },
  }
}

function controlled<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
