import type { MatrixVerificationSnapshot } from './api/nativeMatrixClient'

export class MatrixVerificationCancelledError extends Error {}
export class MatrixVerificationTimeoutError extends Error {}

export async function waitForBilateralVerification(input: {
  flowId: string
  read: () => Promise<MatrixVerificationSnapshot[]>
  onUpdate?: (flow: MatrixVerificationSnapshot) => void
  timeoutMs?: number
  pollMs?: number
  signal?: AbortSignal
  sleep?: (milliseconds: number) => Promise<void>
}): Promise<MatrixVerificationSnapshot> {
  const timeoutMs = input.timeoutMs ?? 180_000
  const pollMs = input.pollMs ?? 500
  const sleep = input.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (input.signal?.aborted) throw new MatrixVerificationCancelledError('Verification was cancelled on this client')
    const flow = (await input.read()).find(value => value.flowId === input.flowId)
    if (flow) {
      input.onUpdate?.(flow)
      if (flow.stage === 'done') return flow
      if (flow.stage === 'cancelled') {
        throw new MatrixVerificationCancelledError(flow.cancellation?.reason ?? 'The computer cancelled verification')
      }
      if (flow.stage === 'unsupported') throw new MatrixVerificationCancelledError('The computer does not support SAS verification')
    }
    await sleep(pollMs)
  }
  throw new MatrixVerificationTimeoutError('The computer did not confirm verification within three minutes')
}
