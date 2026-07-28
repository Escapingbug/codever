import { describe, expect, it } from 'vitest'
import { CODEVER_MATRIX_EXTENSION } from '@/channel/matrix'
import { isMatrixGatewayControlEvent } from '@/gateway/matrix'

describe('Matrix Gateway control event filtering', () => {
  it.each([
    'pairing_request',
    'pairing_response',
    'gateway_device_rotation',
  ])('ignores %s before application content decryption', kind => {
    expect(isMatrixGatewayControlEvent({
      [CODEVER_MATRIX_EXTENSION]: { version: 1, kind },
    })).toBe(true)
  })

  it('does not filter commands or malformed extensions', () => {
    expect(isMatrixGatewayControlEvent({
      [CODEVER_MATRIX_EXTENSION]: { version: 1, kind: 'secure_envelope' },
    })).toBe(false)
    expect(isMatrixGatewayControlEvent({
      [CODEVER_MATRIX_EXTENSION]: { version: 2, kind: 'pairing_request' },
    })).toBe(false)
    expect(isMatrixGatewayControlEvent({})).toBe(false)
  })
})
