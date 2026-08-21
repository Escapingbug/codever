import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Cvp3Event, WebPushSubscription } from '@codever/protocol'
import {
  FileGatewayWebPushService,
  type GatewayWebPushSender,
} from '@/gateway/matrix/webPush'

const subscription: WebPushSubscription = {
  endpoint: 'https://push.example.test/subscriptions/browser-1',
  keys: {
    p256dh: 'A'.repeat(88),
    auth: 'B'.repeat(22),
  },
}

describe('FileGatewayWebPushService', () => {
  it('persists VAPID keys, delivers once and survives restart without duplicate pushes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codever-web-push-'))
    const path = join(directory, 'web-push.json')
    const deliveries: string[] = []
    const sender: GatewayWebPushSender = {
      async sendNotification(_target, payload) {
        deliveries.push(payload)
      },
    }
    const first = new FileGatewayWebPushService(path, { sender })
    await first.initialize()
    const publicKey = first.publicKey()
    await first.upsertSubscription('device-1', subscription, 1)
    await first.notifyTerminal(terminalEvent('event-1'))
    await first.flush()
    first.stop()

    expect(deliveries).toHaveLength(1)
    expect(JSON.parse(deliveries[0]!)).toMatchObject({
      type: 'codever.turn-terminal',
      eventId: 'event-1',
      sessionId: 'session-1',
      status: 'succeeded',
    })
    expect((await stat(path)).mode & 0o777).toBe(0o600)

    const restarted = new FileGatewayWebPushService(path, { sender })
    await restarted.initialize()
    expect(restarted.publicKey()).toBe(publicKey)
    await restarted.notifyTerminal(terminalEvent('event-1'))
    await restarted.flush()
    restarted.stop()
    expect(deliveries).toHaveLength(1)
  })

  it('removes an expired endpoint after a 410 response', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codever-web-push-stale-'))
    const path = join(directory, 'web-push.json')
    let attempts = 0
    const sender: GatewayWebPushSender = {
      async sendNotification() {
        attempts += 1
        throw Object.assign(new Error('gone'), { statusCode: 410 })
      },
    }
    const service = new FileGatewayWebPushService(path, { sender })
    await service.initialize()
    await service.upsertSubscription('device-1', subscription, 1)
    await service.notifyTerminal(terminalEvent('event-stale-1'))
    await service.flush()
    await service.notifyTerminal(terminalEvent('event-stale-2'))
    await service.flush()
    service.stop()

    expect(attempts).toBe(1)
    const state = JSON.parse(await readFile(path, 'utf8')) as {
      subscriptions: Record<string, unknown>
      pending: Record<string, unknown>
    }
    expect(state.subscriptions).toEqual({})
    expect(state.pending).toEqual({})
  })

  it('rechecks project authorization before retrying a queued delivery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codever-web-push-revoked-'))
    let now = 0
    let authorized = true
    let attempts = 0
    const service = new FileGatewayWebPushService(join(directory, 'web-push.json'), {
      now: () => now,
      canDeliver: async () => authorized,
      sender: {
        async sendNotification() {
          attempts += 1
          throw new Error('temporary failure')
        },
      },
    })
    await service.initialize()
    await service.upsertSubscription('device-1', subscription, now)
    await service.notifyTerminal(terminalEvent('event-revoked'), ['device-1'])
    await service.flush()
    expect(attempts).toBe(1)

    authorized = false
    now = 30_000
    await service.flush()
    service.stop()
    expect(attempts).toBe(1)
  })
})

function terminalEvent(eventId: string): Cvp3Event {
  return {
    kind: 'codever.event',
    version: 3,
    eventId,
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    occurredAt: 2,
    payload: {
      type: 'turn.completed',
      turnId: 'turn-1',
      outcome: 'succeeded',
      projection: {
        title: 'Secret session title is not pushed',
        lifecycle: 'active',
        activity: 'idle',
        updatedAt: 2,
        stateVersion: 1,
      },
    },
  }
}
