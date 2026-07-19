import {
    ExecutionAuthorizationError,
    verifyExecutionToken,
    type ExecutionReplayGuard,
} from '@codever/execution-auth'
import {
    PROTOCOL_VERSION,
    parseAuthorizedClientGatewayRequestFrame,
    type AuthorizedClientGatewayRequestFrame,
    type ClientGatewayRequestFrame,
    type ClientGatewayResponseFrame,
} from '@codever/protocol'
import type { GatewayRequestLedger } from './requestLedger'
import type { ExecutionTrustRepository } from './security'

export interface AuthorizedRequestProcessorOptions {
    gatewayId: string
    trust: ExecutionTrustRepository
    replayGuard: ExecutionReplayGuard
    requestLedger: GatewayRequestLedger
    handleRequest: (request: ClientGatewayRequestFrame, principalId: string) => Promise<ClientGatewayResponseFrame>
    now?: () => number
}

/** The sole boundary from an untrusted store-and-forward transport into Gateway business logic. */
export class AuthorizedRequestProcessor {
    constructor(private readonly options: AuthorizedRequestProcessorOptions) {}

    async process(value: unknown): Promise<ClientGatewayResponseFrame> {
        const envelope = parseAuthorizedClientGatewayRequestFrame(value)
        const request = envelope.request
        let principalId: string
        try {
            const verified = await verifyExecutionToken({
                token: envelope.authorization.token,
                request,
                gatewayId: this.options.gatewayId,
                operation: request.payload.kind,
                resolvePublicKey: keyId => this.options.trust.resolve(keyId),
                replayGuard: this.options.replayGuard,
                now: this.options.now,
            })
            principalId = verified.claims.subject
        } catch (error) {
            if (!(error instanceof ExecutionAuthorizationError)) throw error
            return failed(request.requestId, `execution_authorization_${error.code}`, error.message)
        }

        if (!requestUsesDurableLedger(request)) {
            return this.options.handleRequest(request, principalId)
        }
        return this.options.requestLedger.execute(
            request,
            principalId,
            () => this.options.handleRequest(request, principalId),
        )
    }
}

export function requestUsesDurableLedger(request: ClientGatewayRequestFrame): boolean {
    return request.payload.kind !== 'inventory.get'
        && request.payload.kind !== 'events.list'
        && request.payload.kind !== 'provider.sessions.list'
        && request.payload.kind !== 'attachment.list'
        && request.payload.kind !== 'attachment.download'
}

export function authorizedRequest(
    request: ClientGatewayRequestFrame,
    token: string,
): AuthorizedClientGatewayRequestFrame {
    return {
        version: PROTOCOL_VERSION,
        type: 'client.gateway.authorized-request',
        request,
        authorization: { format: 'cose-sign1-cwt', token },
    }
}

function failed(requestId: string, code: string, message: string): ClientGatewayResponseFrame {
    return {
        version: PROTOCOL_VERSION,
        type: 'gateway.client.response',
        requestId,
        status: 'failed',
        failedAt: new Date().toISOString(),
        error: { code, message, retryable: false },
    }
}
