import { describe, expect, it } from 'vitest'
import type { Gateway } from '@codever/protocol'
import { gatewayAccessState, gatewayNeedsVerification, isGatewayAuthorizationError } from '../src/gatewayAccess'

describe('gateway access presentation', () => {
  it('keeps Matrix verification ahead of project loading and execution authorization', () => {
    const gateway: Gateway = {
      id: 'gateway-1', workspaceId: 'default', name: 'Computer', platform: 'windows', version: '1', status: 'online',
      capabilities: { protocolVersions: [1], providers: [], features: [], metadata: { matrixDeviceId: 'DEVICE', matrixVerified: false } },
    }
    expect(gatewayNeedsVerification(gateway)).toBe(true)
    expect(gatewayAccessState({ gateway, loaded: false, pending: false })).toBe('verification-required')
  })
  it('treats first-time execution authorization as setup instead of a failure', () => {
    expect(isGatewayAuthorizationError('Execution signing key is unknown or revoked')).toBe(true)
    expect(gatewayAccessState({ loaded: false, pending: false, error: 'Execution signing key is unknown or revoked' }))
      .toBe('authorization-required')
  })

  it('keeps real failures distinct from setup', () => {
    expect(gatewayAccessState({ loaded: false, pending: false, error: 'Matrix synchronization timed out' }))
      .toBe('error')
    expect(gatewayAccessState({ loaded: true, pending: false })).toBe('ready')
  })

  it('does not present stale cached projects as a completed refresh', () => {
    expect(gatewayAccessState({ loaded: true, pending: true })).toBe('checking')
  })
})
