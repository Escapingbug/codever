import {
    parseGatewayEnrollmentChallengeDto,
    parseGatewayEnrollmentDto,
    type GatewayEnrollmentDto,
    type GatewayEnrollmentIdentity,
    type GatewayPlatform,
} from '@codever/protocol'
import { Agent, request } from 'undici'
import type { GatewayIdentity } from '../identity'
import type { RelayLinkTlsOptions } from './types'

export interface GatewayEnrollmentClientOptions {
    relayWebSocketUrl: string
    gatewayId: string
    workspaceId: string
    name: string
    platform: GatewayPlatform
    identity: GatewayIdentity
    tls?: RelayLinkTlsOptions
}

export async function ensureGatewayEnrollment(options: GatewayEnrollmentClientOptions): Promise<GatewayEnrollmentDto> {
    const bundle = options.identity.enrollmentBundle()
    const identity: GatewayEnrollmentIdentity = {
        gatewayId: options.gatewayId,
        workspaceId: options.workspaceId,
        name: options.name,
        platform: options.platform,
        algorithm: bundle.algorithm,
        fingerprint: bundle.fingerprint,
        publicKeySpkiPem: bundle.publicKeySpkiPem,
    }
    const dispatcher = options.tls ? new Agent({ connect: options.tls }) : undefined
    try {
        const challenge = parseGatewayEnrollmentChallengeDto(await postJson(
            new URL('/v1/gateway-enrollments/challenge', relayHttpUrl(options.relayWebSocketUrl)), identity, dispatcher,
        ))
        const signed = options.identity.signRelayChallenge({ version: 1, ...challenge.challenge }, options.gatewayId)
        return parseGatewayEnrollmentDto(await postJson(
            new URL('/v1/gateway-enrollments/proof', relayHttpUrl(options.relayWebSocketUrl)),
            { enrollmentId: challenge.enrollmentId, gatewayId: options.gatewayId, fingerprint: bundle.fingerprint, signature: signed.signature },
            dispatcher,
        ))
    } finally {
        await dispatcher?.close()
    }
}

async function postJson(url: URL, body: unknown, dispatcher?: Agent): Promise<unknown> {
    const response = await request(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(dispatcher && { dispatcher }),
    })
    const text = await response.body.text()
    let value: unknown
    try { value = text ? JSON.parse(text) : undefined } catch { throw new Error(`Relay enrollment returned invalid JSON (${response.statusCode})`) }
    if (response.statusCode < 200 || response.statusCode >= 300) {
        const message = value && typeof value === 'object' && 'error' in value ? String(value.error) : `HTTP ${response.statusCode}`
        throw new Error(`Relay enrollment failed: ${message}`)
    }
    return value
}

function relayHttpUrl(webSocketUrl: string): URL {
    const url = new URL(webSocketUrl)
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
    url.pathname = '/'
    url.search = ''
    url.hash = ''
    return url
}
