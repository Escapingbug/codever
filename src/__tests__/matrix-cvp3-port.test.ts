import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CODEVER_MATRIX_EXTENSION, cvp3ProjectKeyGrantStateSchema } from '@codever/protocol'
import {
  base64UrlDecode,
  exportDeviceKeyPair,
  generateDeviceKeyPair,
  openCvp3Envelope,
  openCvp3ProjectKeyGrant,
} from '@codever/security'
import { InMemoryMatrixTransport, MatrixCvp3Port } from '@/channel/matrix'
import { GatewayCvp3ContentLayer } from '@/gateway/matrix/cvp3Content'
import { gatewayProjectIdentity } from '@/gateway/matrix/project'

describe('MatrixCvp3Port', () => {
  it('projects logical message versions while treating Matrix replacement as an optional hint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codever-v3-port-'))
    const gateway = await generateDeviceKeyPair()
    const phone = await generateDeviceKeyPair()
    const room = {
      roomId: '!project:example.org',
      conversationId: 'unused-v3',
      cwd: '/repo',
      providerName: 'test',
    }
    const contentLayer = new GatewayCvp3ContentLayer('workspace-1', {
      gatewayDeviceId: 'workspace-1',
      gatewayKeyPair: await exportDeviceKeyPair(gateway),
      envelopeReplayLedgerPath: join(directory, 'security'),
    }, [{
      deviceId: 'phone-1',
      publicKey: phone.publicJwk,
      allowedRoomIds: [room.roomId],
      allowedOperations: ['prompt'],
      matrixUserId: '@owner:example.org',
      matrixDeviceId: 'PHONE',
      matrixDeviceKeys: ['matrix-phone-key'],
      certificateExpiresAt: Date.now() + 60_000,
      sequenceEpoch: 'certificate-1',
    }])
    await contentLayer.initialize()
    const transport = new InMemoryMatrixTransport()
    await contentLayer.provisionProject(room, transport)
    const grantState = [...transport.state.values()][0]
    const grant = cvp3ProjectKeyGrantStateSchema.parse(grantState?.content)
    const keyGrant = await openCvp3ProjectKeyGrant(grant.sealedGrant, {
      expected: {
        grantId: grant.grantId,
        workspaceId: grant.workspaceId,
        projectId: grant.projectId,
        roomId: grant.roomId,
        deviceId: grant.deviceId,
        certificateId: grant.certificateId,
        senderKeyId: grant.sealedGrant.envelope.senderKeyId,
        recipientKeyId: grant.sealedGrant.envelope.recipientKeyId,
      },
      recipientPrivateKey: phone.privateKey,
      senderPublicKey: gateway.publicKey,
    })
    const projectKey = keyGrant.keys.find(key => key.keyId === keyGrant.activeKeyId)!
    const port = new MatrixCvp3Port({
      contentLayer,
      transport,
      room,
      workspaceId: 'workspace-1',
      projectId: gatewayProjectIdentity(room.cwd).id,
      sessionId: 'session-1',
      threadRootEventId: '$root:example.org',
      projection: () => ({
        title: 'Session',
        lifecycle: 'active',
        activity: 'working',
        updatedAt: 1,
        stateVersion: 1,
      }),
      now: () => 1,
    })

    const sent = await port.send({
      text: 'first',
      format: 'markdown',
      replyMarkup: { idempotencyKey: 'logical-message-1' },
    })
    expect(sent.messageId).toBe('logical-message-1')
    await port.edit('logical-message-1', {
      text: 'updated',
      format: 'markdown',
      replyMarkup: { idempotencyKey: 'logical-update-1' },
    }, { terminal: true })

    const opened = await Promise.all(transport.delivered.map(async delivery => {
      const extension = delivery.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
      return openCvp3Envelope(extension.envelope, {
        projectKey: base64UrlDecode(projectKey.key),
        roomId: room.roomId,
        projectId: grant.projectId,
        keyId: projectKey.keyId,
      })
    }))
    expect(opened.map(item => item.plaintext.kind === 'signed_event'
      ? item.plaintext.value.event.payload
      : null)).toMatchObject([
      { type: 'assistant.message', messageId: 'logical-message-1', messageVersion: 1, body: 'first' },
      { type: 'assistant.message', messageId: 'logical-message-1', messageVersion: 2, body: 'updated' },
    ])
    expect(transport.delivered[0]?.content['m.relates_to']).toMatchObject({
      rel_type: 'm.thread',
      event_id: '$root:example.org',
    })
    expect(transport.delivered[1]?.content['m.relates_to']).toEqual({
      rel_type: 'm.replace',
      event_id: transport.delivered[0]?.eventId,
    })
  })
})
