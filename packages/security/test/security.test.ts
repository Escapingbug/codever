import { describe, expect, it } from 'vitest'
import type { CodeverCommand } from '@codever/protocol'
import {
  generateDeviceKeyPair,
  IdempotencyLedger,
  InMemoryIdempotencyStore,
  InMemoryReplayStore,
  ReplayGuard,
  SecurityError,
  signCommand,
  verifyCommand,
} from '../src/index.js'

const now = 1_800_000_000_000

function command(overrides: Partial<CodeverCommand> = {}): CodeverCommand {
  return {
    kind: 'codever.command',
    version: 1,
    commandId: 'command-1',
    gatewayId: 'gateway-1',
    deviceId: 'device-1',
    conversationId: 'conversation-1',
    sequence: 1,
    baseRevision: 0,
    operation: 'prompt',
    issuedAt: now - 1_000,
    expiresAt: now + 60_000,
    nonce: '0123456789abcdef',
    payload: { operation: 'prompt', text: 'hello' },
    ...overrides,
  } as CodeverCommand
}

describe('signed commands', () => {
  it('accepts a valid command bound to local execution context', async () => {
    const keys = await generateDeviceKeyPair()
    const signed = await signCommand(command(), keys.privateKey, keys.keyId)

    await expect(
      verifyCommand(
        signed,
        keys.publicJwk,
        {
          gatewayId: 'gateway-1',
          deviceId: 'device-1',
          conversationId: 'conversation-1',
          allowedOperations: ['prompt'],
        },
        { now },
      ),
    ).resolves.toMatchObject({ commandId: 'command-1', operation: 'prompt' })
  })

  it('rejects payload tampering', async () => {
    const keys = await generateDeviceKeyPair()
    const signed = await signCommand(command(), keys.privateKey, keys.keyId)
    const tampered = structuredClone(signed)
    tampered.command.payload = { operation: 'prompt', text: 'malicious replacement' }

    await expect(
      verifyCommand(tampered, keys.publicKey, {
        gatewayId: 'gateway-1',
        deviceId: 'device-1',
      }, { now }),
    ).rejects.toMatchObject({ code: 'invalid_signature' })
  })

  it.each([
    [
      'gateway',
      { gatewayId: 'gateway-2', deviceId: 'device-1', conversationId: 'conversation-1' },
    ],
    [
      'device',
      { gatewayId: 'gateway-1', deviceId: 'device-2', conversationId: 'conversation-1' },
    ],
    [
      'conversation',
      { gatewayId: 'gateway-1', deviceId: 'device-1', conversationId: 'conversation-2' },
    ],
    [
      'operation',
      {
        gatewayId: 'gateway-1',
        deviceId: 'device-1',
        conversationId: 'conversation-1',
        allowedOperations: ['cancel'] as const,
      },
    ],
  ])('rejects a valid signature with the wrong %s binding', async (_name, bindings) => {
    const keys = await generateDeviceKeyPair()
    const signed = await signCommand(command(), keys.privateKey, keys.keyId)

    await expect(
      verifyCommand(signed, keys.publicKey, bindings, { now }),
    ).rejects.toMatchObject({ code: 'binding_mismatch' })
  })

  it('rejects an expired command', async () => {
    const keys = await generateDeviceKeyPair()
    const expired = command({ issuedAt: now - 60_000, expiresAt: now - 1 })
    const signed = await signCommand(expired, keys.privateKey, keys.keyId)

    await expect(
      verifyCommand(signed, keys.publicKey, {
        gatewayId: 'gateway-1',
        deviceId: 'device-1',
      }, { now }),
    ).rejects.toMatchObject({ code: 'expired' })
  })
})

describe('ReplayGuard', () => {
  it('atomically rejects nonce and command-id replay', async () => {
    const guard = new ReplayGuard(new InMemoryReplayStore())
    await guard.claim(command(), now)
    await expect(guard.claim(command(), now)).rejects.toEqual(
      expect.objectContaining<Partial<SecurityError>>({ code: 'replay' }),
    )

    await expect(
      guard.claim(command({ commandId: 'command-2' }), now),
    ).rejects.toMatchObject({ code: 'replay' })
  })
})

describe('IdempotencyLedger', () => {
  it('returns the stored result without executing a duplicate command', async () => {
    const ledger = new IdempotencyLedger<{ answer: string }>(
      new InMemoryIdempotencyStore<{ answer: string }>(),
    )
    const first = await ledger.begin(command(), now)
    expect(first.kind).toBe('execute')
    if (first.kind !== 'execute') throw new Error('Expected an execution claim')
    await ledger.complete(first, { answer: 'done' }, now + 1)

    await expect(ledger.begin(command(), now + 2)).resolves.toEqual({
      kind: 'completed',
      result: { answer: 'done' },
    })
  })

  it('rejects command-id reuse with different content', async () => {
    const ledger = new IdempotencyLedger(new InMemoryIdempotencyStore())
    await ledger.begin(command(), now)
    await expect(
      ledger.begin(
        command({ payload: { operation: 'prompt', text: 'different' } }),
        now + 1,
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })
})
