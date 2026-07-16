import type { FastifyRequest } from 'fastify'
import { createPublicKey, verify, type KeyObject } from 'node:crypto'
import {
    serializeGatewayAuthPayload,
    type AccountRole,
    type GatewayAuthResponse,
    type RelayAuthChallenge,
    type RelayAuthRejected,
} from '@codever/protocol'

export interface ClientIdentity {
    id: string
    workspaceId: string
    deviceId?: string
    roles?: AccountRole[]
}

export interface ClientAuthorizationTarget {
    gatewayId?: string
    projectId?: string
    sessionId?: string
}

export type ClientAction =
    | 'gateway:list'
    | 'project:list'
    | 'session:list'
    | 'session:create'
    | 'session:read'
    | 'event:list'
    | 'session:message'
    | 'session:cancel'
    | 'session:config'
    | 'decision:respond'

export interface ClientAuthenticator {
    authenticate(request: FastifyRequest): Promise<ClientIdentity | null>
    authorize(
        identity: ClientIdentity,
        action: ClientAction,
        target: ClientAuthorizationTarget,
    ): Promise<boolean>
}

export interface GatewayAuthenticator {
    verify(input: GatewayAuthenticationInput): Promise<GatewayAuthenticationResult>
}

export interface GatewayAuthenticationInput {
    request: FastifyRequest
    challenge: RelayAuthChallenge
    response: GatewayAuthResponse
}

export type GatewayAuthenticationResult =
    | { authenticated: true }
    | { authenticated: false; code: RelayAuthRejected['code']; message: string }

export interface EnrolledGatewayKey {
    gatewayId: string
    fingerprint: string
    publicKey: string | KeyObject
    enabled: boolean
}

export interface EnrolledGatewayKeyRepository {
    get(gatewayId: string, fingerprint: string): Promise<EnrolledGatewayKey | undefined>
}

export class DenyAllClientAuthenticator implements ClientAuthenticator {
    async authenticate(): Promise<null> {
        return null
    }

    async authorize(): Promise<false> {
        return false
    }
}

export class DenyAllGatewayAuthenticator implements GatewayAuthenticator {
    async verify(): Promise<GatewayAuthenticationResult> {
        return { authenticated: false, code: 'unknown_gateway', message: 'Gateway is not enrolled' }
    }
}

export class EcdsaP256GatewayAuthenticator implements GatewayAuthenticator {
    constructor(private readonly keys: EnrolledGatewayKeyRepository) {}

    async verify(input: GatewayAuthenticationInput): Promise<GatewayAuthenticationResult> {
        const enrolled = await this.keys.get(input.response.gatewayId, input.response.fingerprint)
        if (!enrolled) return { authenticated: false, code: 'unknown_gateway', message: 'Gateway is not enrolled' }
        if (!enrolled.enabled) return { authenticated: false, code: 'gateway_disabled', message: 'Gateway is disabled' }
        try {
            const signature = Buffer.from(input.response.signature, 'base64url')
            const valid = verify(
                'sha256',
                serializeGatewayAuthPayload(input.challenge, input.response.gatewayId, input.response.fingerprint),
                typeof enrolled.publicKey === 'string' ? createPublicKey(enrolled.publicKey) : enrolled.publicKey,
                signature,
            )
            return valid
                ? { authenticated: true }
                : { authenticated: false, code: 'invalid_signature', message: 'Challenge signature is invalid' }
        } catch {
            return { authenticated: false, code: 'invalid_signature', message: 'Challenge signature is invalid' }
        }
    }
}
