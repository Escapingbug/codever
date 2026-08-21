import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CODEVER_MATRIX_EXTENSION,
  cvp3ProjectKeyGrantStateSchema,
  type Cvp3Event,
} from '@codever/protocol'
import {
  base64UrlDecode,
  exportDeviceKeyPair,
  generateDeviceKeyPair,
  openCvp3ProjectKeyGrant,
  sealCvp3Envelope,
  signCvp3Command,
} from '@codever/security'
import { InMemoryMatrixTransport } from '@/channel/matrix'
import { GatewayCvp3ContentLayer } from '@/gateway/matrix/cvp3Content'
import { gatewayProjectIdentity } from '@/gateway/matrix/project'

describe('GatewayCvp3ContentLayer', () => {
  it('publishes one durable key grant and one project event for every active device set', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codever-v3-content-'))
    const gateway = await generateDeviceKeyPair()
    const phone = await generateDeviceKeyPair()
    const layer = new GatewayCvp3ContentLayer(
      'workspace-1',
      {
        gatewayDeviceId: 'workspace-1',
        gatewayKeyPair: await exportDeviceKeyPair(gateway),
        envelopeReplayLedgerPath: join(directory, 'security'),
      },
      [{
        deviceId: 'phone-1',
        publicKey: phone.publicJwk,
        allowedRoomIds: ['!project:example.org'],
        allowedOperations: ['prompt'],
        matrixUserId: '@owner:example.org',
        matrixDeviceId: 'PHONE',
        matrixDeviceKeys: ['matrix-phone-key'],
        certificateExpiresAt: Date.now() + 60_000,
        sequenceEpoch: 'certificate-1',
      }],
    )
    await layer.initialize()
    const transport = new InMemoryMatrixTransport()
    const room = {
      roomId: '!project:example.org',
      conversationId: 'legacy-conversation-unused',
      cwd: '/repo',
      providerName: 'test',
    }
    await layer.provisionProject(room, transport)
    await layer.provisionProject(room, transport)
    expect(transport.state.size).toBe(1)

    const event: Cvp3Event = {
      kind: 'codever.event',
      version: 3,
      eventId: 'event-1',
      workspaceId: 'workspace-1',
      projectId: gatewayProjectIdentity('/repo').id,
      sessionId: 'session-1',
      occurredAt: 1,
      payload: {
        type: 'session.ready',
        provider: 'test',
        permissionMode: 'default',
        projection: {
          title: 'Session',
          lifecycle: 'active',
          activity: 'idle',
          updatedAt: 1,
          stateVersion: 1,
        },
      },
    }
    await layer.sendEvent(room, event, transport, {
      relation: {
        rel_type: 'm.thread',
        event_id: '$root:example.org',
      },
    })
    expect(transport.delivered).toHaveLength(1)
    expect(transport.delivered[0]?.content['m.relates_to']).toEqual({
      rel_type: 'm.thread',
      event_id: '$root:example.org',
    })
  })

  it('opens a client command from the same project key without comparing Matrix relations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codever-v3-content-'))
    const gateway = await generateDeviceKeyPair()
    const phone = await generateDeviceKeyPair()
    const layer = new GatewayCvp3ContentLayer(
      'workspace-1',
      {
        gatewayDeviceId: 'workspace-1',
        gatewayKeyPair: await exportDeviceKeyPair(gateway),
        envelopeReplayLedgerPath: join(directory, 'security'),
      },
      [{
        deviceId: 'phone-1',
        publicKey: phone.publicJwk,
        allowedRoomIds: ['!project:example.org'],
        allowedOperations: ['prompt'],
        matrixUserId: '@owner:example.org',
        matrixDeviceId: 'PHONE',
        matrixDeviceKeys: ['matrix-phone-key'],
        certificateExpiresAt: Date.now() + 60_000,
        sequenceEpoch: 'certificate-1',
      }],
    )
    await layer.initialize()
    const transport = new InMemoryMatrixTransport()
    const room = {
      roomId: '!project:example.org',
      conversationId: 'legacy-conversation-unused',
      cwd: '/repo',
      providerName: 'test',
    }
    await layer.provisionProject(room, transport)
    const state = [...transport.state.values()][0]
    const grant = cvp3ProjectKeyGrantStateSchema.parse(state?.content)
    const plaintext = await openCvp3ProjectKeyGrant(grant.sealedGrant, {
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
    const projectKey = plaintext.keys.find(key => key.keyId === plaintext.activeKeyId)!
    const signed = await signCvp3Command({
      kind: 'codever.command',
      version: 3,
      commandId: 'command-1',
      workspaceId: 'workspace-1',
      projectId: grant.projectId,
      sessionId: 'session-1',
      deviceId: 'phone-1',
      certificateId: 'certificate-1',
      createdAt: 1,
      operation: 'prompt.submit',
      payload: { operation: 'prompt.submit', text: 'hello' },
    }, phone.privateKey, phone.keyId)
    const envelope = await sealCvp3Envelope({
      plaintext: { kind: 'signed_command', value: signed },
      projectKey: base64UrlDecode(projectKey.key),
      roomId: room.roomId,
      projectId: grant.projectId,
      keyId: projectKey.keyId,
      logicalEventId: 'command-1',
    })
    await expect(layer.openIncoming({ version: 3, envelope }, room)).resolves.toMatchObject({
      command: { commandId: 'command-1' },
      authenticatedDeviceId: 'phone-1',
    })
    const mismatchedEnvelope = await sealCvp3Envelope({
      plaintext: { kind: 'signed_command', value: signed },
      projectKey: base64UrlDecode(projectKey.key),
      roomId: room.roomId,
      projectId: grant.projectId,
      keyId: projectKey.keyId,
      logicalEventId: 'another-command',
    })
    await expect(layer.openIncoming({ version: 3, envelope: mismatchedEnvelope }, room))
      .rejects.toThrow('logical event ID')
  })
})
