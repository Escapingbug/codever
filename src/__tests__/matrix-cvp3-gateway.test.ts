import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CODEVER_MATRIX_EXTENSION,
  CVP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE,
  CVP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE,
  cvp3CurrentPointerSchema,
  cvp3ProjectKeyGrantStateSchema,
  type Cvp3Command,
  type SessionExtensionDescriptor,
} from '@codever/protocol'
import {
  base64UrlDecode,
  exportDeviceKeyPair,
  generateDeviceKeyPair,
  openCvp3Envelope,
  openCvp3ProjectKeyGrant,
  sealCvp3Envelope,
  signCvp3Command,
} from '@codever/security'
import {
  InMemoryMatrixTransport,
  type MatrixIncomingEvent,
} from '@/channel/matrix'
import type {
  MatrixGatewayClient,
  MatrixGatewayEventListener,
} from '@/gateway/matrix/client'
import type { MatrixGatewayConfig, MatrixGatewayCryptoConfig } from '@/gateway/matrix/config'
import { MatrixCvp3GatewayRunner } from '@/gateway/matrix/cvp3Gateway'
import { gatewayProjectIdentity } from '@/gateway/matrix/project'
import type { GatewayWebPushService } from '@/gateway/matrix/webPush'
import { createTopicSessionRecord } from '@/bridge/topicSession'
import type { TopicSession } from '@/bridge/channelPort'
import { registerProvider } from '@/providers/registry'
import {
  normalizeDeclarativeExtensionConfig,
  SessionExtensionRegistry,
  type SessionExtensionProvider,
} from '@/runtime/sessionExtensions'

class TestMatrixClient extends InMemoryMatrixTransport implements MatrixGatewayClient {
  private readonly listeners = new Set<MatrixGatewayEventListener>()
  initializeCrypto(_config: MatrixGatewayCryptoConfig): Promise<void> { return Promise.resolve() }
  onRoomEvent(listener: MatrixGatewayEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  start(): Promise<void> { return Promise.resolve() }
  waitUntilReady(): Promise<void> { return Promise.resolve() }
  assertRoomEncrypted(): Promise<void> { return Promise.resolve() }
  pinTrustedDevices(): Promise<void> { return Promise.resolve() }
  prepareRoomThread(): Promise<void> { return Promise.resolve() }
  stop(): Promise<void> { return Promise.resolve() }
  emit(event: MatrixIncomingEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

describe('MatrixCvp3GatewayRunner', () => {
  it('starts without a recipient so the first device can pair', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codever-v3-empty-gateway-'))
    const gatewayKeys = await generateDeviceKeyPair()
    const client = new TestMatrixClient()
    const roomId = '!empty-project:example.org'
    const runner = new MatrixCvp3GatewayRunner({
      gatewayId: 'workspace-empty',
      connection: {
        baseUrl: 'https://matrix.example.org',
        accessToken: 'gateway-token',
        userId: '@gateway:example.org',
        deviceId: 'GATEWAY',
      },
      crypto: {
        backend: 'memory',
        databasePrefix: 'empty-test',
        allowInMemoryForTesting: true,
      },
      rooms: [{
        roomId,
        conversationId: roomId,
        cwd: '/empty-repo',
        providerName: 'test',
      }],
      trustedDevices: [],
      replayLedgerPath: join(directory, 'replay'),
      applicationSecurity: {
        gatewayDeviceId: 'workspace-empty',
        gatewayKeyPair: await exportDeviceKeyPair(gatewayKeys),
        envelopeReplayLedgerPath: join(directory, 'security'),
      },
    }, {
      client,
      listTrustedDevices: async () => [],
    })

    await expect(runner.start()).resolves.toBeUndefined()
    expect(runner.getState()).toBe('running')
    expect(client.delivered).toHaveLength(0)
    expect(client.state.size).toBe(0)
    await runner.stop()
  })

  it('runs session threads independently and deduplicates by logical command identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codever-v3-gateway-'))
    const gatewayKeys = await generateDeviceKeyPair()
    const phoneKeys = await generateDeviceKeyPair()
    const client = new TestMatrixClient()
    const roomId = '!project:example.org'
    const projectId = gatewayProjectIdentity('/repo').id
    const config: MatrixGatewayConfig = {
      gatewayId: 'workspace-1',
      connection: {
        baseUrl: 'https://matrix.example.org',
        accessToken: 'gateway-token',
        userId: '@gateway:example.org',
        deviceId: 'GATEWAY',
      },
      crypto: {
        backend: 'memory',
        databasePrefix: 'test',
        allowInMemoryForTesting: true,
      },
      rooms: [
        {
          roomId: '!unpaired-project:example.org',
          conversationId: 'unpaired-v3',
          cwd: '/unpaired-repo',
          providerName: 'test',
        },
        {
          roomId,
          conversationId: 'unused-v3',
          cwd: '/repo',
          providerName: 'test',
        },
      ],
      trustedDevices: [{
        deviceId: 'phone-1',
        publicKey: phoneKeys.publicJwk,
        allowedRoomIds: [roomId],
        allowedOperations: [
          'prompt',
          'cancel',
          'decision',
          'session.settings',
          'session.create',
          'session.archive',
          'session.restore',
          'session.delete',
          'project.settings',
          'provider.sessions.list',
          'provider.session.inspect',
        ],
        matrixUserId: '@phone:example.org',
        matrixDeviceId: 'PHONE',
        matrixDeviceKeys: ['matrix-phone-key'],
        certificateExpiresAt: Date.now() + 60_000,
        sequenceEpoch: 'certificate-1',
      }],
      replayLedgerPath: join(directory, 'replay'),
      applicationSecurity: {
        gatewayDeviceId: 'workspace-1',
        gatewayKeyPair: await exportDeviceKeyPair(gatewayKeys),
        envelopeReplayLedgerPath: join(directory, 'security'),
      },
    }
    const blocked = deferred<void>()
    const dispatched: Array<{ sessionId: string; text: string }> = []
    const sessionExtensions = new Map<string, readonly { id: string }[]>()
    const sessionCwds = new Map<string, string>()
    const rejected: unknown[] = []
    const notificationSubscriptions: string[] = []
    const terminalNotifications: string[] = []
    const webPushService: GatewayWebPushService = {
      initialize: async () => undefined,
      publicKey: () => 'B'.repeat(87),
      async upsertSubscription(deviceId, subscription) {
        notificationSubscriptions.push(`${deviceId}:${subscription.endpoint}`)
      },
      removeSubscription: async () => undefined,
      async notifyTerminal(event) {
        if (event.payload.type === 'turn.completed' || event.payload.type === 'turn.failed') {
          terminalNotifications.push(event.eventId)
        }
      },
      flush: async () => undefined,
      stop: () => undefined,
    }
    registerProvider({
      name: 'test',
      startQuery() { throw new Error('The catalog provider must not execute a query') },
      isReady: () => true,
      getInitError: () => null,
      getAvailableModels: () => [{
        id: 'model-selectable',
        name: 'Selectable model',
        defaultReasoningLevel: 'high',
        supportedReasoningLevels: [{ effort: 'high' }],
      }],
      getAvailablePermissionModes: () => ['default'],
      listSessions: async () => [{
        sessionId: 'provider-session-1',
        title: 'Provider-owned work',
        updated: 42,
        cwd: '/repo',
      }],
      getSessionHistory: async sessionId => ({
        sessionId,
        title: 'Provider-owned work',
        messages: [
          { id: 'provider-message-1', role: 'user', text: 'Earlier prompt' },
          { id: 'provider-message-2', role: 'assistant', text: 'Earlier answer' },
        ],
      }),
    })
    const extensionDescriptor: SessionExtensionDescriptor = {
      id: 'prefix-transform',
      name: 'Prefix transform',
      description: 'Adds a test prefix before provider input.',
      version: '1',
      settings: [{ id: 'prefix', type: 'text', label: 'Prefix', required: true }],
    }
    const extensionProvider: SessionExtensionProvider = {
      descriptor: extensionDescriptor,
      normalizeConfig: config => normalizeDeclarativeExtensionConfig(extensionDescriptor, config),
      create: binding => ({
        id: binding.id,
        summary: { id: binding.id, name: extensionDescriptor.name, version: '1' },
        prepareTurn: async input => ({ kind: 'ready', input }),
        presentEvent: async event => [event],
        lifecycle: async () => undefined,
      }),
    }
    const runner = new MatrixCvp3GatewayRunner(config, {
      client,
      onRejected: (_event, error) => rejected.push(error),
      webPushService,
      sessionExtensionRegistry: new SessionExtensionRegistry([extensionProvider]),
      sessionFactory: (room, port, session) => {
        sessionExtensions.set(session.id, session.extensions)
        sessionCwds.set(session.id, room.cwd)
        const sessionRecord = createTopicSessionRecord({
          id: session.id,
          cwd: room.cwd,
          providerName: session.provider,
          groupChatId: -1,
        })
        let dead = false
        return {
          receiveInput: () => undefined,
          async dispatch(input) {
            if (input.kind === 'user_message') {
              dispatched.push({ sessionId: session.id, text: input.text })
              if (input.text === 'block A') await blocked.promise
              await port.send({
                text: `reply:${input.text}`,
                format: 'markdown',
                replyMarkup: { idempotencyKey: `reply-${session.id}-${input.text}` },
              })
            }
          },
          async destroy() { dead = true },
          get state() { return dead ? 'dead' : 'idle' },
          sessionRecord,
          channelPort: port,
          getProgress: () => null,
          getDeliveryStatus: () => ({ deliveries: [] }),
          retryDelivery: async () => ({ status: 'not_found' as const }),
        } satisfies TopicSession
      },
    })
    await runner.start()

    const grantState = [...client.state.values()].find(state =>
      state.eventType === CVP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE
    )
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
      recipientPrivateKey: phoneKeys.privateKey,
      senderPublicKey: gatewayKeys.publicKey,
    })
    const activeKey = keyGrant.keys.find(key => key.keyId === keyGrant.activeKeyId)!
    const startupEvents = await events(client, activeKey.key, roomId, projectId)
    expect(startupEvents).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        type: 'workspace.snapshot',
        capabilities: expect.objectContaining({
          models: [expect.objectContaining({ id: 'model-selectable' })],
          web_push: { vapid_public_key: 'B'.repeat(87) },
        }),
      }),
    }))
    const workspacePointerState = [...client.state.values()].find(state =>
      state.eventType === CVP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE
    )
    expect(cvp3CurrentPointerSchema.parse(workspacePointerState?.content).document)
      .toMatchObject({
        kind: 'workspace.current',
        workspaceId: 'workspace-1',
        projectId,
        roomId,
      })

    await expect(runner.publishNativeClientRelease(nativeRelease(42))).resolves.toMatchObject({
      changed: true,
      projectCount: 1,
      release: { versionCode: 42 },
    })
    const publishedWorkspace = (await events(client, activeKey.key, roomId, projectId))
      .filter(event => event.payload.type === 'workspace.snapshot')
      .at(-1)
    expect(publishedWorkspace?.payload).toMatchObject({
      type: 'workspace.snapshot',
      clientReleases: [{
        platform: 'android',
        channel: 'alpha',
        versionCode: 42,
      }],
    })

    const inboxPath = join(directory, 'workspace-report.txt')
    await writeFile(inboxPath, 'workspace report', 'utf8')
    await expect(runner.receiveWorkspaceFile({
      requestId: 'workspace-file-request-1',
      path: inboxPath,
      caption: 'Generated report',
      sourceLabel: 'review-agent',
    })).resolves.toMatchObject({ delivery: 'queued' })
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.payload.type === 'inbox.file.received'))
    expect(client.delivered.some(delivery =>
      delivery.roomId === '!unpaired-project:example.org'
      && delivery.content[CODEVER_MATRIX_EXTENSION]
    )).toBe(false)
    const inboxEvent = (await events(client, activeKey.key, roomId, projectId))
      .find(event => event.payload.type === 'inbox.file.received')
    expect(inboxEvent?.sessionId).toBeUndefined()
    expect(inboxEvent?.payload).toMatchObject({
      type: 'inbox.file.received',
      fileId: 'workspace-file-request-1',
    })

    const send = async (
      command: Cvp3Command,
      matrixEventId: string,
      relation?: Record<string, unknown>,
      sender = '@phone:example.org',
    ) => {
      const signed = await signCvp3Command(command, phoneKeys.privateKey, phoneKeys.keyId)
      const envelope = await sealCvp3Envelope({
        plaintext: { kind: 'signed_command', value: signed },
        projectKey: base64UrlDecode(activeKey.key),
        roomId,
        projectId,
        keyId: activeKey.keyId,
        logicalEventId: command.commandId,
      })
      client.emit({
        roomId,
        eventId: matrixEventId,
        eventType: 'm.room.message',
        sender,
        encrypted: false,
        content: {
          msgtype: 'm.notice',
          body: 'Encrypted Codever command',
          ...(relation ? { 'm.relates_to': relation } : {}),
          [CODEVER_MATRIX_EXTENSION]: { version: 3, envelope },
        },
      })
    }
    const base = {
      kind: 'codever.command' as const,
      version: 3 as const,
      workspaceId: 'workspace-1',
      projectId,
      deviceId: 'phone-1',
      certificateId: 'certificate-1',
      createdAt: 1,
    }
    await send({
      ...base,
      commandId: 'provider-list-1',
      operation: 'provider.sessions.list',
      payload: { operation: 'provider.sessions.list', provider: 'test' },
    }, '$provider-list-1')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'provider-list-1'))
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'provider-list-1'
      && event.payload.type === 'provider.sessions.listed'
    )?.payload).toMatchObject({
      type: 'provider.sessions.listed',
      sessions: [{ sessionId: 'provider-session-1' }],
    })

    await send({
      ...base,
      commandId: 'provider-inspect-1',
      operation: 'provider.session.inspect',
      payload: {
        operation: 'provider.session.inspect',
        provider: 'test',
        providerSessionId: 'provider-session-1',
      },
    }, '$provider-inspect-1')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'provider-inspect-1'))
    const inspectedHistory = (await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'provider-inspect-1'
      && event.payload.type === 'provider.session.inspected'
    )?.payload
    expect(inspectedHistory).toMatchObject({
      type: 'provider.session.inspected',
    })
    if (inspectedHistory?.type !== 'provider.session.inspected') {
      throw new Error('Provider history inspection did not complete')
    }
    expect(inspectedHistory.messages).toHaveLength(2)
    expect(inspectedHistory.messages[0]).toMatchObject({
      role: 'user',
      text: 'Earlier prompt',
    })

    await send({
      ...base,
      commandId: 'notification-subscribe-1',
      operation: 'notification.subscribe',
      payload: {
        operation: 'notification.subscribe',
        subscription: {
          endpoint: 'https://push.example.test/subscriptions/browser-1',
          keys: { p256dh: 'A'.repeat(88), auth: 'B'.repeat(22) },
        },
      },
    }, '$notification-subscribe-1')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event =>
        event.causationCommandId === 'notification-subscribe-1'
        && event.payload.type === 'notification.subscription.changed'
      ))
    expect(notificationSubscriptions).toEqual([
      'phone-1:https://push.example.test/subscriptions/browser-1',
    ])
    await send({
      ...base,
      commandId: 'project-defaults-1',
      operation: 'project.update',
      payload: {
        operation: 'project.update',
        patch: {
          defaultExtensions: [{ id: 'prefix-transform', config: { prefix: 'SAFE:' } }],
        },
      },
    }, '$project-defaults-1')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'project-defaults-1'))
    const createA: Cvp3Command = {
      ...base,
      commandId: 'create-a',
      sessionId: 'session-a',
      operation: 'session.create',
      payload: {
        operation: 'session.create',
        title: 'A',
        providerSessionId: 'provider-session-1',
      },
    }
    await send(createA, '$root-a-forged-sender', undefined, '@intruder:example.org')
    await waitFor(() => Promise.resolve(rejected.length === 1))
    expect(dispatched).toEqual([])
    await send(createA, '$root-a')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'create-a'))
    expect(sessionExtensions.get('session-a')).toEqual([{
      id: 'prefix-transform',
      config: { prefix: 'SAFE:' },
    }])
    await send({
      ...base,
      commandId: 'provider-list-managed',
      operation: 'provider.sessions.list',
      payload: { operation: 'provider.sessions.list', provider: 'test' },
    }, '$provider-list-managed')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'provider-list-managed'))
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'provider-list-managed'
      && event.payload.type === 'provider.sessions.listed'
    )?.payload).toMatchObject({
      sessions: [{
        sessionId: 'provider-session-1',
        managedSessionId: 'session-a',
      }],
    })

    await send({
      ...base,
      commandId: 'create-scratch',
      sessionId: 'session-scratch',
      operation: 'session.create',
      payload: { operation: 'session.create', scope: 'scratch', title: 'Temporary' },
    }, '$root-scratch')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'create-scratch'))
    const scratchCwd = sessionCwds.get('session-scratch')
    expect(scratchCwd).toBeTruthy()
    expect(scratchCwd).not.toBe('/repo')
    await expect(stat(scratchCwd!)).resolves.toMatchObject({})

    const promptA: Cvp3Command = {
      ...base,
      commandId: 'prompt-a',
      sessionId: 'session-a',
      operation: 'prompt.submit',
      payload: { operation: 'prompt.submit', text: 'block A' },
    }
    await send(promptA, '$prompt-a', {
      rel_type: 'm.thread',
      event_id: '$homeserver-rewrote-this-relation',
    })
    await waitFor(() => Promise.resolve(dispatched.some(item => item.text === 'block A')))

    await send({
      ...base,
      commandId: 'create-b',
      sessionId: 'session-b',
      operation: 'session.create',
      payload: { operation: 'session.create', title: 'B' },
    }, '$root-b')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'create-b'))

    // An exact retry arrives as a different physical Matrix event. It remains
    // the same business command and must not run a second provider turn.
    await send(promptA, '$prompt-a-retry')
    blocked.resolve()
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event =>
        event.causationCommandId === 'prompt-a'
        && event.payload.type === 'turn.completed'
      ))
    expect(dispatched.filter(item => item.text === 'block A')).toHaveLength(1)
    expect(terminalNotifications).toHaveLength(1)

    // A cancel can race a completion or arrive from a stale client after a
    // Gateway restart. It must converge the client to idle instead of leaving
    // an unrecoverable "not active" command failure.
    await send({
      ...base,
      commandId: 'cancel-settled-a',
      sessionId: 'session-a',
      operation: 'turn.cancel',
      payload: { operation: 'turn.cancel', turnId: 'prompt-a' },
    }, '$cancel-settled-a')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event =>
        event.causationCommandId === 'cancel-settled-a'
        && event.payload.type === 'turn.completed'
      ))
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'cancel-settled-a'
      && event.payload.type === 'turn.completed'
    )?.payload).toMatchObject({
      type: 'turn.completed',
      turnId: 'prompt-a',
      outcome: 'cancelled',
      projection: { activity: 'idle' },
    })

    await send({
      ...base,
      commandId: 'archive-a',
      sessionId: 'session-a',
      operation: 'session.set_lifecycle',
      payload: { operation: 'session.set_lifecycle', state: 'archived' },
    }, '$archive-a')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'archive-a'))
    await send({
      ...base,
      commandId: 'provider-list-after-archive',
      operation: 'provider.sessions.list',
      payload: { operation: 'provider.sessions.list', provider: 'test' },
    }, '$provider-list-after-archive')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'provider-list-after-archive'))
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'provider-list-after-archive'
      && event.payload.type === 'provider.sessions.listed'
    )?.payload).toMatchObject({ sessions: [{ sessionId: 'provider-session-1' }] })
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'provider-list-after-archive'
      && event.payload.type === 'provider.sessions.listed'
    )?.payload).not.toEqual(expect.objectContaining({
      sessions: [expect.objectContaining({ managedSessionId: 'session-a' })],
    }))
    await runner.stop()

    const eventIdsBeforeRestart = new Set(
      (await events(client, activeKey.key, roomId, projectId)).map(event => event.eventId),
    )
    const restarted = new MatrixCvp3GatewayRunner(config, {
      client,
      webPushService,
      sessionExtensionRegistry: new SessionExtensionRegistry([extensionProvider]),
      sessionFactory: (room, port, session) => {
        const sessionRecord = createTopicSessionRecord({
          id: session.id,
          cwd: room.cwd,
          providerName: session.provider,
          groupChatId: -1,
        })
        return {
          receiveInput: () => undefined,
          dispatch: async () => undefined,
          destroy: async () => undefined,
          state: 'idle',
          sessionRecord,
          channelPort: port,
          getProgress: () => null,
          getDeliveryStatus: () => ({ deliveries: [] }),
          retryDelivery: async () => ({ status: 'not_found' as const }),
        } satisfies TopicSession
      },
    })
    await restarted.start()
    await waitFor(async () => {
      const recovered = (await events(client, activeKey.key, roomId, projectId)).filter(event =>
        !eventIdsBeforeRestart.has(event.eventId)
        && event.payload.type === 'session.ready'
      )
      return recovered.some(event => event.sessionId === 'session-b')
        && recovered.some(event => event.sessionId === 'session-scratch')
    })
    const recovered = (await events(client, activeKey.key, roomId, projectId)).filter(event =>
      !eventIdsBeforeRestart.has(event.eventId)
      && event.payload.type === 'session.ready'
    )
    expect(recovered.map(event => event.sessionId).sort()).toEqual([
      'session-b',
      'session-scratch',
    ])
    expect(recovered.every(event =>
      event.payload.type === 'session.ready'
      && event.payload.projection.activity === 'idle'
    )).toBe(true)
    await restarted.stop()
  })
})

function nativeRelease(versionCode: number) {
  return {
    platform: 'android' as const,
    channel: 'alpha',
    architecture: 'arm64-v8a' as const,
    packageName: 'id.my.anciety.codever',
    versionCode,
    versionName: `0.1.0-alpha.${versionCode}`,
    buildId: `android-alpha-${versionCode}`,
    publishedAt: 1_787_400_000_000 + versionCode,
    minimumAndroid: 31,
    nativeBridgeMinimum: 1,
    nativeBridgeMaximum: 1,
    importance: 'recommended' as const,
    releaseNotes: ['Gateway-published update'],
    artifact: {
      url: `https://rd.anciety.my.id/native-updates/releases/android/alpha/${versionCode}/codever.apk`,
      size: 1_024,
      sha256: 'a'.repeat(64),
      signingCertificateSha256: 'b'.repeat(64),
    },
  }
}

async function events(
  client: TestMatrixClient,
  key: string,
  roomId: string,
  projectId: string,
) {
  const result = []
  for (const delivery of client.delivered) {
    const extension = delivery.content[CODEVER_MATRIX_EXTENSION] as Record<string, unknown> | undefined
    if (!extension?.envelope) continue
    const opened = await openCvp3Envelope(extension.envelope, {
      projectKey: base64UrlDecode(key),
      roomId,
      projectId,
      keyId: (extension.envelope as { keyId: string }).keyId,
    })
    if (opened.plaintext.kind === 'signed_event') result.push(opened.plaintext.value.event)
  }
  return result
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`)
}
