import {
  canonicalJsonBytes,
  commandSchema,
  eventSchema,
  signedCommandSchema,
  signedEventSchema,
  type CodeverCommand,
  type CodeverEvent,
  type SignedCommand,
  type SignedEvent,
} from '@codever/protocol'
import {
  base64UrlDecode,
  base64UrlEncode,
  isCryptoKey,
  publicKeyId,
  toArrayBuffer,
  webCrypto,
} from './encoding.js'
import { SecurityError } from './errors.js'

const algorithm: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' }

export interface DeviceKeyPair {
  keyId: string
  privateKey: CryptoKey
  publicKey: CryptoKey
  publicJwk: JsonWebKey
}

export async function generateDeviceKeyPair(): Promise<DeviceKeyPair> {
  const pair = (await webCrypto().subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const publicJwk = await webCrypto().subtle.exportKey('jwk', pair.publicKey)
  return {
    keyId: await publicKeyId(publicJwk),
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicJwk,
  }
}

async function importPublicKey(key: CryptoKey | JsonWebKey): Promise<CryptoKey> {
  if (isCryptoKey(key)) return key
  return webCrypto().subtle.importKey(
    'jwk',
    key,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
}

async function sign<T>(document: T, privateKey: CryptoKey): Promise<string> {
  const signature = await webCrypto().subtle.sign(
    algorithm,
    privateKey,
    toArrayBuffer(canonicalJsonBytes(document)),
  )
  return base64UrlEncode(new Uint8Array(signature))
}

async function verify<T>(
  document: T,
  signature: string,
  publicKey: CryptoKey | JsonWebKey,
): Promise<boolean> {
  return webCrypto().subtle.verify(
    algorithm,
    await importPublicKey(publicKey),
    toArrayBuffer(base64UrlDecode(signature)),
    toArrayBuffer(canonicalJsonBytes(document)),
  )
}

export async function signCommand(
  input: CodeverCommand,
  privateKey: CryptoKey,
  keyId: string,
): Promise<SignedCommand> {
  const command = commandSchema.parse(input)
  return {
    command,
    signature: {
      algorithm: 'ES256',
      keyId,
      value: await sign(command, privateKey),
    },
  }
}

export async function signEvent(
  input: CodeverEvent,
  privateKey: CryptoKey,
  keyId: string,
): Promise<SignedEvent> {
  const event = eventSchema.parse(input)
  return {
    event,
    signature: {
      algorithm: 'ES256',
      keyId,
      value: await sign(event, privateKey),
    },
  }
}

export interface CommandBindings {
  gatewayId: string
  deviceId: string
  conversationId?: string
  allowedOperations?: readonly CodeverCommand['operation'][]
}

export interface VerificationClock {
  now?: number
  maxFutureSkewMs?: number
  maxLifetimeMs?: number
}

const DEFAULT_MAX_FUTURE_SKEW_MS = 30_000
const DEFAULT_MAX_LIFETIME_MS = 5 * 60_000

/**
 * Verifies an application-layer command using a locally pinned device key.
 * No Matrix sender, room membership, power level, or homeserver assertion is
 * accepted as authority.
 */
export async function verifyCommand(
  input: unknown,
  trustedDeviceKey: CryptoKey | JsonWebKey,
  bindings: CommandBindings,
  clock: VerificationClock = {},
): Promise<CodeverCommand> {
  const signed = signedCommandSchema.parse(input)
  const expectedKeyId = await publicKeyId(trustedDeviceKey)
  if (signed.signature.keyId !== expectedKeyId) {
    throw new SecurityError('key_mismatch', 'Signature key is not the locally pinned device key')
  }
  if (!(await verify(signed.command, signed.signature.value, trustedDeviceKey))) {
    throw new SecurityError('invalid_signature', 'Command signature is invalid')
  }

  const command = signed.command
  if (
    command.gatewayId !== bindings.gatewayId ||
    command.deviceId !== bindings.deviceId ||
    (bindings.conversationId !== undefined &&
      command.conversationId !== bindings.conversationId) ||
    (bindings.allowedOperations !== undefined &&
      !bindings.allowedOperations.includes(command.operation))
  ) {
    throw new SecurityError('binding_mismatch', 'Command is not bound to the expected execution context')
  }

  const now = clock.now ?? Date.now()
  if (command.expiresAt <= now) {
    throw new SecurityError('expired', 'Command has expired')
  }
  if (command.issuedAt > now + (clock.maxFutureSkewMs ?? DEFAULT_MAX_FUTURE_SKEW_MS)) {
    throw new SecurityError('issued_in_future', 'Command issue time is too far in the future')
  }
  if (command.expiresAt - command.issuedAt > (clock.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS)) {
    throw new SecurityError('lifetime_exceeded', 'Command validity window exceeds policy')
  }

  return command
}

export interface EventBindings {
  gatewayId: string
  conversationId: string
}

export async function verifyEvent(
  input: unknown,
  trustedGatewayKey: CryptoKey | JsonWebKey,
  bindings: EventBindings,
): Promise<CodeverEvent> {
  const signed = signedEventSchema.parse(input)
  const expectedKeyId = await publicKeyId(trustedGatewayKey)
  if (signed.signature.keyId !== expectedKeyId) {
    throw new SecurityError('key_mismatch', 'Signature key is not the locally pinned gateway key')
  }
  if (!(await verify(signed.event, signed.signature.value, trustedGatewayKey))) {
    throw new SecurityError('invalid_signature', 'Event signature is invalid')
  }
  if (
    signed.event.gatewayId !== bindings.gatewayId ||
    signed.event.conversationId !== bindings.conversationId
  ) {
    throw new SecurityError('binding_mismatch', 'Event is not bound to the expected context')
  }
  return signed.event
}
