import type { Gateway } from '@codever/protocol'

export type GatewayAccessState = 'upgrade-required' | 'verification-required' | 'checking' | 'authorization-required' | 'ready' | 'error'

export function gatewayRequiresUpgrade(gateway?: Gateway): boolean {
  return gateway?.capabilities.metadata?.matrixControlCompatible === false
}

export function gatewayNeedsVerification(gateway?: Gateway): boolean {
  return !gatewayRequiresUpgrade(gateway) && gateway?.capabilities.metadata?.matrixVerified === false
}

export function gatewayCanControl(gateway?: Gateway): boolean {
  return gateway?.capabilities.metadata?.matrixControlNegotiated === true
    && gateway.capabilities.metadata?.matrixControlCompatible === true
    && gateway.capabilities.metadata?.matrixVerified === true
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
  if (gatewayRequiresUpgrade(input.gateway)) return 'upgrade-required'
  if (gatewayNeedsVerification(input.gateway)) return 'verification-required'
  if (isGatewayAuthorizationError(input.error)) return 'authorization-required'
  if (input.error) return 'error'
  if (!gatewayCanControl(input.gateway)) return 'checking'
  if (input.pending) return 'checking'
  if (input.loaded) return 'ready'
  return 'checking'
}
