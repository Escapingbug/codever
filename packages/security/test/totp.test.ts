import { describe, expect, it } from 'vitest'
import {
  decodeBase32,
  encodeBase32,
  generateTotp,
  normalizeBase32Secret,
} from '../src/index.js'

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 vectors', async () => {
    const vectors = [
      [59, '94287082'],
      [1_111_111_109, '07081804'],
      [1_111_111_111, '14050471'],
      [1_234_567_890, '89005924'],
      [2_000_000_000, '69279037'],
      [20_000_000_000, '65353130'],
    ] as const
    for (const [seconds, expected] of vectors) {
      await expect(generateTotp(RFC_SECRET, {
        algorithm: 'SHA-1',
        digits: 8,
        timeMs: seconds * 1_000,
      })).resolves.toBe(expected)
    }
  })

  it('normalizes human-entered setup keys and round-trips Base32', () => {
    expect(normalizeBase32Secret('gezd-gnbv gy3tqojq gezdgnbvgy3tqojq===='))
      .toBe(RFC_SECRET)
    expect(encodeBase32(decodeBase32(RFC_SECRET))).toBe(RFC_SECRET)
  })

  it('rejects malformed or weak setup keys', () => {
    expect(() => decodeBase32('not-a-base32-secret!')).toThrow(/Base32/u)
    expect(() => decodeBase32('JBSWY3DPEHPK3PXP')).toThrow(/between 16 and 64 bytes/u)
  })
})
