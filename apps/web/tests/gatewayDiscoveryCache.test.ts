import type { Gateway } from '@codever/protocol'
import { describe, expect, it } from 'vitest'
import { reconcileGatewayDiscovery } from '../src/state/codeverState'

function gateway(id: string, status: Gateway['status'] = 'online'): Gateway {
  return {
    id, workspaceId: 'default', name: `Computer ${id}`, platform: 'windows', version: '0.1.0', status,
    lastSeenAt: '2026-07-21T00:00:00.000Z',
    capabilities: {
      protocolVersions: [1], providers: ['codex'], features: [],
      metadata: { matrixDeviceId: `DEVICE-${id}`, matrixVerified: true },
    },
  }
}

describe('Gateway discovery cache reconciliation', () => {
  it('does not delete cached computers when cold-start discovery has no response', () => {
    const result = reconcileGatewayDiscovery([gateway('cached')], [])

    expect(result).toMatchObject([{
      id: 'cached', status: 'offline',
      capabilities: { metadata: { matrixDeviceId: 'DEVICE-cached' } },
    }])
    expect(result[0]?.capabilities.metadata?.matrixControlNegotiated).toBeUndefined()
    expect(result[0]?.capabilities.metadata?.matrixVerified).toBeUndefined()
  })

  it('replaces a cached snapshot when that computer answers discovery', () => {
    const current = gateway('same', 'offline')
    const discovered = { ...gateway('same'), name: 'Fresh name' }

    expect(reconcileGatewayDiscovery([current], [discovered])).toEqual([discovered])
  })

  it('adds newly discovered computers without dropping cached ones', () => {
    expect(reconcileGatewayDiscovery([gateway('cached')], [gateway('new')]).map(item => item.id))
      .toEqual(['new', 'cached'])
  })
})
