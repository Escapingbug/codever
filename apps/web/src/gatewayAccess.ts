export type GatewayAccessState = 'checking' | 'authorization-required' | 'ready' | 'error'

export function isGatewayAuthorizationError(message?: string): boolean {
  return Boolean(message && /execution.*(?:unknown|revoked|authorization)|authorization.*required|control key.*approv/i.test(message))
}

export function gatewayAccessState(input: {
  loaded: boolean
  pending: boolean
  error?: string
}): GatewayAccessState {
  if (isGatewayAuthorizationError(input.error)) return 'authorization-required'
  if (input.error) return 'error'
  if (input.loaded) return 'ready'
  return 'checking'
}
