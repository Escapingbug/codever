import { createHash } from 'node:crypto'
import { AtomicJsonFile } from '@codever/security/node'
import {
  webPushSubscriptionSchema,
  type Cvp3Event,
  type WebPushSubscription,
} from '@codever/protocol'
import webPush from 'web-push'
import { z } from 'zod'

const RETRY_INTERVAL_MS = 30_000
const MAX_RETRY_DELAY_MS = 60 * 60_000
const MAX_COMPLETED_EVENT_IDS = 512
const DEFAULT_VAPID_SUBJECT = 'mailto:notifications@codever.dev'

const storedSubscriptionSchema = webPushSubscriptionSchema.safeExtend({
  updatedAt: z.number().int().nonnegative(),
})

const pushPayloadSchema = z.object({
  version: z.literal(1),
  type: z.literal('codever.turn-terminal'),
  eventId: z.string().min(1).max(256),
  workspaceId: z.string().min(1).max(256),
  projectId: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
  status: z.enum(['succeeded', 'cancelled', 'failed']),
}).strict()

export type CodeverWebPushPayload = z.infer<typeof pushPayloadSchema>

const stateSchema = z.object({
  version: z.literal(1),
  vapid: z.object({
    subject: z.string().min(1).max(2_048),
    publicKey: z.string().length(87),
    privateKey: z.string().min(32).max(128),
  }).strict(),
  subscriptions: z.record(z.string(), storedSubscriptionSchema),
  pending: z.record(z.string(), z.object({
    payload: pushPayloadSchema,
    targets: z.array(z.object({
      deviceId: z.string().min(1).max(256),
      endpoint: z.string().min(1).max(4_096),
    }).strict()).max(1_024),
    attempts: z.number().int().nonnegative(),
    nextAttemptAt: z.number().int().nonnegative(),
  }).strict()),
  completedEventIds: z.array(z.string().min(1).max(256)).max(MAX_COMPLETED_EVENT_IDS),
}).strict()

type WebPushState = z.infer<typeof stateSchema>

export interface GatewayWebPushSender {
  sendNotification(
    subscription: WebPushSubscription,
    payload: string,
    options: {
      vapidDetails: { subject: string; publicKey: string; privateKey: string }
      TTL: number
      urgency: 'high'
      topic: string
      timeout: number
    },
  ): Promise<unknown>
}

export interface GatewayWebPushService {
  initialize(): Promise<void>
  publicKey(): string
  upsertSubscription(
    deviceId: string,
    subscription: WebPushSubscription,
    now?: number,
  ): Promise<void>
  removeSubscription(deviceId: string, endpoint?: string): Promise<void>
  notifyTerminal(event: Cvp3Event, eligibleDeviceIds?: readonly string[]): Promise<void>
  flush(): Promise<void>
  stop(): void
}

export interface FileGatewayWebPushServiceOptions {
  subject?: string
  now?: () => number
  sender?: GatewayWebPushSender
  onLog?: (message: string) => void
  canDeliver?: (deviceId: string, projectId: string) => Promise<boolean>
}

/** Durable, per-device Web Push subscriptions and a retrying notification outbox. */
export class FileGatewayWebPushService implements GatewayWebPushService {
  private readonly store: AtomicJsonFile<WebPushState>
  private readonly subject: string
  private readonly sender: GatewayWebPushSender
  private readonly now: () => number
  private readonly onLog?: (message: string) => void
  private readonly canDeliver?: (deviceId: string, projectId: string) => Promise<boolean>
  private initializedState: WebPushState | null = null
  private flushTail: Promise<void> = Promise.resolve()
  private retryTimer: ReturnType<typeof setInterval> | null = null

  constructor(path: string, options: FileGatewayWebPushServiceOptions = {}) {
    this.store = new AtomicJsonFile<WebPushState>(path)
    this.subject = options.subject ?? DEFAULT_VAPID_SUBJECT
    this.sender = options.sender ?? webPush
    this.now = options.now ?? Date.now
    this.onLog = options.onLog
    this.canDeliver = options.canDeliver
  }

  async initialize(): Promise<void> {
    if (this.initializedState) return
    const state = await this.store.transaction(
      () => this.createState(),
      current => ({ result: stateSchema.parse(current), changed: true }),
    )
    this.initializedState = state
    this.retryTimer = setInterval(() => void this.flush(), RETRY_INTERVAL_MS)
    this.retryTimer.unref?.()
    void this.flush()
  }

  publicKey(): string {
    if (!this.initializedState) throw new Error('Web Push service is not initialized')
    return this.initializedState.vapid.publicKey
  }

  async upsertSubscription(
    deviceId: string,
    input: WebPushSubscription,
    now = this.now(),
  ): Promise<void> {
    const subscription = webPushSubscriptionSchema.parse(input)
    await this.mutate(state => {
      state.subscriptions[deviceId] = { ...subscription, updatedAt: now }
    })
  }

  async removeSubscription(deviceId: string, endpoint?: string): Promise<void> {
    await this.mutate(state => {
      const current = state.subscriptions[deviceId]
      if (current && (!endpoint || current.endpoint === endpoint)) {
        delete state.subscriptions[deviceId]
      }
    })
  }

  async notifyTerminal(
    event: Cvp3Event,
    eligibleDeviceIds?: readonly string[],
  ): Promise<void> {
    const payload = terminalPayload(event)
    if (!payload) return
    const eligible = eligibleDeviceIds ? new Set(eligibleDeviceIds) : null
    await this.mutate(state => {
      if (state.completedEventIds.includes(event.eventId) || state.pending[event.eventId]) return
      const targets = Object.entries(state.subscriptions)
        .filter(([deviceId]) => !eligible || eligible.has(deviceId))
        .map(([deviceId, subscription]) => ({
          deviceId,
          endpoint: subscription.endpoint,
        }))
      if (targets.length === 0) {
        rememberCompleted(state, event.eventId)
        return
      }
      state.pending[event.eventId] = {
        payload,
        targets,
        attempts: 0,
        nextAttemptAt: this.now(),
      }
    })
    void this.flush()
  }

  flush(): Promise<void> {
    const task = this.flushTail.then(() => this.flushDue())
    this.flushTail = task.catch(error => {
      this.log(`Web Push flush failed: ${formatError(error)}`)
    })
    return task
  }

  stop(): void {
    if (this.retryTimer) clearInterval(this.retryTimer)
    this.retryTimer = null
  }

  private async flushDue(): Promise<void> {
    if (!this.initializedState) return
    const snapshot = await this.read()
    const due = Object.values(snapshot.pending).filter(item => item.nextAttemptAt <= this.now())
    for (const item of due) {
      for (const target of item.targets) {
        const current = await this.read()
        const pending = current.pending[item.payload.eventId]
        if (!pending?.targets.some(candidate => sameTarget(candidate, target))) continue
        const subscription = current.subscriptions[target.deviceId]
        if (!subscription || subscription.endpoint !== target.endpoint) {
          await this.finishTarget(item.payload.eventId, target)
          continue
        }
        if (
          this.canDeliver
          && !await this.canDeliver(target.deviceId, item.payload.projectId)
        ) {
          await this.finishTarget(item.payload.eventId, target)
          continue
        }
        try {
          await this.sender.sendNotification(
            subscription,
            JSON.stringify(item.payload),
            {
              vapidDetails: current.vapid,
              TTL: 24 * 60 * 60,
              urgency: 'high',
              topic: pushTopic(item.payload.eventId),
              timeout: 10_000,
            },
          )
          await this.finishTarget(item.payload.eventId, target)
        } catch (error) {
          const statusCode = responseStatus(error)
          if (statusCode === 404 || statusCode === 410) {
            await this.mutate(state => {
              const active = state.subscriptions[target.deviceId]
              if (active?.endpoint === target.endpoint) delete state.subscriptions[target.deviceId]
              removeTarget(state, item.payload.eventId, target)
            })
            continue
          }
          await this.defer(item.payload.eventId)
          this.log(
            `Web Push delivery ${item.payload.eventId} to ${target.deviceId} failed: `
            + formatError(error),
          )
          break
        }
      }
    }
  }

  private async finishTarget(eventId: string, target: { deviceId: string; endpoint: string }) {
    await this.mutate(state => removeTarget(state, eventId, target))
  }

  private async defer(eventId: string): Promise<void> {
    await this.mutate(state => {
      const item = state.pending[eventId]
      if (!item) return
      item.attempts += 1
      item.nextAttemptAt = this.now() + Math.min(
        MAX_RETRY_DELAY_MS,
        RETRY_INTERVAL_MS * 2 ** Math.min(item.attempts - 1, 7),
      )
    })
  }

  private async read(): Promise<WebPushState> {
    return await this.store.transaction(
      () => this.createState(),
      state => ({ result: stateSchema.parse(state), changed: false }),
    )
  }

  private async mutate(operation: (state: WebPushState) => void): Promise<void> {
    const state = await this.store.transaction(
      () => this.createState(),
      current => {
        const parsed = stateSchema.parse(current)
        operation(parsed)
        Object.assign(current, parsed)
        return { result: parsed, changed: true }
      },
    )
    this.initializedState = state
  }

  private createState(): WebPushState {
    const keys = webPush.generateVAPIDKeys()
    return {
      version: 1,
      vapid: {
        subject: this.subject,
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
      },
      subscriptions: {},
      pending: {},
      completedEventIds: [],
    }
  }

  private log(message: string): void {
    this.onLog?.(`[cvp3/web-push] ${message}`)
  }
}

function terminalPayload(event: Cvp3Event): CodeverWebPushPayload | null {
  if (!event.projectId || !event.sessionId) return null
  if (event.payload.type === 'turn.completed') {
    return pushPayloadSchema.parse({
      version: 1,
      type: 'codever.turn-terminal',
      eventId: event.eventId,
      workspaceId: event.workspaceId,
      projectId: event.projectId,
      sessionId: event.sessionId,
      status: event.payload.outcome,
    })
  }
  if (event.payload.type === 'turn.failed') {
    return pushPayloadSchema.parse({
      version: 1,
      type: 'codever.turn-terminal',
      eventId: event.eventId,
      workspaceId: event.workspaceId,
      projectId: event.projectId,
      sessionId: event.sessionId,
      status: 'failed',
    })
  }
  return null
}

function removeTarget(
  state: WebPushState,
  eventId: string,
  target: { deviceId: string; endpoint: string },
): void {
  const item = state.pending[eventId]
  if (!item) return
  item.targets = item.targets.filter(candidate => !sameTarget(candidate, target))
  if (item.targets.length > 0) return
  delete state.pending[eventId]
  rememberCompleted(state, eventId)
}

function rememberCompleted(state: WebPushState, eventId: string): void {
  state.completedEventIds = [
    ...state.completedEventIds.filter(candidate => candidate !== eventId),
    eventId,
  ].slice(-MAX_COMPLETED_EVENT_IDS)
}

function sameTarget(
  left: { deviceId: string; endpoint: string },
  right: { deviceId: string; endpoint: string },
): boolean {
  return left.deviceId === right.deviceId && left.endpoint === right.endpoint
}

function pushTopic(eventId: string): string {
  return createHash('sha256').update(eventId).digest('base64url').slice(0, 32)
}

function responseStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'statusCode' in error
    && typeof error.statusCode === 'number'
    ? error.statusCode
    : undefined
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
