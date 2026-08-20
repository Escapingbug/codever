import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { canonicalJson, jsonValueSchema } from '@codever/protocol'

export type V3MatrixEventDelivery = {
  kind: 'event'
  deliveryId: string
  roomId: string
  transactionId: string
  content: Record<string, unknown>
  createdAt: number
}

export type V3MatrixStateDelivery = {
  kind: 'state'
  deliveryId: string
  roomId: string
  eventType: string
  stateKey: string
  content: Record<string, unknown>
  createdAt: number
}

export type V3MatrixDelivery = V3MatrixEventDelivery | V3MatrixStateDelivery

type PendingEntry = { version: 3; status: 'pending'; delivery: V3MatrixDelivery }
type DeliveredEntry = {
  version: 3
  status: 'delivered'
  deliveryId: string
  eventId: string
  deliveredAt: number
}
type SupersededEntry = {
  version: 3
  status: 'superseded'
  deliveryId: string
  supersededAt: number
}
type OutboxEntry = PendingEntry | DeliveredEntry | SupersededEntry

/** One WAL for both timeline sends and the few directly-addressed state writes. */
export class FileV3MatrixOutbox {
  private readonly pendingEntries = new Map<string, V3MatrixDelivery>()
  private readonly deliveries = new Map<string, V3MatrixDelivery>()
  private readonly terminal = new Map<string, { eventId?: string }>()
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  initialize(): Promise<void> {
    return this.serial(async () => {
      let text: string
      try {
        text = await readFile(this.filePath, 'utf8')
      } catch (error) {
        if (isMissingFile(error)) return
        throw error
      }
      for (const [index, line] of text.split(/\r?\n/u).entries()) {
        if (!line.trim()) continue
        const entry = parseEntry(JSON.parse(line), index + 1)
        if (entry.status === 'pending') {
          this.deliveries.set(entry.delivery.deliveryId, entry.delivery)
          if (!this.terminal.has(entry.delivery.deliveryId)) {
            this.pendingEntries.set(entry.delivery.deliveryId, entry.delivery)
          }
        } else {
          this.pendingEntries.delete(entry.deliveryId)
          this.terminal.set(entry.deliveryId, {
            ...(entry.status === 'delivered' ? { eventId: entry.eventId } : {}),
          })
        }
      }
    })
  }

  createEvent(input: Omit<V3MatrixEventDelivery, 'kind' | 'deliveryId'>): V3MatrixEventDelivery {
    return {
      kind: 'event',
      ...structuredClone(input),
      // Matrix transaction IDs are the idempotency identity. Ciphertext,
      // nonce and signature are intentionally excluded so a retry always
      // reuses the first exact payload retained by this WAL.
      deliveryId: digest(['event', input.roomId, input.transactionId]),
    }
  }

  createState(input: Omit<V3MatrixStateDelivery, 'kind' | 'deliveryId'>): V3MatrixStateDelivery {
    return {
      kind: 'state',
      ...structuredClone(input),
      deliveryId: digest(['state', input.roomId, input.eventType, input.stateKey, input.content]),
    }
  }

  stage(delivery: V3MatrixDelivery): Promise<void> {
    return this.serial(async () => {
      if (this.pendingEntries.has(delivery.deliveryId) || this.terminal.has(delivery.deliveryId)) return
      if (delivery.kind === 'state') {
        const older = [...this.pendingEntries.values()].filter(candidate =>
          candidate.kind === 'state'
          && candidate.roomId === delivery.roomId
          && candidate.eventType === delivery.eventType
          && candidate.stateKey === delivery.stateKey,
        )
        for (const candidate of older) {
          await this.append({
            version: 3,
            status: 'superseded',
            deliveryId: candidate.deliveryId,
            supersededAt: delivery.createdAt,
          })
          this.pendingEntries.delete(candidate.deliveryId)
          this.terminal.set(candidate.deliveryId, {})
        }
      }
      await this.append({ version: 3, status: 'pending', delivery: structuredClone(delivery) })
      this.deliveries.set(delivery.deliveryId, structuredClone(delivery))
      this.pendingEntries.set(delivery.deliveryId, structuredClone(delivery))
    })
  }

  markDelivered(deliveryId: string, eventId: string, now = Date.now()): Promise<void> {
    return this.serial(async () => {
      if (this.terminal.has(deliveryId)) return
      if (!this.pendingEntries.has(deliveryId)) {
        throw new Error('Cannot complete an unstaged v3 Matrix delivery')
      }
      await this.append({
        version: 3,
        status: 'delivered',
        deliveryId,
        eventId,
        deliveredAt: now,
      })
      this.pendingEntries.delete(deliveryId)
      this.terminal.set(deliveryId, { eventId })
    })
  }

  deliveredEventId(deliveryId: string): string | undefined {
    return this.terminal.get(deliveryId)?.eventId
  }

  delivery(deliveryId: string): V3MatrixDelivery | undefined {
    const delivery = this.deliveries.get(deliveryId)
    return delivery ? structuredClone(delivery) : undefined
  }

  pending(roomId?: string): V3MatrixDelivery[] {
    return [...this.pendingEntries.values()]
      .filter(delivery => roomId === undefined || delivery.roomId === roomId)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(delivery => structuredClone(delivery))
  }

  latestState(
    roomId: string,
    eventType: string,
    stateKey: string,
  ): V3MatrixStateDelivery | undefined {
    const matching = [...this.deliveries.values()].filter(
      (delivery): delivery is V3MatrixStateDelivery =>
        delivery.kind === 'state'
        && delivery.roomId === roomId
        && delivery.eventType === eventType
        && delivery.stateKey === stateKey,
    )
    const latest = matching.sort((left, right) => right.createdAt - left.createdAt)[0]
    return latest ? structuredClone(latest) : undefined
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation)
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }

  private async append(entry: OutboxEntry): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const handle = await open(this.filePath, 'a', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(entry)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update('codever-matrix-outbox:v3\0')
    .update(canonicalJson(jsonValueSchema.parse(value)))
    .digest('hex')
}

function parseEntry(value: unknown, line: number): OutboxEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid v3 Matrix outbox entry at line ${line}`)
  }
  const entry = value as Record<string, unknown>
  if (entry.version !== 3) throw new Error(`Unsupported v3 Matrix outbox entry at line ${line}`)
  if (entry.status === 'pending') {
    const delivery = entry.delivery as V3MatrixDelivery | undefined
    if (
      !delivery
      || (delivery.kind !== 'event' && delivery.kind !== 'state')
      || typeof delivery.deliveryId !== 'string'
      || typeof delivery.roomId !== 'string'
      || typeof delivery.content !== 'object'
      || delivery.content === null
      || !Number.isSafeInteger(delivery.createdAt)
    ) {
      throw new Error(`Invalid pending v3 Matrix delivery at line ${line}`)
    }
    return entry as PendingEntry
  }
  if (
    (entry.status === 'delivered' || entry.status === 'superseded')
    && typeof entry.deliveryId === 'string'
  ) {
    return entry as DeliveredEntry | SupersededEntry
  }
  throw new Error(`Invalid terminal v3 Matrix delivery at line ${line}`)
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
