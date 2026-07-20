import { describe, expect, it, vi } from 'vitest'
import { MatrixVerificationCancelledError, MatrixVerificationTimeoutError, waitForBilateralVerification } from '../src/matrixVerification'
import type { MatrixVerificationSnapshot } from '../src/api/nativeMatrixClient'

const flow = (stage: MatrixVerificationSnapshot['stage']): MatrixVerificationSnapshot => ({
  flowId: 'flow-1', stage, otherDeviceId: 'GATEWAY',
})

describe('bilateral Matrix verification', () => {
  it('does not complete while only this client has confirmed', async () => {
    const states = [flow('present_sas'), flow('present_sas'), flow('done')]
    const read = vi.fn(async () => [states.shift()!])
    await expect(waitForBilateralVerification({ flowId: 'flow-1', read, pollMs: 0 })).resolves.toMatchObject({ stage: 'done' })
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('surfaces remote cancellation without advancing', async () => {
    await expect(waitForBilateralVerification({
      flowId: 'flow-1', pollMs: 0,
      read: async () => [{ ...flow('cancelled'), cancellation: { code: 'm.mismatched_sas', reason: 'Emoji differ', cancelledByUs: false } }],
    })).rejects.toThrow(MatrixVerificationCancelledError)
  })

  it('times out when the Gateway never confirms', async () => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await expect(waitForBilateralVerification({
      flowId: 'flow-1', timeoutMs: 2, pollMs: 1,
      read: async () => [flow('present_sas')], sleep: async milliseconds => { now += milliseconds },
    })).rejects.toThrow(MatrixVerificationTimeoutError)
    vi.restoreAllMocks()
  })
})
