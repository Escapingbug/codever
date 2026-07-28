import { describe, expect, it } from 'vitest'
import {
  secureEnvelopeHeaderSchema,
  signedSecureEnvelopeSchema,
} from '../src/index.js'

const keyA = 'A'.repeat(43)
const keyB = 'B'.repeat(43)

describe('secure envelope schema', () => {
  it('accepts a strictly bound encrypted content envelope', () => {
    const envelope = {
      envelope: {
        kind: 'codever.secure-envelope',
        version: 1,
        envelopeId: 'envelope-1',
        contentType: 'io.codever.matrix-content.v1',
        gatewayId: 'gateway-1',
        conversationId: 'conversation-1',
        direction: 'device_to_gateway',
        senderDeviceId: 'phone-1',
        recipientDeviceId: 'gateway-device',
        senderKeyId: keyA,
        recipientKeyId: keyB,
        issuedAt: 1_000,
        expiresAt: 2_000,
        nonce: 'A'.repeat(16),
        ciphertext: 'B'.repeat(22),
      },
      signature: {
        algorithm: 'ES256',
        keyId: keyA,
        value: 'signature',
      },
    }
    expect(signedSecureEnvelopeSchema.parse(envelope)).toEqual(envelope)
  })

  it('rejects self-addressed and invalid-lifetime envelopes', () => {
    expect(() => secureEnvelopeHeaderSchema.parse({
      kind: 'codever.secure-envelope',
      version: 1,
      envelopeId: 'envelope-1',
      contentType: 'io.codever.matrix-content.v1',
      gatewayId: 'gateway-1',
      conversationId: 'conversation-1',
      direction: 'device_to_gateway',
      senderDeviceId: 'same',
      recipientDeviceId: 'same',
      senderKeyId: keyA,
      recipientKeyId: keyA,
      issuedAt: 2_000,
      expiresAt: 2_000,
      nonce: 'A'.repeat(16),
    })).toThrow()
  })
})
