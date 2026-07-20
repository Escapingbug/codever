import type { SessionEventEnvelope } from '@codever/protocol'

export const MAX_CACHED_SESSION_EVENTS = 1_500

/**
 * A session sequence is the authoritative event order. Using it as the merge
 * key also protects the timeline from a replay that presents the same stored
 * event with a different event ID.
 */
export function mergeSessionEvents(...groups: SessionEventEnvelope[][]): SessionEventEnvelope[] {
  const merged = new Map<number, SessionEventEnvelope>()
  for (const event of groups.flat()) merged.set(event.seq, event)
  return [...merged.values()].sort((left, right) => left.seq - right.seq)
}

/** The Gateway journal remains authoritative; the client cache only keeps a recent tail. */
export function recentSessionEventCache(events: SessionEventEnvelope[]): SessionEventEnvelope[] {
  return events.length <= MAX_CACHED_SESSION_EVENTS ? events : events.slice(-MAX_CACHED_SESSION_EVENTS)
}
