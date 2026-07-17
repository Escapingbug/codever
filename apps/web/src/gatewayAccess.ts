export type GatewayAccessState = 'checking' | 'authorization-required' | 'ready' | 'error'

export function isGatewayPairingError(message?: string): boolean {
  return Boolean(message && /gateway pairing is required|pair(?:ing)? required|not paired/i.test(message))
}

export function gatewayAccessState(input: {
  loaded: boolean
  pending: boolean
  error?: string
}): GatewayAccessState {
  if (isGatewayPairingError(input.error)) return 'authorization-required'
  if (input.error) return 'error'
  if (input.loaded) return 'ready'
  return 'checking'
}
