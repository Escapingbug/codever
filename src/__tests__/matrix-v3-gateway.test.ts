import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CODEVER_MATRIX_EXTENSION,
  CODEVER_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE,
  CODEVER_MATRIX_WORKSPACE_POINTER_EVENT_TYPE,
  codeverV3CurrentPointerSchema,
  codeverV3ProjectKeyGrantStateSchema,
  type CodeverV3Command,
} from '@codever/protocol'
import {
  base64UrlDecode,
  exportDeviceKeyPair,
  generateDeviceKeyPair,
  openCodeverV3Envelope,
  openCodeverV3ProjectKeyGrant,
  sealCodeverV3Envelope,
  signCodeverV3Command,
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
import { V3MatrixGatewayRunner } from '@/gateway/matrix/v3Gateway'
import { gatewayProjectIdentity } from '@/gateway/matrix/project'
import { createTopicSessionRecord } from '@/bridge/topicSession'
import type { TopicSession } from '@/bridge/channelPort'
import { registerProvider } from '@/providers/registry'

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

describe('V3MatrixGatewayRunner', () => {
  it('starts without a recipient so the first device can pair', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codever-v3-empty-gateway-'))
    const gatewayKeys = await generateDeviceKeyPair()
    const client = new TestMatrixClient()
    const roomId = '!empty-project:example.org'
    const runner = new V3MatrixGatewayRunner({
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
      rooms: [{
        roomId,
        conversationId: 'unused-v3',
        cwd: '/repo',
        providerName: 'test',
      }],
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
    const rejected: unknown[] = []
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
    })
    const runner = new V3MatrixGatewayRunner(config, {
      client,
      onRejected: (_event, error) => rejected.push(error),
      sessionFactory: (room, port, session) => {
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
      state.eventType === CODEVER_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE
    )
    const grant = codeverV3ProjectKeyGrantStateSchema.parse(grantState?.content)
    const keyGrant = await openCodeverV3ProjectKeyGrant(grant.sealedGrant, {
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
        }),
      }),
    }))
    const workspacePointerState = [...client.state.values()].find(state =>
      state.eventType === CODEVER_MATRIX_WORKSPACE_POINTER_EVENT_TYPE
    )
    expect(codeverV3CurrentPointerSchema.parse(workspacePointerState?.content).document)
      .toMatchObject({
        kind: 'workspace.current',
        workspaceId: 'workspace-1',
        projectId,
        roomId,
      })

    const send = async (
      command: CodeverV3Command,
      matrixEventId: string,
      relation?: Record<string, unknown>,
      sender = '@phone:example.org',
    ) => {
      const signed = await signCodeverV3Command(command, phoneKeys.privateKey, phoneKeys.keyId)
      const envelope = await sealCodeverV3Envelope({
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
    const createA: CodeverV3Command = {
      ...base,
      commandId: 'create-a',
      sessionId: 'session-a',
      operation: 'session.create',
      payload: { operation: 'session.create', title: 'A' },
    }
    await send(createA, '$root-a-forged-sender', undefined, '@intruder:example.org')
    await waitFor(() => Promise.resolve(rejected.length === 1))
    expect(dispatched).toEqual([])
    await send(createA, '$root-a')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'create-a'))

    const promptA: CodeverV3Command = {
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
    await runner.stop()
  })
})

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
    const opened = await openCodeverV3Envelope(extension.envelope, {
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
