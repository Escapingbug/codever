import type {
  SignedPairingOffer,
  SignedPairingRequest,
  SignedPairingResponse,
} from '@codever/protocol'
import { signedPairingRequestSchema } from '@codever/protocol'
import type { GatewayPairingService } from './service.js'

/**
 * Pairing does not trust its transport. Implementations may use Matrix events,
 * local IPC, WebRTC, or HTTPS; accepted requests and responses are signed.
 */
export interface PairingTransport {
  publishOffer?(offer: SignedPairingOffer, link: string): Promise<void>
  onRequest(handler: (request: unknown) => Promise<void>): () => void
  sendResponse(request: SignedPairingRequest, response: SignedPairingResponse): Promise<void>
  sendDenied?(request: SignedPairingRequest, reason?: string): Promise<void>
}

export interface PairingCodeRenderer {
  render(link: string): string | Promise<string>
}

export function attachPairingTransport(
  service: GatewayPairingService,
  transport: PairingTransport,
  onAccepted?: (result: {
    requestId: string
    deviceId: string
    deviceName: string
    verificationCode: string
  }) => void | Promise<void>,
): () => void {
  return transport.onRequest(async (input) => {
    const request = signedPairingRequestSchema.parse(input)
    const accepted = await service.receiveRequest(request)
    await transport.sendResponse(request, accepted.response)
    await onAccepted?.(accepted)
  })
}
