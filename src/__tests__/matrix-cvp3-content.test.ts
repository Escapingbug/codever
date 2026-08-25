import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
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
import {
  GatewayCvp3ContentLayer,
  MAX_CVP3_MATRIX_TIMELINE_CONTENT_BYTES,
  MatrixCvp3ContentTooLargeError,
} from '@/gateway/matrix/cvp3Content'
import { FileMatrixCvp3Outbox } from '@/gateway/matrix/fileMatrixCvp3Outbox'
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

  it('returns after durable staging while the ordinary chat server is still backpressuring delivery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codever-v3-content-'))
    const gateway = await generateDeviceKeyPair()
    const phone = await generateDeviceKeyPair()
    const room = {
      roomId: '!project:example.org',
      conversationId: 'legacy-conversation-unused',
      cwd: '/repo',
      providerName: 'test',
    }
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
        allowedRoomIds: [room.roomId],
        allowedOperations: ['prompt'],
        matrixUserId: '@owner:example.org',
        matrixDeviceId: 'PHONE',
        matrixDeviceKeys: ['matrix-phone-key'],
        certificateExpiresAt: Date.now() + 60_000,
        sequenceEpoch: 'certificate-1',
      }],
    )
    await layer.initialize()
    let release!: () => void
    let markStarted!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { markStarted = resolve })
    let sends = 0
    const transport = new InMemoryMatrixTransport()
    transport.sendApplicationTimelineEvent = async () => {
      sends += 1
      markStarted()
      await blocked
      return { eventId: '$delivered-after-backpressure' }
    }
    const event: Cvp3Event = {
      kind: 'codever.event',
      version: 3,
      eventId: 'event-under-backpressure',
      workspaceId: 'workspace-1',
      projectId: gatewayProjectIdentity(room.cwd).id,
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

    const queued = await layer.enqueueEvent(room, event, transport)
    await started
    expect(queued.deliveryId).toBeTruthy()
    expect(sends).toBe(1)
    expect(await Promise.race([
      queued.confirmation.then(() => 'delivered'),
      Promise.resolve('staged'),
    ])).toBe('staged')

    const duplicate = await layer.enqueueEvent(room, event, transport)
    expect(duplicate.confirmation).toBe(queued.confirmation)
    expect(sends).toBe(1)

    release()
    await expect(queued.confirmation).resolves.toEqual({
      eventId: '$delivered-after-backpressure',
    })
    await expect(duplicate.confirmation).resolves.toEqual({
      eventId: '$delivered-after-backpressure',
    })

    let retryAttempts = 0
    transport.sendApplicationTimelineEvent = async () => {
      retryAttempts += 1
      if (retryAttempts === 1) throw new Error('ordinary chat server is temporarily unavailable')
      return { eventId: '$delivered-by-durable-retry' }
    }
    const retried = await layer.enqueueEvent(room, {
      ...event,
      eventId: 'event-retried-after-backpressure',
      occurredAt: 2,
    }, transport)
    await expect(retried.confirmation).resolves.toEqual({
      eventId: '$delivered-by-durable-retry',
    })
    expect(retryAttempts).toBe(2)
  })

  it('supersedes stale tool snapshots and delivers terminal control ahead of bulk backlog', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codever-v3-content-'))
    const gateway = await generateDeviceKeyPair()
    const phone = await generateDeviceKeyPair()
    const room = {
      roomId: '!project:example.org',
      conversationId: 'legacy-conversation-unused',
      cwd: '/repo',
      providerName: 'test',
    }
    const layer = new GatewayCvp3ContentLayer('workspace-1', {
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
    await layer.initialize()
    const transport = new InMemoryMatrixTransport()
    await layer.provisionProject(room, transport)

    let release!: () => void
    let markStarted!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const deliveryOrder: string[] = []
    let first = true
    transport.sendApplicationTimelineEvent = async request => {
      const extension = request.content[CODEVER_MATRIX_EXTENSION] as Record<string, any>
      const logicalEventId = extension.envelope.logicalEventId as string
      deliveryOrder.push(logicalEventId)
      if (first) {
        first = false
        markStarted()
        await blocked
      }
      return { eventId: `$${logicalEventId}` }
    }
    const projection = {
      title: 'Session',
      lifecycle: 'active' as const,
      activity: 'working' as const,
      updatedAt: 1,
      stateVersion: 1,
    }
    const assistant = (eventId: string, messageVersion: number): Cvp3Event => ({
      kind: 'codever.event',
      version: 3,
      eventId,
      workspaceId: 'workspace-1',
      projectId: gatewayProjectIdentity(room.cwd).id,
      sessionId: 'session-1',
      occurredAt: messageVersion,
      payload: {
        type: 'assistant.message',
        messageId: 'tool-group-1',
        messageVersion,
        body: `tool snapshot ${messageVersion}`,
        format: 'plain',
        final: false,
        projection,
        ui: { kind: 'tool_group', version: 1, groupId: 'tools', tools: [] },
      },
    })

    const old = await layer.enqueueEvent(room, assistant('bulk-old', 1), transport)
    void old.confirmation.catch(() => undefined)
    await started
    const olderControlIds: string[] = []
    for (let index = 0; index < 10; index += 1) {
      const eventId = `older-turn-started-${index}`
      olderControlIds.push(eventId)
      const queued = await layer.enqueueEvent(room, {
        kind: 'codever.event',
        version: 3,
        eventId,
        workspaceId: 'workspace-1',
        projectId: gatewayProjectIdentity(room.cwd).id,
        sessionId: `older-session-${index}`,
        occurredAt: 2 + index,
        payload: {
          type: 'turn.started',
          turnId: `older-turn-${index}`,
          projection: {
            ...projection,
            stateVersion: 2,
            updatedAt: 2 + index,
          },
        },
      }, transport)
      void queued.confirmation.catch(() => undefined)
    }
    let latest = old
    for (let version = 2; version <= 50; version += 1) {
      const queued = await layer.enqueueEvent(
        room,
        assistant(version === 50 ? 'bulk-latest' : `bulk-stale-${version}`, version),
        transport,
      )
      if (version < 50) void queued.confirmation.catch(() => undefined)
      latest = queued
    }
    const terminal = await layer.enqueueEvent(room, {
      kind: 'codever.event',
      version: 3,
      eventId: 'turn-terminal',
      workspaceId: 'workspace-1',
      projectId: gatewayProjectIdentity(room.cwd).id,
      sessionId: 'session-1',
      occurredAt: 3,
      payload: {
        type: 'turn.completed',
        turnId: 'turn-1',
        outcome: 'cancelled',
        projection: { ...projection, activity: 'idle' },
      },
    }, transport)
    release()

    await expect(terminal.confirmation).resolves.toEqual({ eventId: '$turn-terminal' })
    await expect(latest.confirmation).resolves.toEqual({ eventId: '$bulk-latest' })
    // Forty-eight intermediate progress snapshots never reach Matrix. This is
    // the convergence property that prevents a verbose tool call from turning
    // into minutes of obsolete timeline traffic under homeserver backpressure.
    expect(deliveryOrder).toEqual([
      'bulk-old',
      'turn-terminal',
      ...olderControlIds,
      'bulk-latest',
    ])
  })

  it('migrates a legacy multipart backlog and sends only its newest complete snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codever-v3-content-'))
    const securityPath = join(directory, 'security')
    const outboxPath = `${securityPath}.v3-outbox.jsonl`
    const gateway = await generateDeviceKeyPair()
    const phone = await generateDeviceKeyPair()
    const room = {
      roomId: '!project:example.org',
      conversationId: 'legacy-conversation-unused',
      cwd: '/repo',
      providerName: 'test',
    }
    const config = {
      gatewayDeviceId: 'workspace-1',
      gatewayKeyPair: await exportDeviceKeyPair(gateway),
      envelopeReplayLedgerPath: securityPath,
    }
    const devices = [{
      deviceId: 'phone-1',
      publicKey: phone.publicJwk,
      allowedRoomIds: [room.roomId],
      allowedOperations: ['prompt'],
      matrixUserId: '@owner:example.org',
      matrixDeviceId: 'PHONE',
      matrixDeviceKeys: ['matrix-phone-key'],
      certificateExpiresAt: Date.now() + 60_000,
      sequenceEpoch: 'certificate-1',
    }]
    const first = new GatewayCvp3ContentLayer('workspace-1', config, devices)
    await first.initialize()
    let failedAttempts = 0
    const unavailable = new InMemoryMatrixTransport()
    unavailable.sendApplicationTimelineEvent = async () => {
      failedAttempts += 1
      throw new Error('homeserver unavailable while the old build was running')
    }
    const projection = {
      title: 'Session',
      lifecycle: 'active' as const,
      activity: 'working' as const,
      updatedAt: 1,
      stateVersion: 1,
    }
    const legacyPart = (
      eventId: string,
      messageVersion: number,
      partIndex: number,
      partCount: number,
    ): Cvp3Event => ({
      kind: 'codever.event',
      version: 3,
      eventId,
      workspaceId: 'workspace-1',
      projectId: gatewayProjectIdentity(room.cwd).id,
      sessionId: 'session-1',
      occurredAt: 1,
      payload: {
        type: 'assistant.message',
        messageId: 'tool-group-1',
        messageVersion,
        body: eventId,
        format: 'plain',
        final: false,
        partIndex,
        partCount,
        projection,
        ui: { kind: 'tool_group', version: 1, groupId: 'tools', tools: [] },
      },
    })
    const oldParts = [
      legacyPart('old-part-0', 1, 0, 2),
      legacyPart('old-part-1', 1, 1, 2),
    ]
    // Old APK/Gateway builds versioned each physical part separately. When a
    // snapshot grew, its new tail therefore still carried messageVersion 1.
    const latestParts = [
      legacyPart('latest-part-0', 2, 0, 3),
      legacyPart('latest-part-1', 2, 1, 3),
      legacyPart('latest-part-2', 1, 2, 3),
    ]
    for (const event of [...oldParts, ...latestParts]) {
      try {
        const queued = await first.enqueueEvent(room, event, unavailable)
        void queued.confirmation.catch(() => undefined)
      } catch (error) {
        // The current outbox immediately recognizes the legacy mixed-version
        // tail as obsolete; its WAL pending record is retained below to model
        // how an old build looked before this convergence metadata existed.
        expect((error as Error).name).toBe('MatrixCvp3DeliverySupersededError')
      }
    }
    await waitFor(() => failedAttempts >= 4)
    first.stopRetries()

    // Recreate the pre-migration WAL: old records had neither delivery
    // priority nor a supersession identity, and every staged version remained
    // pending after a homeserver outage.
    const staged = (await readFile(outboxPath, 'utf8'))
      .split(/\r?\n/u)
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, any>)
      .filter(entry => entry.status === 'pending' && entry.delivery?.kind === 'event')
      .map(entry => {
        delete entry.delivery.priority
        delete entry.delivery.supersession
        return JSON.stringify(entry)
      })
    await writeFile(outboxPath, `${staged.join('\n')}\n`, 'utf8')

    const recovered = new GatewayCvp3ContentLayer('workspace-1', config, devices)
    await recovered.initialize()
    const deliveredLogicalIds: string[] = []
    const restoredTransport = new InMemoryMatrixTransport()
    restoredTransport.sendApplicationTimelineEvent = async request => {
      const extension = request.content[CODEVER_MATRIX_EXTENSION] as Record<string, any>
      const logicalEventId = extension.envelope.logicalEventId as string
      deliveredLogicalIds.push(logicalEventId)
      return { eventId: `$${logicalEventId}` }
    }
    await recovered.provisionProject(room, restoredTransport)
    await waitFor(() => deliveredLogicalIds.length === 3)
    recovered.stopRetries()

    expect(deliveredLogicalIds).toEqual(latestParts.map(event => event.eventId))
    const durableWal = await readFile(outboxPath, 'utf8')
    expect(durableWal).toContain('newer_logical_version')
  })

  it('rejects an oversized event before it can poison the durable outbox', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codever-v3-content-'))
    const gateway = await generateDeviceKeyPair()
    const phone = await generateDeviceKeyPair()
    const room = {
      roomId: '!project:example.org',
      conversationId: 'legacy-conversation-unused',
      cwd: '/repo',
      providerName: 'test',
    }
    const layer = new GatewayCvp3ContentLayer('workspace-1', {
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
    await layer.initialize()
    const transport = new InMemoryMatrixTransport()
    await layer.provisionProject(room, transport)

    await expect(layer.sendEvent(room, {
      kind: 'codever.event',
      version: 3,
      eventId: 'oversized-event',
      workspaceId: 'workspace-1',
      projectId: gatewayProjectIdentity(room.cwd).id,
      sessionId: 'session-1',
      occurredAt: 1,
      payload: {
        type: 'assistant.message',
        messageId: 'oversized-message',
        messageVersion: 1,
        body: 'complete textual fallback',
        format: 'plain',
        final: true,
        projection: {
          title: 'Session',
          lifecycle: 'active',
          activity: 'working',
          updatedAt: 1,
          stateVersion: 1,
        },
        ui: { blob: 'x'.repeat(MAX_CVP3_MATRIX_TIMELINE_CONTENT_BYTES) },
      },
    }, transport)).rejects.toBeInstanceOf(MatrixCvp3ContentTooLargeError)
    expect(transport.delivered).toHaveLength(0)
  })

  it('quarantines an oversized legacy delivery and continues with the next event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codever-v3-content-'))
    const securityPath = join(directory, 'security')
    const outboxPath = `${securityPath}.v3-outbox.jsonl`
    const outbox = new FileMatrixCvp3Outbox(outboxPath)
    await outbox.initialize()
    const roomId = '!project:example.org'
    const poison = outbox.createEvent({
      roomId,
      transactionId: 'legacy-poison',
      content: {
        msgtype: 'm.notice',
        body: 'Encrypted Codever event',
        [CODEVER_MATRIX_EXTENSION]: {
          version: 3,
          envelope: { ciphertext: 'x'.repeat(MAX_CVP3_MATRIX_TIMELINE_CONTENT_BYTES) },
        },
      },
      createdAt: 1,
    })
    const valid = outbox.createEvent({
      roomId,
      transactionId: 'valid-after-poison',
      content: { msgtype: 'm.notice', body: 'valid recovered event' },
      createdAt: 2,
    })
    await outbox.stage(poison)
    await outbox.stage(valid)

    const gateway = await generateDeviceKeyPair()
    const phone = await generateDeviceKeyPair()
    const logs: string[] = []
    const layer = new GatewayCvp3ContentLayer('workspace-1', {
      gatewayDeviceId: 'workspace-1',
      gatewayKeyPair: await exportDeviceKeyPair(gateway),
      envelopeReplayLedgerPath: securityPath,
    }, [{
      deviceId: 'phone-1',
      publicKey: phone.publicJwk,
      allowedRoomIds: [roomId],
      allowedOperations: ['prompt'],
      matrixUserId: '@owner:example.org',
      matrixDeviceId: 'PHONE',
      matrixDeviceKeys: ['matrix-phone-key'],
      certificateExpiresAt: Date.now() + 60_000,
      sequenceEpoch: 'certificate-1',
    }], undefined, message => logs.push(message))
    await layer.initialize()
    const transport = new InMemoryMatrixTransport()
    await layer.provisionProject({
      roomId,
      conversationId: 'legacy-conversation-unused',
      cwd: '/repo',
      providerName: 'test',
    }, transport)

    await waitFor(() => transport.delivered.some(delivery =>
      delivery.transactionId === 'valid-after-poison'
    ))
    layer.stopRetries()
    expect(transport.delivered.some(delivery => delivery.transactionId === 'legacy-poison'))
      .toBe(false)
    expect(logs.some(message => message.includes('superseded permanently undeliverable event')))
      .toBe(true)
    expect(await readFile(outboxPath, 'utf8')).toContain('safe limit')
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
