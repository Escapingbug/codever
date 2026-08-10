import { describe, expect, it } from 'vitest'
import { generateDeviceKeyPair } from '../src/signatures.js'
import {
  generateMatrixTimelineKey,
  openMatrixTimelineEnvelope,
  sealMatrixTimelineEnvelope,
} from '../src/matrix-timeline.js'

describe('Matrix timeline envelope', () => {
  it('keeps one signed application ciphertext readable across Matrix history', async () => {
    const gateway = await generateDeviceKeyPair()
    const timelineKey = generateMatrixTimelineKey()
    const sealed = await sealMatrixTimelineEnvelope({
      plaintext: {
        msgtype: 'm.text',
        body: 'secret result',
        'io.codever': {
          version: 2,
          kind: 'session_lifecycle',
          revision: 5,
          revision_epoch: 'revision-epoch-1',
          revision_epoch_generation: 1,
          session_id: 'session-1',
          state: 'idle',
          updated_at: 100,
        },
      },
      timelineKey,
      gatewayPrivateKey: gateway.privateKey,
      gatewayKeyId: gateway.keyId,
      gatewayId: 'gateway-1',
      conversationId: 'conversation-1',
      roomId: '!room:example.org',
      epochId: 'epoch-1',
      sessionId: 'session-1',
      threadRootEventId: '$root:example.org',
      envelopeId: 'delivery-1',
      logicalEventId: 'logical-1',
      now: 100,
    })

    const opened = await openMatrixTimelineEnvelope(sealed, {
      timelineKey,
      gatewayPublicKey: gateway.publicKey,
      expected: {
        gatewayId: 'gateway-1',
        conversationId: 'conversation-1',
        roomId: '!room:example.org',
        epochId: 'epoch-1',
        sessionId: 'session-1',
        threadRootEventId: '$root:example.org',
      },
    })

    expect(opened.plaintext).toMatchObject({ body: 'secret result' })
    expect(opened.envelope.logicalEventId).toBe('logical-1')
  })

  it('rejects a timeline event replayed into another thread', async () => {
    const gateway = await generateDeviceKeyPair()
    const timelineKey = generateMatrixTimelineKey()
    const sealed = await sealMatrixTimelineEnvelope({
      plaintext: { body: 'secret' },
      timelineKey,
      gatewayPrivateKey: gateway.privateKey,
      gatewayKeyId: gateway.keyId,
      gatewayId: 'gateway-1',
      conversationId: 'conversation-1',
      roomId: '!room:example.org',
      epochId: 'epoch-1',
      sessionId: 'session-1',
      threadRootEventId: '$root:example.org',
    })

    await expect(openMatrixTimelineEnvelope(sealed, {
      timelineKey,
      gatewayPublicKey: gateway.publicKey,
      expected: {
        gatewayId: 'gateway-1',
        conversationId: 'conversation-1',
        roomId: '!room:example.org',
        epochId: 'epoch-1',
        sessionId: 'session-1',
        threadRootEventId: '$other:example.org',
      },
    })).rejects.toThrow('threadRootEventId binding does not match')
  })
})
