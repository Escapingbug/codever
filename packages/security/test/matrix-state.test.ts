import { describe, expect, it } from 'vitest'
import {
  generateDeviceKeyPair,
  generateMatrixTimelineKey,
  openMatrixStateEnvelope,
  sealMatrixStateEnvelope,
} from '../src/index.js'

const bindings = {
  gatewayId: 'gateway-1',
  conversationId: 'conversation-1',
  roomId: '!room:example.org',
  eventType: 'io.codever.session.current.v2',
  stateKey: 'session-1',
  epochId: 'epoch-1',
  stateVersion: 7,
} as const

describe('Matrix Room State envelope', () => {
  it('encrypts, signs, and repeatedly opens current state at one Matrix state key', async () => {
    const gateway = await generateDeviceKeyPair()
    const timelineKey = generateMatrixTimelineKey()
    const plaintext = sessionState()
    const sealed = await sealMatrixStateEnvelope({
      ...bindings,
      plaintext,
      timelineKey,
      gatewayPrivateKey: gateway.privateKey,
      gatewayKeyId: gateway.keyId,
      now: 100,
    })

    expect(JSON.stringify(sealed)).not.toContain('Current work')
    const options = {
      timelineKey,
      gatewayPublicKey: gateway.publicKey,
      expected: bindings,
    }
    await expect(openMatrixStateEnvelope(sealed, options)).resolves.toEqual(plaintext)
    // Current Room State is intentionally repeat-readable on reconnect/focus;
    // unlike an executable command it does not consume a replay claim.
    await expect(openMatrixStateEnvelope(sealed, options)).resolves.toEqual(plaintext)
  })

  it('rejects relocation to another state key and ciphertext tampering', async () => {
    const gateway = await generateDeviceKeyPair()
    const timelineKey = generateMatrixTimelineKey()
    const sealed = await sealMatrixStateEnvelope({
      ...bindings,
      plaintext: sessionState(),
      timelineKey,
      gatewayPrivateKey: gateway.privateKey,
      gatewayKeyId: gateway.keyId,
      now: 100,
    })

    await expect(openMatrixStateEnvelope(sealed, {
      timelineKey,
      gatewayPublicKey: gateway.publicKey,
      expected: { ...bindings, stateKey: 'session-2' },
    })).rejects.toMatchObject({ code: 'binding_mismatch' })

    const tampered = structuredClone(sealed)
    tampered.envelope.ciphertext = flipLastBase64UrlCharacter(tampered.envelope.ciphertext)
    await expect(openMatrixStateEnvelope(tampered, {
      timelineKey,
      gatewayPublicKey: gateway.publicKey,
      expected: bindings,
    })).rejects.toMatchObject({ code: 'invalid_signature' })
  })

  it('rejects a payload whose state version differs from its signed header', async () => {
    const gateway = await generateDeviceKeyPair()
    await expect(sealMatrixStateEnvelope({
      ...bindings,
      plaintext: { ...sessionState(), state_version: 8 },
      timelineKey: generateMatrixTimelineKey(),
      gatewayPrivateKey: gateway.privateKey,
      gatewayKeyId: gateway.keyId,
    })).rejects.toMatchObject({ code: 'binding_mismatch' })
  })
})

function sessionState() {
  return {
    version: 2,
    kind: 'session_state',
    gateway_id: 'gateway-1',
    conversation_id: 'conversation-1',
    revision: 4,
    revision_epoch: 'revision-epoch-1',
    revision_epoch_generation: 1,
    state_version: 7,
    session_id: 'session-1',
    state: 'active',
    session: {
      session_id: 'session-1',
      title: 'Current work',
      updated_at: 100,
      archived: false,
      status: 'idle',
      project: { id: 'project-1', name: 'codever', cwd: '/repo' },
      provider: 'codex',
      extensions: [],
    },
    updated_at: 100,
  } as const
}

function flipLastBase64UrlCharacter(value: string): string {
  const last = value.at(-1)
  return `${value.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`
}
