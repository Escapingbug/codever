import type { Gateway } from '@codever/protocol'

export type GatewayAccessState = 'verification-required' | 'checking' | 'authorization-required' | 'ready' | 'error'

export function gatewayNeedsVerification(gateway?: Gateway): boolean {
  return gateway?.capabilities.metadata?.matrixVerified === false
}

export function isGatewayAuthorizationError(message?: string): boolean {
  return Boolean(message && /execution.*(?:unknown|revoked|authorization)|authorization.*required|control key.*approv/i.test(message))
}

export function gatewayAccessState(input: {
  gateway?: Gateway
  loaded: boolean
  pending: boolean
  error?: string
}): GatewayAccessState {
  if (gatewayNeedsVerification(input.gateway)) return 'verification-required'
  if (isGatewayAuthorizationError(input.error)) return 'authorization-required'
  if (input.pending) return 'checking'
  if (input.error) return 'error'
  if (input.loaded) return 'ready'
  return 'checking'
}
