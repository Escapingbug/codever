import { describe, expect, it } from 'vitest'
import { gatewayAccessState, isGatewayPairingError } from '../src/gatewayAccess'

describe('gateway access presentation', () => {
  it('treats first-time pairing as setup instead of a failure', () => {
    expect(isGatewayPairingError('Gateway pairing is required for this client')).toBe(true)
    expect(gatewayAccessState({ loaded: false, pending: false, error: 'Gateway pairing is required' }))
      .toBe('authorization-required')
  })

  it('keeps real failures distinct from setup', () => {
    expect(gatewayAccessState({ loaded: false, pending: false, error: 'Secure handshake timed out' }))
      .toBe('error')
    expect(gatewayAccessState({ loaded: true, pending: false })).toBe('ready')
  })
})
