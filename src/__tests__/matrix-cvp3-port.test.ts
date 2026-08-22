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
import { ChannelProjector } from '@/runtime/channelProjector'
import { MatrixCvp3Projection } from '../../apps/pwa/app/matrixCvp3Projection'
import { toIncomingMessage } from '../../apps/pwa/app/matrixCvp3Connection'

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

    const response = port.requestExtensionInteraction({
      extension: { id: 'prefix-transform', name: 'Prefix transform', version: '1' },
      cancelActionId: 'cancel',
      view: {
        version: 1,
        title: 'Review transformed input',
        elements: [{ type: 'readonly_textarea', label: 'Agent input', value: 'SAFE: hello' }],
        actions: [
          { id: 'continue', label: 'Continue', style: 'primary' },
          { id: 'cancel', label: 'Cancel', style: 'secondary' },
        ],
      },
    })
    await waitFor(() => transport.delivered.length === 3)
    const interactionExtension = transport.delivered[2]
      ?.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
    const interaction = await openCvp3Envelope(interactionExtension.envelope, {
      projectKey: base64UrlDecode(projectKey.key),
      roomId: room.roomId,
      projectId: grant.projectId,
      keyId: projectKey.keyId,
    })
    if (interaction.plaintext.kind !== 'signed_event') throw new Error('expected event')
    expect(interaction.plaintext.value.event.payload).toMatchObject({
      type: 'extension.interaction.requested',
      extension: { id: 'prefix-transform' },
      cancelActionId: 'cancel',
    })
    const requestId = interaction.plaintext.value.event.payload.type === 'extension.interaction.requested'
      ? interaction.plaintext.value.event.payload.requestId
      : ''
    expect(port.resolveDecision(requestId, 'continue')).toEqual({
      kind: 'extension',
      extensionId: 'prefix-transform',
    })
    await expect(response).resolves.toEqual({ value: 'continue' })

    const privilegeResponse = port.requestDecision({
      type: 'privilege',
      title: 'Allow remote administrator execution?',
      details: 'Command:\n/usr/bin/id -u',
      options: [
        { label: 'Unlock and allow once', value: 'allow_once' },
        { label: 'Deny', value: 'deny' },
      ],
    })
    await waitFor(() => transport.delivered.length === 4)
    const privilegeExtension = transport.delivered[3]
      ?.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
    const privilegeEvent = await openCvp3Envelope(privilegeExtension.envelope, {
      projectKey: base64UrlDecode(projectKey.key),
      roomId: room.roomId,
      projectId: grant.projectId,
      keyId: projectKey.keyId,
    })
    if (privilegeEvent.plaintext.kind !== 'signed_event') throw new Error('expected event')
    expect(privilegeEvent.plaintext.value.event.payload).toMatchObject({
      type: 'decision.requested',
      decisionType: 'privilege',
      details: 'Command:\n/usr/bin/id -u',
      options: [
        { label: 'Unlock and allow once', value: 'allow_once' },
        { label: 'Deny', value: 'deny' },
      ],
    })
    const privilegeRequestId = privilegeEvent.plaintext.value.event.payload.type
      === 'decision.requested'
      ? privilegeEvent.plaintext.value.event.payload.requestId
      : ''
    expect(port.decisionType(privilegeRequestId)).toBe('privilege')
    expect(port.resolveDecision(privilegeRequestId, 'allow')).toBeNull()
    expect(port.resolveDecision(privilegeRequestId, 'allow_once')).toBeNull()
    expect(port.resolveDecision(privilegeRequestId, 'allow_once', '123456')).toEqual({
      kind: 'decision',
      decisionType: 'privilege',
    })
    await expect(privilegeResponse).resolves.toEqual({ value: 'allow_once', totp: '123456' })

    const expiredPrivilegeResponse = port.requestDecision({
      type: 'privilege',
      title: 'Expiring root request',
      options: [
        { label: 'Allow once', value: 'allow_once' },
        { label: 'Deny', value: 'deny' },
      ],
      expiresAt: Date.now() + 10,
    })
    await expect(expiredPrivilegeResponse).resolves.toEqual({ value: 'deny' })
    await waitFor(() => transport.delivered.length === 6)
    const expiredExtension = transport.delivered[5]
      ?.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
    const expiredEvent = await openCvp3Envelope(expiredExtension.envelope, {
      projectKey: base64UrlDecode(projectKey.key),
      roomId: room.roomId,
      projectId: grant.projectId,
      keyId: projectKey.keyId,
    })
    if (expiredEvent.plaintext.kind !== 'signed_event') throw new Error('expected event')
    expect(expiredEvent.plaintext.value.event.payload).toMatchObject({
      type: 'decision.resolved',
      decision: 'deny',
    })

    const projector = new ChannelProjector()
    const [projectedTool] = projector.project({
      kind: 'tool',
      meta: {
        id: 'turn-1:tool:read-1:1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        provider: 'acp',
        seq: 1,
        timestamp: 1,
        sourcePhase: 'live',
      },
      phase: 'completed',
      toolCallId: 'read-1',
      toolName: 'Read',
      category: 'read',
      input: { file_path: '/repo/src/index.ts' },
    }, { verboseLevel: 2 })
    await port.send({
      ...projectedTool!.message,
      replyMarkup: { idempotencyKey: 'tool-message-1' },
    })
    const toolDelivery = transport.delivered[6]!
    const toolExtension = toolDelivery.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
    const toolEnvelope = await openCvp3Envelope(toolExtension.envelope, {
      projectKey: base64UrlDecode(projectKey.key),
      roomId: room.roomId,
      projectId: grant.projectId,
      keyId: projectKey.keyId,
    })
    if (toolEnvelope.plaintext.kind !== 'signed_event') throw new Error('expected event')
    const pwaProjection = new MatrixCvp3Projection()
    pwaProjection.applyEvent(toolEnvelope.plaintext.value.event, toolDelivery.eventId)
    const pwaMessage = pwaProjection.messages.get('assistant:tool-message-1:0')
    expect(pwaMessage).toBeDefined()
    expect(toIncomingMessage(pwaMessage!)).toMatchObject({
      kind: 'tool',
      toolGroup: {
        groupId: 'read-1',
        tools: [{ name: 'Read', category: 'read', phase: 'completed' }],
      },
    })

    const longToolStart = transport.delivered.length
    await port.send({
      ...projectedTool!.message,
      text: `${'x'.repeat(8 * 1024)}尾`,
      format: 'plain',
      replyMarkup: { idempotencyKey: 'long-tool-message-1' },
    })
    const longToolPayloads = await Promise.all(
      transport.delivered.slice(longToolStart).map(async delivery => {
        const extension = delivery.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
        const envelope = await openCvp3Envelope(extension.envelope, {
          projectKey: base64UrlDecode(projectKey.key),
          roomId: room.roomId,
          projectId: grant.projectId,
          keyId: projectKey.keyId,
        })
        if (envelope.plaintext.kind !== 'signed_event') throw new Error('expected event')
        return envelope.plaintext.value.event.payload
      }),
    )
    expect(longToolPayloads).toHaveLength(2)
    expect(longToolPayloads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'assistant.message',
        partIndex: 0,
        partCount: 2,
        ui: expect.objectContaining({ kind: 'tool_group', groupId: 'read-1' }),
      }),
      expect.objectContaining({
        type: 'assistant.message',
        partIndex: 1,
        partCount: 2,
        body: '尾',
        ui: expect.objectContaining({ kind: 'tool_group', groupId: 'read-1' }),
      }),
    ]))

    await port.send({
      text: 'short',
      format: 'markdown',
      replyMarkup: { idempotencyKey: 'growing-agent-message' },
    })
    const growingStart = transport.delivered.length
    await port.edit('growing-agent-message', {
      text: `${'A'.repeat(8 * 1024)}Markdown tail`,
      format: 'markdown',
      replyMarkup: { idempotencyKey: 'growing-agent-message' },
    }, { terminal: true })
    const growingPayloads = await Promise.all(
      transport.delivered.slice(growingStart).map(async delivery => {
        const extension = delivery.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown>
        const envelope = await openCvp3Envelope(extension.envelope, {
          projectKey: base64UrlDecode(projectKey.key),
          roomId: room.roomId,
          projectId: grant.projectId,
          keyId: projectKey.keyId,
        })
        if (envelope.plaintext.kind !== 'signed_event') throw new Error('expected event')
        return envelope.plaintext.value.event.payload
      }),
    )
    expect(growingPayloads).toMatchObject([
      {
        type: 'assistant.message',
        messageId: 'growing-agent-message',
        messageVersion: 2,
        partIndex: 0,
        partCount: 2,
      },
      {
        type: 'assistant.message',
        messageId: 'growing-agent-message',
        messageVersion: 1,
        partIndex: 1,
        partCount: 2,
        body: 'Markdown tail',
      },
    ])
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`)
}
