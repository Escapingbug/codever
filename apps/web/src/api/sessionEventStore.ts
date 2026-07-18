import type { SessionEventEnvelope } from '@codever/protocol'
import { mergeSessionEvents } from '../sessionEvents'
import { readCached, writeCachedDurable } from '../state/localCache'

export interface DurableSessionEventStore {
  merge(event: SessionEventEnvelope): Promise<void>
  mergeMany?(events: SessionEventEnvelope[]): Promise<void>
}

/** Persists an event before its JetStream message is ACKed. */
export class IndexedDbSessionEventStore implements DurableSessionEventStore {
  private readonly writes = new Map<string, Promise<void>>()
  private pending: Array<{
    event: SessionEventEnvelope
    resolve: () => void
    reject: (error: unknown) => void
  }> = []
  private flushTimer?: ReturnType<typeof setTimeout>

  constructor(private readonly options: {
    read?: typeof readCached
    write?: typeof writeCachedDurable
    maxEventsPerSession?: number
    batchDelayMs?: number
  } = {}) {}

  merge(event: SessionEventEnvelope): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ event, resolve, reject })
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => { void this.flushPending() }, this.options.batchDelayMs ?? 5)
      }
    })
  }

  async mergeMany(events: SessionEventEnvelope[]): Promise<void> {
    const grouped = new Map<string, SessionEventEnvelope[]>()
    for (const event of events) {
      const values = grouped.get(event.sessionId) ?? []
      values.push(event)
      grouped.set(event.sessionId, values)
    }
    await Promise.all([...grouped.values()].map(values => this.persist(values)))
  }

  private async persist(events: SessionEventEnvelope[]): Promise<void> {
    if (!events.length) return
    const sessionId = events[0]!.sessionId
    const previous = this.writes.get(sessionId) ?? Promise.resolve()
    const current = previous.then(async () => {
      const key = `session-events:${sessionId}`
      const read = this.options.read ?? readCached
      const write = this.options.write ?? writeCachedDurable
      const cached = await read<SessionEventEnvelope[]>(key) ?? []
      const maxEvents = this.options.maxEventsPerSession ?? 2_000
      await write(key, mergeSessionEvents(cached, events).slice(-maxEvents))
    })
    this.writes.set(sessionId, current)
    try {
      await current
    } finally {
      if (this.writes.get(sessionId) === current) this.writes.delete(sessionId)
    }
  }

  private async flushPending(): Promise<void> {
    this.flushTimer = undefined
    const pending = this.pending
    this.pending = []
    if (!pending.length) return
    try {
      await this.mergeMany(pending.map(value => value.event))
      for (const value of pending) value.resolve()
    } catch (error) {
      for (const value of pending) value.reject(error)
    }
  }
}
