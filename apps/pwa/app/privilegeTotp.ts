import {
  base64UrlDecode,
  base64UrlEncode,
  decodeBase32,
  generateTotp,
  normalizeBase32Secret,
  toArrayBuffer,
} from '@codever/security'

const STORAGE_PREFIX = 'codever.privilege-totp.v1.'
const PROFILE_VERSION = 1
const PRF_SALT_BYTES = 32
const AES_GCM_IV_BYTES = 12

interface StoredPrivilegeTotpProfile {
  version: 1
  gatewayId: string
  credentialId: string
  prfSalt: string
  iv: string
  encryptedSecret: string
}

export interface PrivilegeTotpEnvironment {
  credentials: Pick<CredentialsContainer, 'create' | 'get'>
  crypto: Crypto
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  now(): number
}

export class PrivilegeTotpNotConfiguredError extends Error {
  constructor() {
    super('TOTP approval is not configured for this computer')
    this.name = 'PrivilegeTotpNotConfiguredError'
  }
}

export class PrivilegeTotpUnsupportedError extends Error {
  constructor(message = 'This browser or authenticator does not support fingerprint-protected WebAuthn PRF') {
    super(message)
    this.name = 'PrivilegeTotpUnsupportedError'
  }
}

export function hasPrivilegeTotp(
  gatewayId: string,
  environment: PrivilegeTotpEnvironment = browserEnvironment(),
): boolean {
  return readProfile(gatewayId, environment.storage) !== null
}

export async function enrollPrivilegeTotp(
  gatewayId: string,
  setupKey: string,
  environment: PrivilegeTotpEnvironment = browserEnvironment(),
): Promise<string> {
  if (!gatewayId.trim()) throw new TypeError('Gateway identity is required')
  const normalizedSecret = normalizeBase32Secret(setupKey)
  const secretBytes = decodeBase32(normalizedSecret)
  if (secretBytes.length !== 20) {
    secretBytes.fill(0)
    throw new TypeError('Codever TOTP setup keys must contain exactly 32 Base32 characters')
  }
  const prfSalt = randomBytes(environment.crypto, PRF_SALT_BYTES)
  const credential = await environment.credentials.create({
    publicKey: {
      challenge: toArrayBuffer(randomBytes(environment.crypto, 32)),
      rp: { name: 'Codever' },
      user: {
        id: toArrayBuffer(randomBytes(environment.crypto, 32)),
        name: `privilege-${gatewayId}`,
        displayName: 'Codever remote administrator approval',
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
      timeout: 60_000,
      attestation: 'none',
      extensions: {
        prf: { eval: { first: toArrayBuffer(prfSalt) } },
      },
    } as PublicKeyCredentialCreationOptions,
  })
  const publicKeyCredential = requirePublicKeyCredential(credential)
  let prfOutput = readPrfOutput(publicKeyCredential)
  if (!prfOutput) {
    prfOutput = await evaluatePrf(
      environment,
      new Uint8Array(publicKeyCredential.rawId),
      prfSalt,
    )
  }
  const iv = randomBytes(environment.crypto, AES_GCM_IV_BYTES)
  const encryptedSecret = await encryptSecret(
    environment.crypto.subtle,
    prfOutput,
    secretBytes,
    iv,
    gatewayId,
  )
  const profile: StoredPrivilegeTotpProfile = {
    version: PROFILE_VERSION,
    gatewayId,
    credentialId: base64UrlEncode(new Uint8Array(publicKeyCredential.rawId)),
    prfSalt: base64UrlEncode(prfSalt),
    iv: base64UrlEncode(iv),
    encryptedSecret: base64UrlEncode(encryptedSecret),
  }
  environment.storage.setItem(storageKey(gatewayId), JSON.stringify(profile))
  try {
    return await generateTotp(secretBytes, { timeMs: environment.now() })
  } finally {
    secretBytes.fill(0)
    prfOutput.fill(0)
  }
}

export async function unlockPrivilegeTotp(
  gatewayId: string,
  environment: PrivilegeTotpEnvironment = browserEnvironment(),
): Promise<string> {
  const profile = readProfile(gatewayId, environment.storage)
  if (!profile) throw new PrivilegeTotpNotConfiguredError()
  const prfOutput = await evaluatePrf(
    environment,
    base64UrlDecode(profile.credentialId),
    base64UrlDecode(profile.prfSalt),
  )
  const secret = await decryptSecret(
    environment.crypto.subtle,
    prfOutput,
    base64UrlDecode(profile.encryptedSecret),
    base64UrlDecode(profile.iv),
    gatewayId,
  )
  try {
    return await generateTotp(secret, { timeMs: environment.now() })
  } finally {
    secret.fill(0)
    prfOutput.fill(0)
  }
}

export function forgetPrivilegeTotp(
  gatewayId: string,
  environment: PrivilegeTotpEnvironment = browserEnvironment(),
): void {
  environment.storage.removeItem(storageKey(gatewayId))
}

async function evaluatePrf(
  environment: PrivilegeTotpEnvironment,
  credentialId: Uint8Array,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const credential = await environment.credentials.get({
    publicKey: {
      challenge: toArrayBuffer(randomBytes(environment.crypto, 32)),
      allowCredentials: [{
        type: 'public-key',
        id: toArrayBuffer(credentialId),
      }],
      userVerification: 'required',
      timeout: 60_000,
      extensions: {
        prf: { eval: { first: toArrayBuffer(salt) } },
      },
    } as PublicKeyCredentialRequestOptions,
  })
  const output = readPrfOutput(requirePublicKeyCredential(credential))
  if (!output) throw new PrivilegeTotpUnsupportedError()
  return output
}

async function encryptSecret(
  subtle: SubtleCrypto,
  prfOutput: Uint8Array,
  secret: Uint8Array,
  iv: Uint8Array,
  gatewayId: string,
): Promise<Uint8Array> {
  const key = await subtle.importKey(
    'raw',
    toArrayBuffer(prfOutput),
    'AES-GCM',
    false,
    ['encrypt'],
  )
  return new Uint8Array(await subtle.encrypt({
    name: 'AES-GCM',
    iv: toArrayBuffer(iv),
    additionalData: toArrayBuffer(profileContext(gatewayId)),
  }, key, toArrayBuffer(secret)))
}

async function decryptSecret(
  subtle: SubtleCrypto,
  prfOutput: Uint8Array,
  encryptedSecret: Uint8Array,
  iv: Uint8Array,
  gatewayId: string,
): Promise<Uint8Array> {
  const key = await subtle.importKey(
    'raw',
    toArrayBuffer(prfOutput),
    'AES-GCM',
    false,
    ['decrypt'],
  )
  try {
    return new Uint8Array(await subtle.decrypt({
      name: 'AES-GCM',
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(profileContext(gatewayId)),
    }, key, toArrayBuffer(encryptedSecret)))
  } catch (error) {
    throw new Error('Fingerprint unlock succeeded, but the saved TOTP key could not be decrypted', {
      cause: error,
    })
  }
}

function readProfile(
  gatewayId: string,
  storage: Pick<Storage, 'getItem'>,
): StoredPrivilegeTotpProfile | null {
  const raw = storage.getItem(storageKey(gatewayId))
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<StoredPrivilegeTotpProfile>
    if (
      value.version !== PROFILE_VERSION
      || value.gatewayId !== gatewayId
      || !isBase64Url(value.credentialId)
      || !isBase64Url(value.prfSalt)
      || !isBase64Url(value.iv)
      || !isBase64Url(value.encryptedSecret)
    ) return null
    return value as StoredPrivilegeTotpProfile
  } catch {
    return null
  }
}

function requirePublicKeyCredential(credential: Credential | null): PublicKeyCredential {
  if (
    !credential
    || !('rawId' in credential)
    || typeof (credential as PublicKeyCredential).getClientExtensionResults !== 'function'
  ) {
    throw new PrivilegeTotpUnsupportedError('Fingerprint or device unlock was cancelled or unavailable')
  }
  return credential as PublicKeyCredential
}

function readPrfOutput(credential: PublicKeyCredential): Uint8Array | null {
  const extensionResults = credential.getClientExtensionResults() as AuthenticationExtensionsClientOutputs & {
    prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } }
  }
  const first = extensionResults.prf?.results?.first
  return first instanceof ArrayBuffer ? new Uint8Array(first) : null
}

function browserEnvironment(): PrivilegeTotpEnvironment {
  if (
    typeof window === 'undefined'
    || !window.PublicKeyCredential
    || !navigator.credentials
    || !globalThis.crypto?.subtle
  ) throw new PrivilegeTotpUnsupportedError()
  return {
    credentials: navigator.credentials,
    crypto: globalThis.crypto,
    storage: window.localStorage,
    now: Date.now,
  }
}

function randomBytes(crypto: Crypto, length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

function profileContext(gatewayId: string): Uint8Array {
  return new TextEncoder().encode(`codever-privilege-totp-v1:${gatewayId}`)
}

function storageKey(gatewayId: string): string {
  return `${STORAGE_PREFIX}${gatewayId}`
}

function isBase64Url(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/u.test(value)
}
