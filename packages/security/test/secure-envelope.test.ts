import { describe, expect, it } from 'vitest'
import type { SecureEnvelopeDirection } from '@codever/protocol'
import {
  generateDeviceKeyPair,
  InMemoryReplayStore,
  openSecureEnvelopeBundle,
  openSecureEnvelope,
  sealSecureEnvelopeBundle,
  sealSecureEnvelope,
  type DeviceKeyPair,
  type SecureEnvelopeBindings,
} from '../src/index.js'

const now = 1_800_000_000_000

describe('application-layer secure envelopes', () => {
  it('uses ECDH/HKDF/AES-GCM and opens only for the paired recipient', async () => {
    const device = await generateDeviceKeyPair()
    const gateway = await generateDeviceKeyPair()
    const bindings = bindingsFor(device, gateway, 'device_to_gateway')
    const plaintext = {
      msgtype: 'm.text',
      body: 'secret prompt that Matrix must not see',
      'io.codever': {
        version: 1,
        kind: 'signed_command',
        signed_command: { opaque: true },
      },
    }
    const sealed = await sealSecureEnvelope({
      ...bindings,
      plaintext,
      senderPrivateKey: device.privateKey,
      recipientPublicKey: gateway.publicKey,
      envelopeId: 'envelope-1',
      now,
    })

    expect(JSON.stringify(sealed)).not.toContain('secret prompt')
    await expect(openSecureEnvelope(sealed, {
      recipientPrivateKey: gateway.privateKey,
      senderPublicKey: device.publicKey,
      expected: bindings,
      replayStore: new InMemoryReplayStore(),
      now: now + 1,
    })).resolves.toMatchObject({
      plaintext,
      envelope: {
        envelopeId: 'envelope-1',
        direction: 'device_to_gateway',
      },
    })
  })

  it('supports the reverse Gateway-to-device direction with the same paired keys', async () => {
    const device = await generateDeviceKeyPair()
    const gateway = await generateDeviceKeyPair()
    const bindings = bindingsFor(device, gateway, 'gateway_to_device')
    const sealed = await sealSecureEnvelope({
      ...bindings,
      plaintext: { msgtype: 'm.text', body: 'private agent response' },
      senderPrivateKey: gateway.privateKey,
      recipientPublicKey: device.publicKey,
      now,
    })
    await expect(openSecureEnvelope(sealed, {
      recipientPrivateKey: device.privateKey,
      senderPublicKey: gateway.publicKey,
      expected: bindings,
      replayStore: new InMemoryReplayStore(),
      now: now + 1,
    })).resolves.toMatchObject({
      plaintext: { body: 'private agent response' },
    })
  })

  it('rejects tampering, wrong context, wrong keys, and replays', async () => {
    const device = await generateDeviceKeyPair()
    const gateway = await generateDeviceKeyPair()
    const stranger = await generateDeviceKeyPair()
    const bindings = bindingsFor(device, gateway, 'device_to_gateway')
    const sealed = await sealSecureEnvelope({
      ...bindings,
      plaintext: { body: 'run tests' },
      senderPrivateKey: device.privateKey,
      recipientPublicKey: gateway.publicKey,
      now,
    })
    const store = new InMemoryReplayStore()
    const openOptions = {
      recipientPrivateKey: gateway.privateKey,
      senderPublicKey: device.publicKey,
      expected: bindings,
      replayStore: store,
      now: now + 1,
    }

    await expect(openSecureEnvelope(sealed, openOptions)).resolves.toBeDefined()
    await expect(openSecureEnvelope(sealed, openOptions)).rejects.toMatchObject({ code: 'replay' })

    const tampered = structuredClone(sealed)
    tampered.envelope.ciphertext =
      `${tampered.envelope.ciphertext.slice(0, -1)}${tampered.envelope.ciphertext.endsWith('A') ? 'B' : 'A'}`
    await expect(openSecureEnvelope(tampered, {
      ...openOptions,
      replayStore: new InMemoryReplayStore(),
    })).rejects.toMatchObject({ code: 'invalid_signature' })

    await expect(openSecureEnvelope(sealed, {
      ...openOptions,
      expected: { ...bindings, conversationId: 'other-conversation' },
      replayStore: new InMemoryReplayStore(),
    })).rejects.toMatchObject({ code: 'binding_mismatch' })

    await expect(openSecureEnvelope(sealed, {
      ...openOptions,
      recipientPrivateKey: stranger.privateKey,
      replayStore: new InMemoryReplayStore(),
    })).rejects.toMatchObject({ code: 'key_mismatch' })
  })

  it('accepts serialized pairing JWK material for both ECDSA and ECDH', async () => {
    const device = await generateDeviceKeyPair()
    const gateway = await generateDeviceKeyPair()
    const devicePrivate = await crypto.subtle.exportKey('jwk', device.privateKey)
    const gatewayPrivate = await crypto.subtle.exportKey('jwk', gateway.privateKey)
    const bindings = bindingsFor(device, gateway, 'device_to_gateway')
    const sealed = await sealSecureEnvelope({
      ...bindings,
      plaintext: { body: 'serialized key test' },
      senderPrivateKey: devicePrivate,
      recipientPublicKey: gateway.publicJwk,
      now,
    })

    await expect(openSecureEnvelope(sealed, {
      recipientPrivateKey: gatewayPrivate,
      senderPublicKey: device.publicJwk,
      expected: bindings,
      replayStore: new InMemoryReplayStore(),
      now: now + 1,
    })).resolves.toMatchObject({
      plaintext: { body: 'serialized key test' },
    })
  })

  it('supports store-and-forward Gateway responses after 30 days', async () => {
    const device = await generateDeviceKeyPair()
    const gateway = await generateDeviceKeyPair()
    const bindings = bindingsFor(device, gateway, 'gateway_to_device')
    const sealed = await sealSecureEnvelope({
      ...bindings,
      plaintext: { body: 'offline response' },
      senderPrivateKey: gateway.privateKey,
      recipientPublicKey: device.publicKey,
      now,
      lifetimeMs: 31 * 24 * 60 * 60_000,
    })

    await expect(openSecureEnvelope(sealed, {
      recipientPrivateKey: device.privateKey,
      senderPublicKey: gateway.publicKey,
      expected: bindings,
      replayStore: new InMemoryReplayStore(),
      now: now + 30 * 24 * 60 * 60_000,
    })).resolves.toMatchObject({ plaintext: { body: 'offline response' } })
  })

  it('encrypts one payload and wraps its content key independently for every device', async () => {
    const gateway = await generateDeviceKeyPair()
    const phone = await generateDeviceKeyPair()
    const laptop = await generateDeviceKeyPair()
    const plaintext = { body: 'one logical Gateway response' }
    const sealed = await sealSecureEnvelopeBundle({
      plaintext,
      gatewayId: 'gateway-1',
      conversationId: 'conversation-1',
      direction: 'gateway_to_device',
      senderDeviceId: 'gateway-1',
      senderKeyId: gateway.keyId,
      senderPrivateKey: gateway.privateKey,
      recipients: [
        {
          recipientDeviceId: 'phone-1',
          recipientKeyId: phone.keyId,
          recipientPublicKey: phone.publicKey,
        },
        {
          recipientDeviceId: 'laptop-1',
          recipientKeyId: laptop.keyId,
          recipientPublicKey: laptop.publicKey,
        },
      ],
      envelopeId: 'bundle-1',
      now,
    })

    expect(sealed.bundle.recipients).toHaveLength(2)
    expect(new Set(sealed.bundle.recipients.map(recipient => recipient.wrappedKey)).size).toBe(2)
    expect(JSON.stringify(sealed)).not.toContain(plaintext.body)
    const expected = {
      gatewayId: 'gateway-1',
      conversationId: 'conversation-1',
      direction: 'gateway_to_device' as const,
      senderDeviceId: 'gateway-1',
      senderKeyId: gateway.keyId,
    }
    const phoneReplayStore = new InMemoryReplayStore()
    await expect(openSecureEnvelopeBundle(sealed, {
      recipientPrivateKey: phone.privateKey,
      senderPublicKey: gateway.publicKey,
      expected: {
        ...expected,
        recipientDeviceId: 'phone-1',
        recipientKeyId: phone.keyId,
      },
      replayStore: phoneReplayStore,
      now: now + 1,
    })).resolves.toMatchObject({ plaintext })
    await expect(openSecureEnvelopeBundle(sealed, {
      recipientPrivateKey: phone.privateKey,
      senderPublicKey: gateway.publicKey,
      expected: {
        ...expected,
        recipientDeviceId: 'phone-1',
        recipientKeyId: phone.keyId,
      },
      replayStore: phoneReplayStore,
      now: now + 1,
    })).rejects.toMatchObject({ code: 'replay' })
    await expect(openSecureEnvelopeBundle(sealed, {
      recipientPrivateKey: laptop.privateKey,
      senderPublicKey: gateway.publicKey,
      expected: {
        ...expected,
        recipientDeviceId: 'laptop-1',
        recipientKeyId: laptop.keyId,
      },
      replayStore: new InMemoryReplayStore(),
      now: now + 1,
    })).resolves.toMatchObject({ plaintext })

    const tampered = structuredClone(sealed)
    tampered.bundle.recipients[0]!.wrappedKey =
      `${tampered.bundle.recipients[0]!.wrappedKey.slice(0, -1)}${tampered.bundle.recipients[0]!.wrappedKey.endsWith('A') ? 'B' : 'A'}`
    await expect(openSecureEnvelopeBundle(tampered, {
      recipientPrivateKey: phone.privateKey,
      senderPublicKey: gateway.publicKey,
      expected: {
        ...expected,
        recipientDeviceId: 'phone-1',
        recipientKeyId: phone.keyId,
      },
      replayStore: new InMemoryReplayStore(),
      now: now + 1,
    })).rejects.toMatchObject({ code: 'invalid_signature' })
  })
})

function bindingsFor(
  device: DeviceKeyPair,
  gateway: DeviceKeyPair,
  direction: SecureEnvelopeDirection,
): SecureEnvelopeBindings {
  const fromDevice = direction === 'device_to_gateway'
  return {
    gatewayId: 'gateway-1',
    conversationId: 'conversation-1',
    direction,
    senderDeviceId: fromDevice ? 'phone-1' : 'gateway-1',
    recipientDeviceId: fromDevice ? 'gateway-1' : 'phone-1',
    senderKeyId: fromDevice ? device.keyId : gateway.keyId,
    recipientKeyId: fromDevice ? gateway.keyId : device.keyId,
  }
}
