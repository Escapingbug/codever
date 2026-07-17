import * as opaque from '@serenity-kit/opaque'

export interface OpaqueCredentialClientRegistrationStart {
    clientRegistrationState: string
    registrationRequest: string
}

export interface OpaqueCredentialClientLoginStart {
    clientLoginState: string
    startLoginRequest: string
}

export async function createOpaqueServerSetup(): Promise<string> {
    await opaque.ready
    return opaque.server.createSetup()
}

export async function getOpaqueServerPublicKey(serverSetup: string): Promise<string> {
    await opaque.ready
    return opaque.server.getPublicKey(serverSetup)
}

export async function startOpaqueCredentialRegistration(secret: string): Promise<OpaqueCredentialClientRegistrationStart> {
    await opaque.ready
    assertSecret(secret)
    return opaque.client.startRegistration({ password: secret })
}

export async function createOpaqueCredentialRegistrationResponse(input: {
    serverSetup: string
    subjectId: string
    serverId: string
    registrationRequest: string
}): Promise<string> {
    await opaque.ready
    return opaque.server.createRegistrationResponse({
        serverSetup: input.serverSetup,
        userIdentifier: input.subjectId,
        registrationRequest: input.registrationRequest,
    }).registrationResponse
}

export async function finishOpaqueCredentialRegistration(input: {
    secret: string
    subjectId: string
    serverId: string
    clientRegistrationState: string
    registrationResponse: string
    expectedServerStaticPublicKey?: string
}): Promise<{ registrationRecord: string; serverStaticPublicKey: string }> {
    await opaque.ready
    assertSecret(input.secret)
    const result = opaque.client.finishRegistration({
        password: input.secret,
        clientRegistrationState: input.clientRegistrationState,
        registrationResponse: input.registrationResponse,
        identifiers: credentialIdentifiers(input.subjectId, input.serverId),
        keyStretching: 'memory-constrained',
    })
    if (input.expectedServerStaticPublicKey && result.serverStaticPublicKey !== input.expectedServerStaticPublicKey) {
        throw new Error('Relay static public key changed during credential registration')
    }
    return { registrationRecord: result.registrationRecord, serverStaticPublicKey: result.serverStaticPublicKey }
}

export async function startOpaqueCredentialLogin(secret: string): Promise<OpaqueCredentialClientLoginStart> {
    await opaque.ready
    assertSecret(secret)
    return opaque.client.startLogin({ password: secret })
}

export async function startOpaqueCredentialServerLogin(input: {
    serverSetup: string
    registrationRecord: string
    subjectId: string
    serverId: string
    startLoginRequest: string
}): Promise<{ serverLoginState: string; loginResponse: string }> {
    await opaque.ready
    return opaque.server.startLogin({
        serverSetup: input.serverSetup,
        registrationRecord: input.registrationRecord,
        startLoginRequest: input.startLoginRequest,
        userIdentifier: input.subjectId,
        identifiers: credentialIdentifiers(input.subjectId, input.serverId),
    })
}

export async function finishOpaqueCredentialClientLogin(input: {
    secret: string
    subjectId: string
    serverId: string
    clientLoginState: string
    loginResponse: string
    expectedServerStaticPublicKey: string
}): Promise<{ finishLoginRequest: string; sessionKey: string }> {
    await opaque.ready
    assertSecret(input.secret)
    const result = opaque.client.finishLogin({
        password: input.secret,
        clientLoginState: input.clientLoginState,
        loginResponse: input.loginResponse,
        identifiers: credentialIdentifiers(input.subjectId, input.serverId),
        keyStretching: 'memory-constrained',
    })
    if (!result) throw new Error('Credential authentication failed')
    if (result.serverStaticPublicKey !== input.expectedServerStaticPublicKey) {
        throw new Error('Relay static public key changed')
    }
    return { finishLoginRequest: result.finishLoginRequest, sessionKey: result.sessionKey }
}

export async function finishOpaqueCredentialServerLogin(input: {
    serverLoginState: string
    finishLoginRequest: string
    subjectId: string
    serverId: string
}): Promise<string> {
    await opaque.ready
    return opaque.server.finishLogin({
        serverLoginState: input.serverLoginState,
        finishLoginRequest: input.finishLoginRequest,
        identifiers: credentialIdentifiers(input.subjectId, input.serverId),
    }).sessionKey
}

export function generateOpaqueCredentialSecret(crypto: Crypto = globalThis.crypto): string {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64url')
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function credentialIdentifiers(subjectId: string, serverId: string): { client: string; server: string } {
    if (!subjectId.trim() || !serverId.trim()) throw new Error('subjectId and serverId are required')
    return { client: `codever-device:${subjectId}`, server: `codever-relay:${serverId}` }
}

function assertSecret(secret: string): void {
    if (secret.length < 16) throw new Error('Credential secret is too short')
}
