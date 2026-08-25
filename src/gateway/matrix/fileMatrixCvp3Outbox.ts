import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { canonicalJson, jsonValueSchema } from '@codever/protocol'

export type MatrixCvp3EventDelivery = {
  kind: 'event'
  deliveryId: string
  roomId: string
  transactionId: string
  content: Record<string, unknown>
  createdAt: number
  priority?: MatrixCvp3DeliveryPriority
  supersession?: MatrixCvp3Supersession
}

export type MatrixCvp3StateDelivery = {
  kind: 'state'
  deliveryId: string
  roomId: string
  eventType: string
  stateKey: string
  content: Record<string, unknown>
  createdAt: number
}

export type MatrixCvp3Delivery = MatrixCvp3EventDelivery | MatrixCvp3StateDelivery

export type MatrixCvp3DeliveryPriority = 'urgent' | 'control' | 'normal' | 'bulk'

export interface MatrixCvp3Supersession {
  key: string
  version: number
}

export interface MatrixCvp3DeliveryMetadata {
  priority?: MatrixCvp3DeliveryPriority
  supersession?: MatrixCvp3Supersession
}

type PendingEntry = { version: 3; status: 'pending'; delivery: MatrixCvp3Delivery }
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
  reason?: string
}
type ClassifiedEntry = {
  version: 3
  status: 'classified'
  deliveryId: string
  metadata: MatrixCvp3DeliveryMetadata
  classifiedAt: number
}
type OutboxEntry = PendingEntry | DeliveredEntry | SupersededEntry | ClassifiedEntry

/** One WAL for both timeline sends and the few directly-addressed state writes. */
export class FileMatrixCvp3Outbox {
  private readonly pendingEntries = new Map<string, MatrixCvp3Delivery>()
  private readonly deliveries = new Map<string, MatrixCvp3Delivery>()
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
        } else if (entry.status === 'classified') {
          const delivery = this.deliveries.get(entry.deliveryId)
          if (!delivery || delivery.kind !== 'event') continue
          const classified = withMetadata(delivery, entry.metadata)
          this.deliveries.set(entry.deliveryId, classified)
          if (this.pendingEntries.has(entry.deliveryId)) {
            this.pendingEntries.set(entry.deliveryId, classified)
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

  createEvent(input: Omit<MatrixCvp3EventDelivery, 'kind' | 'deliveryId'>): MatrixCvp3EventDelivery {
    return {
      kind: 'event',
      ...structuredClone(input),
      // Matrix transaction IDs are the idempotency identity. Ciphertext,
      // nonce and signature are intentionally excluded so a retry always
      // reuses the first exact payload retained by this WAL.
      deliveryId: digest(['event', input.roomId, input.transactionId]),
    }
  }

  createState(input: Omit<MatrixCvp3StateDelivery, 'kind' | 'deliveryId'>): MatrixCvp3StateDelivery {
    return {
      kind: 'state',
      ...structuredClone(input),
      deliveryId: digest(['state', input.roomId, input.eventType, input.stateKey, input.content]),
    }
  }

  stage(delivery: MatrixCvp3Delivery): Promise<string[]> {
    return this.serial(async () => {
      if (this.pendingEntries.has(delivery.deliveryId) || this.terminal.has(delivery.deliveryId)) {
        return []
      }
      const superseded: string[] = []
      let obsoleteOnArrival = false
      if (delivery.kind === 'state') {
        const older = [...this.pendingEntries.values()].filter(candidate =>
          candidate.kind === 'state'
          && candidate.roomId === delivery.roomId
          && candidate.eventType === delivery.eventType
          && candidate.stateKey === delivery.stateKey,
        )
        for (const candidate of older) {
          await this.supersede(candidate.deliveryId, delivery.createdAt, 'newer_state')
          superseded.push(candidate.deliveryId)
        }
      } else if (delivery.supersession) {
        const supersession = delivery.supersession
        obsoleteOnArrival = [...this.pendingEntries.values()].some(candidate =>
          candidate.kind === 'event'
          && candidate.roomId === delivery.roomId
          && candidate.supersession?.key === supersession.key
          && candidate.supersession.version > supersession.version
        )
        const older = [...this.pendingEntries.values()].filter(
          (candidate): candidate is MatrixCvp3EventDelivery =>
            candidate.kind === 'event'
            && candidate.roomId === delivery.roomId
            && candidate.supersession?.key === supersession.key
            && candidate.supersession.version < supersession.version,
        )
        for (const candidate of older) {
          await this.supersede(
            candidate.deliveryId,
            delivery.createdAt,
            `newer_logical_version:${supersession.key}`,
          )
          superseded.push(candidate.deliveryId)
        }
      }
      await this.append({ version: 3, status: 'pending', delivery: structuredClone(delivery) })
      this.deliveries.set(delivery.deliveryId, structuredClone(delivery))
      this.pendingEntries.set(delivery.deliveryId, structuredClone(delivery))
      if (obsoleteOnArrival) {
        await this.supersede(
          delivery.deliveryId,
          delivery.createdAt,
          `obsolete_logical_version:${delivery.supersession!.key}`,
        )
        superseded.push(delivery.deliveryId)
      }
      return superseded
    })
  }

  classifyMany(
    classifications: readonly {
      deliveryId: string
      metadata: MatrixCvp3DeliveryMetadata
    }[],
    now = Date.now(),
  ): Promise<string[]> {
    return this.serial(async () => {
      const entries: OutboxEntry[] = []
      for (const classification of classifications) {
        const delivery = this.pendingEntries.get(classification.deliveryId)
        if (!delivery || delivery.kind !== 'event') continue
        const classified = withMetadata(delivery, classification.metadata)
        if (sameMetadata(delivery, classified)) continue
        entries.push({
          version: 3,
          status: 'classified',
          deliveryId: delivery.deliveryId,
          metadata: metadataFor(classified),
          classifiedAt: now,
        })
        this.deliveries.set(delivery.deliveryId, classified)
        this.pendingEntries.set(delivery.deliveryId, classified)
      }

      const newestVersions = new Map<string, number>()
      for (const delivery of this.pendingEntries.values()) {
        if (delivery.kind !== 'event' || !delivery.supersession) continue
        const current = newestVersions.get(delivery.supersession.key) ?? -1
        newestVersions.set(
          delivery.supersession.key,
          Math.max(current, delivery.supersession.version),
        )
      }
      const superseded: string[] = []
      for (const delivery of this.pendingEntries.values()) {
        if (delivery.kind !== 'event' || !delivery.supersession) continue
        const newest = newestVersions.get(delivery.supersession.key)
        if (newest === undefined || delivery.supersession.version >= newest) continue
        entries.push({
          version: 3,
          status: 'superseded',
          deliveryId: delivery.deliveryId,
          supersededAt: now,
          reason: `newer_logical_version:${delivery.supersession.key}`.slice(0, 512),
        })
        superseded.push(delivery.deliveryId)
      }
      await this.appendMany(entries)
      for (const deliveryId of superseded) {
        this.pendingEntries.delete(deliveryId)
        this.terminal.set(deliveryId, {})
      }
      return superseded
    })
  }

  markDelivered(deliveryId: string, eventId: string, now = Date.now()): Promise<void> {
    return this.serial(async () => {
      if (this.terminal.has(deliveryId)) return
      if (!this.pendingEntries.has(deliveryId)) {
        throw new Error('Cannot complete an unstaged CVP/3 Matrix delivery')
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

  markSuperseded(
    deliveryId: string,
    reason: string,
    now = Date.now(),
  ): Promise<void> {
    return this.serial(async () => {
      if (this.terminal.has(deliveryId)) return
      if (!this.pendingEntries.has(deliveryId)) {
        throw new Error('Cannot supersede an unstaged CVP/3 Matrix delivery')
      }
      await this.append({
        version: 3,
        status: 'superseded',
        deliveryId,
        supersededAt: now,
        reason: reason.slice(0, 512),
      })
      this.pendingEntries.delete(deliveryId)
      this.terminal.set(deliveryId, {})
    })
  }

  deliveredEventId(deliveryId: string): string | undefined {
    return this.terminal.get(deliveryId)?.eventId
  }

  isPending(deliveryId: string): boolean {
    return this.pendingEntries.has(deliveryId)
  }

  delivery(deliveryId: string): MatrixCvp3Delivery | undefined {
    const delivery = this.deliveries.get(deliveryId)
    return delivery ? structuredClone(delivery) : undefined
  }

  pending(roomId?: string): MatrixCvp3Delivery[] {
    return [...this.pendingEntries.values()]
      .filter(delivery => roomId === undefined || delivery.roomId === roomId)
      .sort((left, right) =>
        deliveryPriority(left) - deliveryPriority(right)
        || left.createdAt - right.createdAt
      )
      .map(delivery => structuredClone(delivery))
  }

  latestState(
    roomId: string,
    eventType: string,
    stateKey: string,
  ): MatrixCvp3StateDelivery | undefined {
    const matching = [...this.deliveries.values()].filter(
      (delivery): delivery is MatrixCvp3StateDelivery =>
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
    await this.appendMany([entry])
  }

  private async appendMany(entries: readonly OutboxEntry[]): Promise<void> {
    if (entries.length === 0) return
    await mkdir(dirname(this.filePath), { recursive: true })
    const handle = await open(this.filePath, 'a', 0o600)
    try {
      await handle.writeFile(`${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  private async supersede(
    deliveryId: string,
    supersededAt: number,
    reason?: string,
  ): Promise<void> {
    await this.append({
      version: 3,
      status: 'superseded',
      deliveryId,
      supersededAt,
      ...(reason ? { reason: reason.slice(0, 512) } : {}),
    })
    this.pendingEntries.delete(deliveryId)
    this.terminal.set(deliveryId, {})
  }
}

function deliveryPriority(delivery: MatrixCvp3Delivery): number {
  if (delivery.kind === 'state' || delivery.priority === 'urgent') return 0
  if (delivery.priority === 'control') return 1
  if (delivery.priority === 'bulk') return 3
  return 2
}

function withMetadata(
  delivery: MatrixCvp3EventDelivery,
  metadata: MatrixCvp3DeliveryMetadata,
): MatrixCvp3EventDelivery {
  return {
    ...structuredClone(delivery),
    ...(metadata.priority ? { priority: metadata.priority } : {}),
    ...(metadata.supersession
      ? { supersession: structuredClone(metadata.supersession) }
      : {}),
  }
}

function metadataFor(delivery: MatrixCvp3EventDelivery): MatrixCvp3DeliveryMetadata {
  return {
    ...(delivery.priority ? { priority: delivery.priority } : {}),
    ...(delivery.supersession
      ? { supersession: structuredClone(delivery.supersession) }
      : {}),
  }
}

function sameMetadata(
  left: MatrixCvp3EventDelivery,
  right: MatrixCvp3EventDelivery,
): boolean {
  return left.priority === right.priority
    && left.supersession?.key === right.supersession?.key
    && left.supersession?.version === right.supersession?.version
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update('codever-matrix-outbox:v3\0')
    .update(canonicalJson(jsonValueSchema.parse(value)))
    .digest('hex')
}

function parseEntry(value: unknown, line: number): OutboxEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid CVP/3 Matrix outbox entry at line ${line}`)
  }
  const entry = value as Record<string, unknown>
  if (entry.version !== 3) throw new Error(`Unsupported CVP/3 Matrix outbox entry at line ${line}`)
  if (entry.status === 'pending') {
    const delivery = entry.delivery as MatrixCvp3Delivery | undefined
    if (
      !delivery
      || (delivery.kind !== 'event' && delivery.kind !== 'state')
      || typeof delivery.deliveryId !== 'string'
      || typeof delivery.roomId !== 'string'
      || typeof delivery.content !== 'object'
      || delivery.content === null
      || !Number.isSafeInteger(delivery.createdAt)
      || (delivery.kind === 'event'
        && delivery.priority !== undefined
        && !isDeliveryPriority(delivery.priority))
      || (delivery.kind === 'event'
        && delivery.supersession !== undefined
        && !isSupersession(delivery.supersession))
    ) {
      throw new Error(`Invalid pending CVP/3 Matrix delivery at line ${line}`)
    }
    return entry as PendingEntry
  }
  if (
    entry.status === 'classified'
    && typeof entry.deliveryId === 'string'
    && Number.isSafeInteger(entry.classifiedAt)
    && isMetadata(entry.metadata)
  ) {
    return entry as ClassifiedEntry
  }
  if (
    (entry.status === 'delivered' || entry.status === 'superseded')
    && typeof entry.deliveryId === 'string'
  ) {
    if (
      entry.status === 'superseded'
      && entry.reason !== undefined
      && typeof entry.reason !== 'string'
    ) {
      throw new Error(`Invalid superseded CVP/3 Matrix delivery at line ${line}`)
    }
    return entry as DeliveredEntry | SupersededEntry
  }
  throw new Error(`Invalid terminal CVP/3 Matrix delivery at line ${line}`)
}

function isMetadata(value: unknown): value is MatrixCvp3DeliveryMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const metadata = value as Record<string, unknown>
  return (metadata.priority === undefined || isDeliveryPriority(metadata.priority))
    && (metadata.supersession === undefined || isSupersession(metadata.supersession))
}

function isDeliveryPriority(value: unknown): value is MatrixCvp3DeliveryPriority {
  return value === 'urgent' || value === 'control' || value === 'normal' || value === 'bulk'
}

function isSupersession(value: unknown): value is MatrixCvp3Supersession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const supersession = value as Record<string, unknown>
  return typeof supersession.key === 'string'
    && supersession.key.length > 0
    && Number.isSafeInteger(supersession.version)
    && (supersession.version as number) >= 0
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
