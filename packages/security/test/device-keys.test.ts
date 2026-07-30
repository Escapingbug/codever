import { describe, expect, it } from 'vitest'
import type { CodeverCommand } from '@codever/protocol'
import {
  exportDeviceKeyPair,
  exportPublicDeviceKey,
  generateCommandNonce,
  generateDeviceKeyPair,
  importDeviceKeyPair,
  importPublicDeviceKey,
  signCommand,
  verifyCommand,
} from '../src/index.js'

const now = 1_800_000_000_000

function command(): CodeverCommand {
  return {
    kind: 'codever.command',
    version: 1,
    commandId: 'command-key-roundtrip',
    gatewayId: 'gateway-1',
    deviceId: 'device-1',
    sequenceEpoch: 'certificate-device-1',
    conversationId: 'conversation-1',
    revisionEpoch: 'runtime-epoch-1',
    sequence: 1,
    baseRevision: 0,
    operation: 'prompt',
    issuedAt: now - 1,
    expiresAt: now + 60_000,
    nonce: generateCommandNonce(),
    payload: {
      operation: 'prompt',
      sessionId: 'app-session-1',
      text: 'hello',
    },
  }
}

describe('device JWK portability', () => {
  it('exports and imports a signing identity in browser-safe JWK form', async () => {
    const generated = await generateDeviceKeyPair()
    const serialized = await exportDeviceKeyPair(generated)
    const restored = await importDeviceKeyPair(structuredClone(serialized))
    const signed = await signCommand(command(), restored.privateKey, restored.keyId)

    await expect(
      verifyCommand(
        signed,
        restored.publicKey,
        { gatewayId: 'gateway-1', deviceId: 'device-1' },
        { now },
      ),
    ).resolves.toMatchObject({ commandId: 'command-key-roundtrip' })
  })

  it('exports a public-only pairing identity', async () => {
    const generated = await generateDeviceKeyPair()
    const serialized = await exportPublicDeviceKey(generated.publicKey)
    const restored = await importPublicDeviceKey(serialized)
    expect(serialized.keyId).toBe(generated.keyId)
    expect(restored.type).toBe('public')
    expect(restored.usages).toEqual(['verify'])
  })

  it('rejects a private key paired with a different public key', async () => {
    const first = await exportDeviceKeyPair(await generateDeviceKeyPair())
    const second = await exportDeviceKeyPair(await generateDeviceKeyPair())
    await expect(
      importDeviceKeyPair({ ...first, privateKey: second.privateKey }),
    ).rejects.toThrow('does not match')
  })
})
