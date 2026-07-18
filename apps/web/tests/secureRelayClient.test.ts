import type { ClientGatewayResponseFrame } from '@codever/protocol'
import { describe, expect, it, vi } from 'vitest'
import { SecureRelayClient } from '../src/api/secureRelayClient'
import { RelayApi } from '../src/api/relayApi'
import { MemorySecretStore } from '../src/security/secretStore'

describe('secure connection send ordering', () => {
  it('uses a browser-valid private close code when the secure session fails', () => {
    const client = new SecureRelayClient({
      baseUrl: 'http://relay.example',
      handshake: {} as never,
    })
    const close = vi.fn()
    ;(client as unknown as { socket: { readyState: number; close: typeof close } }).socket = { readyState: 1, close }

    ;(client as unknown as { fail: (error: Error) => void }).fail(new Error('handshake failed'))

    expect(close).toHaveBeenCalledWith(4001, 'Secure session failed')
  })


})

describe('secure request lifecycle', () => {
  it('recovers an attached native task after an idempotency-in-doubt response', async () => {
    const api = new RelayApi({
      baseUrl: 'http://relay.example',
      relayProfileId: 'relay-profile',
      secrets: new MemorySecretStore(),
    })
    const nativeSession = {
      id: 'bridge-1', gatewayId: 'gateway-1', projectId: 'project-1', state: 'idle' as const,
      provider: 'codex', providerSessionId: 'native-1', config: {}, createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), lastEventSeq: 0,
    }
    const internals = api as unknown as {
      projectGateways: Map<string, string>
      requestGateway: (_gatewayId: string, payload: { kind: string }) => Promise<ClientGatewayResponseFrame>
    }
    internals.projectGateways.set('project-1', 'gateway-1')
    internals.requestGateway = async (_gatewayId, payload) => payload.kind === 'session.create'
      ? {
          version: 1, type: 'gateway.client.response', requestId: 'create', status: 'failed',
          failedAt: new Date().toISOString(),
          error: { code: 'idempotency_in_doubt', message: 'uncertain', retryable: false },
        }
      : {
          version: 1, type: 'gateway.client.response', requestId: 'inventory', status: 'completed',
          completedAt: new Date().toISOString(),
          payload: { generatedAt: new Date().toISOString(), revision: 1, projects: [], sessions: [nativeSession] },
        }

    await expect(api.createSession('project-1', {
      provider: 'codex', providerSessionId: 'native-1', config: {},
    })).resolves.toEqual(nativeSession)
  })

  it('sends archive as organization metadata instead of closing the provider session', async () => {
    const api = new RelayApi({
      baseUrl: 'http://relay.example', relayProfileId: 'relay-profile', secrets: new MemorySecretStore(),
    })
    const requestGateway = vi.fn(async () => ({
      version: 1, type: 'gateway.client.response', requestId: 'archive', status: 'completed',
      completedAt: new Date().toISOString(),
      payload: { commandId: 'archive', status: 'completed', completedAt: new Date().toISOString() },
    } satisfies ClientGatewayResponseFrame))
    const internals = api as unknown as {
      sessionGateways: Map<string, string>
      requestGateway: typeof requestGateway
    }
    internals.sessionGateways.set('bridge-1', 'gateway-1')
    internals.requestGateway = requestGateway

    await api.setSessionArchived('bridge-1', true)

    expect(requestGateway).toHaveBeenCalledWith('gateway-1', {
      kind: 'session.archive.set', sessionId: 'bridge-1', archived: true,
    })
  })

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

  it('re-publishes a retry-safe durable command with the same idempotency key', async () => {
    const api = new RelayApi({
      baseUrl: 'http://relay.example',
      relayProfileId: 'relay-profile',
      secrets: new MemorySecretStore(),
    })
    const requests: string[] = []
    let attempts = 0
    const internals = api as unknown as {
      durable: { request: (gatewayId: string, payload: unknown, key: string) => Promise<ClientGatewayResponseFrame> }
      requestGateway: (gatewayId: string, payload: { kind: 'inventory.get' }) => Promise<ClientGatewayResponseFrame>
    }
    internals.durable = {
      request: async (_gatewayId, _payload, key) => {
        requests.push(key)
        attempts += 1
        if (attempts === 1) throw new Error('publish acknowledgement lost')
        return completedResponse()
      },
    }

    await internals.requestGateway('gateway-1', { kind: 'inventory.get' })

    expect(requests).toHaveLength(2)
    expect(requests[1]).toBe(requests[0])
  })

  it('does not retry plaintext that is not explicitly retry-safe', async () => {
    const api = new RelayApi({
      baseUrl: 'http://relay.example',
      relayProfileId: 'relay-profile',
      secrets: new MemorySecretStore(),
    })
    const request = vi.fn(async () => { throw new Error('connection lost') })
    const internals = api as unknown as {
      durable: { request: typeof request }
      requestGateway: (gatewayId: string, payload: { kind: 'project.create'; input: { name: string; rootPath: string } }) => Promise<ClientGatewayResponseFrame>
    }
    internals.durable = { request }

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
      durable: { request: (gatewayId: string, payload: unknown, key: string) => Promise<ClientGatewayResponseFrame> }
      requestGateway: (gatewayId: string, payload: { kind: 'project.create'; input: { name: string; rootPath: string } }) => Promise<ClientGatewayResponseFrame>
      durableIdempotencyGateways: Set<string>
    }
    internals.durableIdempotencyGateways.add('gateway-1')
    internals.durable = {
      request: async (_gatewayId, _payload, key) => {
        keys.push(key)
        attempts += 1
        if (attempts === 1) throw new Error('connection lost')
        return completedResponse()
      },
    }

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
