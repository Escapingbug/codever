import { describe, expect, it } from 'vitest'
import { gatewayAccessState, isGatewayAuthorizationError } from '../src/gatewayAccess'

describe('gateway access presentation', () => {
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
})
