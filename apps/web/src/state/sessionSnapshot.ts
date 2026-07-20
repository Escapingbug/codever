import type { CodeverSession } from '@codever/protocol'

/**
 * Merge an Inventory/cache snapshot without allowing an older observation to
 * roll the visible execution state backwards.
 */
export function mergeSessionSnapshot(
  current: CodeverSession | undefined,
  incoming: CodeverSession,
): CodeverSession {
  if (!current) return incoming
  const currentSequence = current.lastEventSeq ?? 0
  const incomingSequence = incoming.lastEventSeq ?? 0
  const incomingIsNewer = incomingSequence > currentSequence
    || (incomingSequence === currentSequence && timestamp(incoming.updatedAt) >= timestamp(current.updatedAt))

  return {
    ...current,
    ...incoming,
    state: incomingIsNewer ? incoming.state : current.state,
    lastEventSeq: Math.max(currentSequence, incomingSequence),
    updatedAt: timestamp(incoming.updatedAt) >= timestamp(current.updatedAt) ? incoming.updatedAt : current.updatedAt,
  }
}

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}
