import type { SessionEventEnvelope } from '@codever/protocol'
import { mergeSessionEvents } from '../sessionEvents'
import { readCached, writeCachedDurable } from '../state/localCache'

export interface DurableSessionEventStore {
  merge(event: SessionEventEnvelope): Promise<void>
}

/** Persists an event before its JetStream message is ACKed. */
export class IndexedDbSessionEventStore implements DurableSessionEventStore {
  private readonly writes = new Map<string, Promise<void>>()

  async merge(event: SessionEventEnvelope): Promise<void> {
    const previous = this.writes.get(event.sessionId) ?? Promise.resolve()
    const current = previous.then(async () => {
      const key = `session-events:${event.sessionId}`
      const cached = await readCached<SessionEventEnvelope[]>(key) ?? []
      await writeCachedDurable(key, mergeSessionEvents(cached, [event]))
    })
    this.writes.set(event.sessionId, current)
    try {
      await current
    } finally {
      if (this.writes.get(event.sessionId) === current) this.writes.delete(event.sessionId)
    }
  }
}
