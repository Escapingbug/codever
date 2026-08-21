import { toArrayBuffer, webCrypto } from './encoding.js'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export interface TotpOptions {
  algorithm?: 'SHA-1' | 'SHA-256' | 'SHA-512'
  digits?: number
  periodSeconds?: number
  timeMs?: number
}

export function normalizeBase32Secret(input: string): string {
  const normalized = input
    .trim()
    .replace(/[\s-]+/gu, '')
    .replace(/=+$/u, '')
    .toUpperCase()
  if (!normalized || !/^[A-Z2-7]+$/u.test(normalized)) {
    throw new TypeError('TOTP setup key must be a Base32 value')
  }
  return normalized
}

export function encodeBase32(bytes: Uint8Array): string {
  if (bytes.length === 0) throw new TypeError('TOTP secret must not be empty')
  let output = ''
  let accumulator = 0
  let bits = 0
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      output += BASE32_ALPHABET[(accumulator >>> bits) & 31]
      accumulator &= (1 << bits) - 1
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31]
  return output
}

export function decodeBase32(input: string): Uint8Array {
  const normalized = normalizeBase32Secret(input)
  const output: number[] = []
  let accumulator = 0
  let bits = 0
  for (const character of normalized) {
    const value = BASE32_ALPHABET.indexOf(character)
    accumulator = (accumulator << 5) | value
    bits += 5
    if (bits >= 8) {
      bits -= 8
      output.push((accumulator >>> bits) & 0xff)
      accumulator &= (1 << bits) - 1
    }
  }
  if (bits > 0 && accumulator !== 0) {
    throw new TypeError('TOTP setup key has non-zero trailing Base32 bits')
  }
  if (output.length < 16 || output.length > 64) {
    throw new TypeError('TOTP secret must contain between 16 and 64 bytes')
  }
  return Uint8Array.from(output)
}

export function totpCounter(timeMs: number, periodSeconds = 30): number {
  if (!Number.isFinite(timeMs) || timeMs < 0) {
    throw new TypeError('TOTP time must be a non-negative finite value')
  }
  if (!Number.isSafeInteger(periodSeconds) || periodSeconds < 1) {
    throw new TypeError('TOTP period must be a positive integer')
  }
  return Math.floor(timeMs / 1_000 / periodSeconds)
}

export async function generateTotp(
  secret: string | Uint8Array,
  options: TotpOptions = {},
): Promise<string> {
  return generateTotpForCounter(
    secret,
    totpCounter(options.timeMs ?? Date.now(), options.periodSeconds ?? 30),
    options,
  )
}

export async function generateTotpForCounter(
  secret: string | Uint8Array,
  counter: number,
  options: Pick<TotpOptions, 'algorithm' | 'digits'> = {},
): Promise<string> {
  const secretBytes = typeof secret === 'string' ? decodeBase32(secret) : secret
  if (secretBytes.length < 16 || secretBytes.length > 64) {
    throw new TypeError('TOTP secret must contain between 16 and 64 bytes')
  }
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new TypeError('TOTP counter must be a non-negative safe integer')
  }
  const digits = options.digits ?? 6
  if (!Number.isSafeInteger(digits) || digits < 6 || digits > 8) {
    throw new TypeError('TOTP digits must be between 6 and 8')
  }
  const counterBytes = new Uint8Array(8)
  new DataView(counterBytes.buffer).setBigUint64(0, BigInt(counter), false)
  const key = await webCrypto().subtle.importKey(
    'raw',
    toArrayBuffer(secretBytes),
    { name: 'HMAC', hash: options.algorithm ?? 'SHA-1' },
    false,
    ['sign'],
  )
  const digest = new Uint8Array(
    await webCrypto().subtle.sign('HMAC', key, toArrayBuffer(counterBytes)),
  )
  const offset = digest[digest.length - 1]! & 0x0f
  const binary = (
    ((digest[offset]! & 0x7f) << 24)
    | (digest[offset + 1]! << 16)
    | (digest[offset + 2]! << 8)
    | digest[offset + 3]!
  ) >>> 0
  return String(binary % (10 ** digits)).padStart(digits, '0')
}
