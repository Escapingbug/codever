import type { SessionEventEnvelope } from '@codever/protocol'

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
